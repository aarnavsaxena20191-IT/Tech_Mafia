const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { models, transaction } = require('../db');
const { AppError } = require('../errors');

const TEAM_SIZE = 6;

function validateRoster(name, members) {
  if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 80) {
    throw new AppError(400, 'Team name must be between 3 and 80 characters.');
  }
  if (!Array.isArray(members) || members.length !== TEAM_SIZE) {
    throw new AppError(400, 'Add exactly six participants to register a team.');
  }
  const normalized = members.map((member) => ({
    name: typeof member.name === 'string' ? member.name.trim() : '',
    email: typeof member.email === 'string' ? member.email.trim().toLowerCase() : '',
    password: typeof member.password === 'string' ? member.password : '',
  }));
  const emails = normalized.map((member) => member.email);
  if (normalized.some((member) => member.name.length < 2 || member.name.length > 80)) {
    throw new AppError(400, 'Each participant name must be between 2 and 80 characters.');
  }
  if (normalized.some((member) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email) || member.email.length > 254)) {
    throw new AppError(400, 'Enter a valid email address for each participant.');
  }
  if (new Set(emails).size !== TEAM_SIZE) throw new AppError(400, 'Each participant must use a different email address.');
  if (normalized.some((member) => member.password.length < 12 || member.password.length > 200)) {
    throw new AppError(400, 'Each participant password must be at least 12 characters.');
  }
  return { name: name.trim(), members: normalized };
}

async function registerTeam({ tournamentId, name, groupName, members, allowClosed = false }) {
  const roster = validateRoster(name, members);
  return transaction(async (session) => {
    let tournament = tournamentId
      ? await models.Tournament.findById(tournamentId).session(session)
      : await models.Tournament.findOne({ status: { $in: ['setup', 'active'] } }).sort({ createdAt: 1 }).session(session);
    if (!tournament) throw new AppError(404, 'Team registration is not available because no tournament is open.');
    if (!allowClosed && (tournament.status !== 'active' || tournament.config?.registrationOpen === false)) {
      throw new AppError(409, 'Team registration is currently closed.');
    }

    // Touch one tournament document in every registration transaction. MongoDB retries write conflicts,
    // keeping pair assignment deterministic when two teams register at the same time.
    tournament = await models.Tournament.findByIdAndUpdate(
      tournament._id,
      { $inc: { registration_sequence: 1 } },
      { returnDocument: 'after', session },
    );
    const code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const users = [];
    for (const member of roster.members) {
      const password_hash = await bcrypt.hash(member.password, 12);
      const [user] = await models.User.create([{
        email: member.email,
        password_hash,
        display_name: member.name,
        role: 'participant',
        is_active: true,
      }], { session });
      users.push(user);
    }

    const [team] = await models.Team.create([{
      tournament_id: tournament._id,
      name: roster.name,
      code,
      group_name: groupName || null,
      status: 'active',
      members: users.map((user, index) => ({ user_id: user._id, member_number: index + 1 })),
    }], { session });

    const allTeams = await models.Team.find({ tournament_id: tournament._id }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
    const existingMatches = await models.Match.find({ tournament_id: tournament._id }).select('participants.team_id match_number').session(session).lean();
    const pairedIds = new Set(existingMatches.flatMap((match) => match.participants.map((participant) => participant.team_id)));
    const waitingTeams = allTeams.filter((candidate) => !pairedIds.has(candidate._id));
    let pairing = null;

    if (waitingTeams.length >= 2) {
      const [first, second] = waitingTeams;
      let round = await models.Round.findOne({ tournament_id: tournament._id, round_number: 1 }).session(session);
      if (!round) {
        [round] = await models.Round.create([{
          tournament_id: tournament._id,
          name: 'Qualifiers',
          round_number: 1,
          kind: 'bracket',
          status: 'active',
        }], { session });
      }
      const matchNumber = existingMatches.reduce((max, match) => Math.max(max, match.match_number || 0), 0) + 1;
      const flip = matchNumber % 2 === 0;
      const problem = await models.Problem.findOne({ is_active: true }).sort({ createdAt: 1 }).select('_id').session(session).lean();
      const [match] = await models.Match.create([{
        tournament_id: tournament._id,
        round_id: round._id,
        problem_id: problem?._id || null,
        match_number: matchNumber,
        duration_seconds: Number(tournament.config?.matchDurationSeconds || process.env.MATCH_DURATION_SECONDS || 900),
        state: 'READY',
        participants: [
          { team_id: first._id, role: flip ? 'DETECTIVE' : 'CODER' },
          { team_id: second._id, role: flip ? 'CODER' : 'DETECTIVE' },
        ],
      }], { session });
      const teamDocuments = [first, second];
      const initialProgress = teamDocuments.flatMap((pairedTeam) => {
        const role = match.participants.find((participant) => participant.team_id === pairedTeam._id).role;
        return pairedTeam.members.map((member) => ({
          tournament_id: tournament._id,
          match_id: match._id,
          team_id: pairedTeam._id,
          user_id: member.user_id,
          role,
          events: [{ type: 'match_assigned', detail: { role } }],
        }));
      });
      await models.ParticipantProgress.insertMany(initialProgress, { session });
      pairing = {
        matchId: match._id,
        matchNumber,
        opponent: first._id === team._id ? second.name : first.name,
        role: match.participants.find((participant) => participant.team_id === team._id).role,
      };
    }

    return { tournament, team, users, pairing };
  });
}

module.exports = { registerTeam, validateRoster };
