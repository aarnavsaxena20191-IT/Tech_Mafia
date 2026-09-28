const { models } = require('../db');
const { getTeamForUser } = require('./identity');

async function recordProgress(userId, matchId, { type, detail = {}, sourceCode, language, revision, passedTests } = {}) {
  const team = await getTeamForUser(userId);
  if (!team) return null;
  const match = await models.Match.findOne({ _id: matchId, 'participants.team_id': team.id })
    .select('tournament_id participants')
    .lean();
  const participant = match?.participants.find((entry) => entry.team_id === team.id);
  if (!match || !participant) return null;

  const increments = {};
  if (type === 'public_run') increments.public_runs = 1;
  if (type === 'submission' || type === 'submission_error') increments.submissions = 1;
  if (type === 'attack') increments.attacks = 1;
  if (Number.isInteger(passedTests)) increments.passed_tests = passedTests;
  const set = { last_activity_at: new Date() };
  if (typeof sourceCode === 'string') set.latest_code = sourceCode;
  if (language) set.language = language;
  if (Number.isInteger(revision)) set.revision = revision;

  return models.ParticipantProgress.findOneAndUpdate(
    { match_id: matchId, user_id: userId },
    {
      $setOnInsert: {
        tournament_id: match.tournament_id,
        team_id: team.id,
        role: participant.role,
      },
      $set: set,
      ...(Object.keys(increments).length ? { $inc: increments } : {}),
      $push: { events: { $each: [{ type, detail, at: new Date() }], $slice: -100 } },
    },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );
}

module.exports = { recordProgress };
