const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { models } = require('../db');
const { AppError } = require('../errors');
const { registerTeam, MIN_TEAM_SIZE, MAX_TEAM_SIZE } = require('../services/teamRegistration');

const router = express.Router();
const memberSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(200),
});
const registrationSchema = z.object({
  teamName: z.string().trim().min(3).max(80),
  members: z.array(memberSchema).min(MIN_TEAM_SIZE).max(MAX_TEAM_SIZE),
});
const adminRegistrationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(16).max(200),
  inviteCode: z.string().min(1).max(256),
});

router.post('/admin', async (req, res, next) => {
  try {
    const parsed = adminRegistrationSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message || 'Check the organizer registration details.');
    const expected = Buffer.from(process.env.ADMIN_REGISTRATION_KEY || '');
    const provided = Buffer.from(parsed.data.inviteCode);
    if (expected.length < 32 || expected.toString().toLowerCase().startsWith('replace-with-')) throw new AppError(503, 'Organizer registration is not configured. Ask the system owner to set a private ADMIN_REGISTRATION_KEY.');
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      throw new AppError(403, 'Organizer invitation code is incorrect.');
    }

    const [user] = await models.User.create([{
      email: parsed.data.email.toLowerCase(),
      password_hash: await bcrypt.hash(parsed.data.password, 12),
      display_name: parsed.data.name,
      role: 'admin',
      is_active: true,
    }]);
    const token = jwt.sign(
      { sub: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'find-the-hacker' },
    );
    res.cookie('fh_session', token, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/',
    });
    await models.AuditLog.create({ actor_id: user._id, action: 'auth.admin_registered', resource_type: 'user', resource_id: user._id });
    return res.status(201).json({ token, user: { id: user._id, email: user.email, name: user.display_name, role: user.role } });
  } catch (error) {
    if (error?.code === 11000) return next(new AppError(409, 'An account with that email already exists.'));
    return next(error);
  }
});

router.get('/status', async (_req, res, next) => {
  try {
    const tournament = await models.Tournament.findOne({ status: { $in: ['setup', 'active'] } }).sort({ createdAt: 1 }).lean();
    if (!tournament) return res.json({ open: false, tournamentName: null, teamCount: 0 });
    const teamCount = await models.Team.countDocuments({ tournament_id: tournament._id });
    return res.json({
      open: tournament.status === 'active' && tournament.config?.registrationOpen !== false,
      tournamentName: tournament.name,
      teamCount,
      teamSizeMin: MIN_TEAM_SIZE,
      teamSizeMax: MAX_TEAM_SIZE,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message || 'Check the team registration details.');
    if (new Set(parsed.data.members.map((member) => member.email.toLowerCase())).size !== parsed.data.members.length) {
      throw new AppError(400, 'Each participant must use a different email address.');
    }
    const result = await registerTeam({ name: parsed.data.teamName, members: parsed.data.members });
    req.app.locals.io?.emit('tournament:team:registered', { teamId: result.team._id });
    if (result.pairing) req.app.locals.io?.emit('tournament:pair:created', { matchId: result.pairing.matchId, matchNumber: result.pairing.matchNumber });
    const captain = result.users[0];
    const token = jwt.sign(
      { sub: captain._id, role: captain.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h', issuer: 'find-the-hacker' },
    );
    res.cookie('fh_session', token, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/',
    });
    return res.status(201).json({
      token,
      user: { id: captain._id, email: captain.email, name: captain.display_name, role: captain.role },
      team: { id: result.team._id, name: result.team.name, code: result.team.code },
      pairing: result.pairing,
    });
  } catch (error) {
    if (error?.code === 11000) return next(new AppError(409, 'That team name or participant email is already registered.'));
    return next(error);
  }
});

module.exports = router;
