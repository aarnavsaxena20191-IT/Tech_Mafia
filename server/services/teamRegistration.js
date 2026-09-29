const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { models, transaction } = require('../db');
const { AppError } = require('../errors');

const MIN_TEAM_SIZE = 3;
const MAX_TEAM_SIZE = 5;

function validateRoster(name, members, { captainOnly = false } = {}) {
  if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 80) {
    throw new AppError(400, 'Team name must be between 3 and 80 characters.');
  }
  if (!Array.isArray(members) || members.length < MIN_TEAM_SIZE || members.length > MAX_TEAM_SIZE) {
    throw new AppError(400, `Add between ${MIN_TEAM_SIZE} and ${MAX_TEAM_SIZE} participants to register a team.`);
  }
  const normalized = members.map((member) => ({
    name: typeof member.name === 'string' ? member.name.trim() : '',
    email: typeof member.email === 'string' ? member.email.trim().toLowerCase() : '',
    password: typeof member.password === 'string' ? member.password : '',
  }));
  if (normalized.some((member) => member.name.length < 2 || member.name.length > 80)) {
    throw new AppError(400, 'Each participant name must be between 2 and 80 characters.');
  }
  if (normalized.some((member) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email) || member.email.length > 254)) {
    throw new AppError(400, 'Enter a valid email address for each participant.');
  }
  if (new Set(normalized.map((member) => member.email)).size !== normalized.length) {
    throw new AppError(400, 'Each participant must use a different email address.');
  }
  const passwordInvalid = captainOnly
    ? normalized[0].password.length < 12 || normalized[0].password.length > 200
    : normalized.some((member) => member.password.length < 12 || member.password.length > 200);
  if (passwordInvalid) throw new AppError(400, captainOnly ? 'The captain password must be at least 12 characters.' : 'Each participant password must be at least 12 characters.');
  return { name: name.trim(), members: normalized };
}

async function createUniqueTeamCode(tournamentId, session) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!await models.Team.exists({ tournament_id: tournamentId, code }).session(session)) return code;
  }
  throw new AppError(503, 'Could not create a team code. Please try again.', 'TEAM_CODE_UNAVAILABLE');
}

async function pairWaitingTeams(tournament, session) {
  const allTeams = await models.Team.find({ tournament_id: tournament._id, status: 'active' }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
  const existingMatches = await models.Match.find({ tournament_id: tournament._id }).select('participants.team_id match_number').session(session).lean();
  const pairedIds = new Set(existingMatches.flatMap((match) => match.participants.map((participant) => participant.team_id)));
  const waitingTeams = allTeams.filter((team) => team.members.length >= MIN_TEAM_SIZE && team.members.every((member) => member.user_id) && !pairedIds.has(team._id));
  if (waitingTeams.length < 2) return null;

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
  const initialProgress = [first, second].flatMap((team) => {
    const role = match.participants.find((participant) => participant.team_id === team._id).role;
    return team.members.map((member) => ({
      tournament_id: tournament._id,
      match_id: match._id,
      team_id: team._id,
      user_id: member.user_id,
      role,
      events: [{ type: 'match_assigned', detail: { role } }],
    }));
  });
  await models.ParticipantProgress.insertMany(initialProgress, { session });
  return { matchId: match._id, matchNumber };
}

function pairingForTeam(pairing, teamId) {
  if (!pairing) return null;
  const own = pairing.teams.find((team) => team.id === teamId);
  const opponent = pairing.teams.find((team) => team.id !== teamId);
  return { matchId: pairing.matchId, matchNumber: pairing.matchNumber, role: own.role, opponent: opponent.name };
}

async function pairWaitingTeamsWithDetails(tournament, session) {
  const pairing = await pairWaitingTeams(tournament, session);
  if (!pairing) return null;
  const match = await models.Match.findById(pairing.matchId).session(session).lean();
  const teamIds = match.participants.map((participant) => participant.team_id);
  const teams = await models.Team.find({ _id: { $in: teamIds } }).select('_id name').session(session).lean();
  return { ...pairing, teams: teams.map((team) => ({ id: team._id, name: team.name, role: match.participants.find((participant) => participant.team_id === team._id).role })) };
}

async function findOpenTournament(session, tournamentId, allowClosed) {
  const tournament = tournamentId
    ? await models.Tournament.findById(tournamentId).session(session)
    : await models.Tournament.findOne({ status: { $in: ['setup', 'active'] } }).sort({ createdAt: -1 }).session(session);
  if (!tournament) throw new AppError(404, 'Team registration is not available because no tournament is open.');
  if (!allowClosed && (tournament.status !== 'active' || tournament.config?.registrationOpen === false)) {
    throw new AppError(409, 'Team registration is currently closed.');
  }
  return tournament;
}

async function registerTeam({ tournamentId, name, groupName, members, allowClosed = false }) {
  const roster = validateRoster(name, members);
  return transaction(async (session) => {
    let tournament = await findOpenTournament(session, tournamentId, allowClosed);
    if (await models.Team.countDocuments({ tournament_id: tournament._id }).session(session) >= 60) {
      throw new AppError(409, 'This tournament has reached its 60-team registration limit.');
    }
    tournament = await models.Tournament.findByIdAndUpdate(tournament._id, { $inc: { registration_sequence: 1 } }, { returnDocument: 'after', session });
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
      code: await createUniqueTeamCode(tournament._id, session),
      group_name: groupName || null,
      status: 'active',
      members: users.map((user, index) => ({ user_id: user._id, name: roster.members[index].name, email: roster.members[index].email, member_number: index + 1, joined_at: new Date() })),
    }], { session });
    const details = await pairWaitingTeamsWithDetails(tournament, session);
    return { tournament, team, users, pairing: pairingForTeam(details, team._id) };
  });
}

async function registerCaptainTeam({ name, members }) {
  const roster = validateRoster(name, members, { captainOnly: true });
  return transaction(async (session) => {
    let tournament = await findOpenTournament(session, null, false);
    if (await models.Team.countDocuments({ tournament_id: tournament._id }).session(session) >= 60) {
      throw new AppError(409, 'This tournament has reached its 60-team registration limit.');
    }
    tournament = await models.Tournament.findByIdAndUpdate(tournament._id, { $inc: { registration_sequence: 1 } }, { returnDocument: 'after', session });
    const [captain] = await models.User.create([{
      email: roster.members[0].email,
      password_hash: await bcrypt.hash(roster.members[0].password, 12),
      display_name: roster.members[0].name,
      role: 'participant',
      is_active: true,
    }], { session });
    const teamMembers = roster.members.map((member, index) => ({
      ...(index === 0 ? { user_id: captain._id, joined_at: new Date() } : {}),
      name: member.name,
      email: member.email,
      member_number: index + 1,
    }));
    const [team] = await models.Team.create([{
      tournament_id: tournament._id,
      name: roster.name,
      code: await createUniqueTeamCode(tournament._id, session),
      status: teamMembers.length === 1 ? 'active' : 'pending',
      members: teamMembers,
    }], { session });
    return { tournament, team, captain };
  });
}

async function joinTeam({ code, email, password }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  return transaction(async (session) => {
    const tournament = await findOpenTournament(session, null, true);
    if (tournament.status !== 'active') throw new AppError(409, 'This event is no longer accepting team members.');
    const team = await models.Team.findOne({ tournament_id: tournament._id, code, status: 'pending' }).session(session);
    const slot = team?.members.find((member) => member.email === normalizedEmail && !member.user_id);
    if (!slot || await models.User.exists({ email: normalizedEmail }).session(session)) {
      throw new AppError(400, 'The team code or roster email is incorrect, or this member has already joined.', 'TEAM_JOIN_FAILED');
    }
    const [user] = await models.User.create([{
      email: normalizedEmail,
      password_hash: await bcrypt.hash(password, 12),
      display_name: slot.name,
      role: 'participant',
      is_active: true,
    }], { session });
    slot.user_id = user._id;
    slot.joined_at = new Date();
    if (team.members.every((member) => member.user_id)) team.status = 'active';
    await team.save({ session });
    if (team.status === 'active') {
      tournament = await models.Tournament.findByIdAndUpdate(tournament._id, { $inc: { registration_sequence: 1 } }, { returnDocument: 'after', session });
    }
    const pairingDetails = team.status === 'active' ? await pairWaitingTeamsWithDetails(tournament, session) : null;
    const pairing = pairingForTeam(pairingDetails, team._id);
    return { tournament, team, user, pairing };
  });
}

module.exports = { registerTeam, registerCaptainTeam, joinTeam, validateRoster, MIN_TEAM_SIZE, MAX_TEAM_SIZE };
