const express = require('express');
const { models } = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/me', async (req, res, next) => {
  try {
    const records = await models.ParticipantProgress.find({ user_id: req.user.id })
      .sort({ last_activity_at: -1 })
      .limit(50)
      .lean();
    const result = await Promise.all(records.map(async (record) => {
      const match = await models.Match.findById(record.match_id).select('match_number state').lean();
      const team = await models.Team.findById(record.team_id).select('name code').lean();
      return { ...record, match_number: match?.match_number, match_state: match?.state, team_name: team?.name, team_code: team?.code };
    }));
    res.json({ progress: result });
  } catch (error) {
    next(error);
  }
});

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.matchId) filter.match_id = String(req.query.matchId);
    if (req.query.tournamentId) filter.tournament_id = String(req.query.tournamentId);
    const records = await models.ParticipantProgress.find(filter)
      .sort({ last_activity_at: -1 })
      .limit(Math.min(500, Math.max(1, Number(req.query.limit) || 200)))
      .lean();
    const progress = await Promise.all(records.map(async (record) => {
      const [user, team, match] = await Promise.all([
        models.User.findById(record.user_id).select('email display_name').lean(),
        models.Team.findById(record.team_id).select('name code').lean(),
        models.Match.findById(record.match_id).select('match_number state').lean(),
      ]);
      const { latest_code, ...summary } = record;
      return {
        ...summary,
        email: user?.email,
        participant_name: user?.display_name,
        team_name: team?.name,
        team_code: team?.code,
        match_number: match?.match_number,
        match_state: match?.state,
      };
    }));
    res.json({ progress });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
