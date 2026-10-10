// Local-only end-to-end bot run. Requires a fresh local test DB and app server.
// Refuses non-loopback targets to protect the production tournament.
const BASE = process.env.BOT_TEST_URL || 'http://127.0.0.1:3117';
const ADMIN_EMAIL = process.env.BOT_TEST_ADMIN_EMAIL || 'bot-admin@findhacker.local';
const ADMIN_PASSWORD = process.env.BOT_TEST_ADMIN_PASSWORD || 'BotTestAdminPassword-2026';
const parsedBase = new URL(BASE);
if (!['localhost', '127.0.0.1', '::1'].includes(parsedBase.hostname)) {
  throw new Error('Safety stop: bot testing is restricted to localhost.');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(path, { token, ...options } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${BASE}/api${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 429 && attempt < 3) {
      const reset = Number(response.headers.get('ratelimit-reset'));
      const retryAfter = Number(response.headers.get('retry-after'));
      await delay(Math.max(1200, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : reset) * 1000 || 1200));
      continue;
    }
    if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${body.error?.message || JSON.stringify(body)}`);
    return body;
  }
  throw new Error(`Rate limited repeatedly: ${path}`);
}
const post = (path, token, body) => request(path, { method: 'POST', token, body: JSON.stringify(body) });
const patch = (path, token, body) => request(path, { method: 'PATCH', token, body: JSON.stringify(body) });

async function main() {
  const health = await fetch(`${BASE}/health`).then((response) => response.json());
  if (health.status !== 'ok') throw new Error('Local app or MongoDB is not healthy.');
  const login = await post('/auth/login', null, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const admin = login.token;
  const overview = await request('/tournament/overview', { token: admin });
  const tournament = overview.tournament;
  if (!tournament || tournament.config?.tournamentStarted) throw new Error('Expected a fresh, not-yet-started seeded test tournament.');
  if ((overview.stats?.teams || 0) !== 0) throw new Error('Safety stop: test tournament already contains teams.');

  const starterCode = `#include <iostream>\nusing namespace std;\nint main() {\n  int a = 0, b = 0;\n  if (cin >> a && cin >> b) {\n    for (int i = 0; i < 1; ++i) {\n      int sum = a + b;\n      if (sum == 0) { cout << 0; }\n      cout << sum << endl;\n    }\n  }\n  return 0;\n}\n`;
  const problemResult = await post('/problems', admin, {
    title: 'Automated bot check: sum two integers',
    description: 'Read two integers and print their sum. This challenge is created only in the isolated local bot-test database.',
    difficulty: 'easy', languages: ['cpp'], timeLimitMs: 3000, memoryLimitMb: 128,
    starterCode: { cpp: starterCode },
    testCases: [
      { input: '2 3\n', output: '5\n', hidden: false },
      { input: '100 200\n', output: '300\n', hidden: true },
    ],
  });
  const problemId = problemResult.problem.id;
  const stamp = Date.now();
  const teams = [];
  const participants = [];

  for (let teamNumber = 1; teamNumber <= 20; teamNumber += 1) {
    const members = Array.from({ length: 4 }, (_, memberIndex) => ({
      name: `Bot ${String(teamNumber).padStart(2, '0')}-${memberIndex + 1}`,
      email: `fhbot.${stamp}.${teamNumber}.${memberIndex + 1}@example.com`,
      ...(memberIndex === 0 ? { password: `CaptainBot-${stamp}-${teamNumber}!` } : {}),
    }));
    const captain = await post('/registration', null, { teamName: `Bot Team ${String(teamNumber).padStart(2, '0')} ${stamp}`, members });
    const team = { id: captain.team.id, name: captain.team.name, code: captain.team.code, tokens: [captain.token] };
    participants.push({ team, memberNumber: 1, token: captain.token });
    for (let memberIndex = 1; memberIndex < members.length; memberIndex += 1) {
      const joined = await post('/registration/join', null, {
        code: team.code,
        email: members[memberIndex].email,
        password: `MemberBot-${stamp}-${teamNumber}-${memberIndex}!`,
      });
      team.tokens.push(joined.token);
      participants.push({ team, memberNumber: memberIndex + 1, token: joined.token });
    }
    teams.push(team);
    console.log(`Registered team ${teamNumber}/20 (4/4 bots)`);
  }

  const adminMatches = await request('/matches', { token: admin });
  const matches = adminMatches.matches || [];
  if (matches.length !== 10) throw new Error(`Expected 10 paired matches; found ${matches.length}.`);
  for (const match of matches) {
    await patch(`/matches/${match.id}/setup`, admin, {
      problemId,
      coderTeamId: match.coder_team_id,
      detectiveTeamId: match.detective_team_id,
    });
  }
  const started = await post(`/tournament/${tournament._id}/start`, admin, {});
  if (started.matchesStarted !== 10) throw new Error(`Expected 10 started matches; found ${started.matchesStarted}.`);
  console.log('All 10 matches started; checking participant room access and playing both roles.');

  // All 40 coder participants open the live room; one from each team runs public tests.
  const byTeam = new Map(teams.map((team) => [team.id, participants.filter((participant) => participant.team.id === team.id)]));
  let runnerAvailable = true;
  for (const match of matches) {
    const coderId = match.coder_team_id;
    const coderBots = byTeam.get(coderId);
    await Promise.all(coderBots.map((bot) => request(`/matches/${match.id}`, { token: bot.token })));
    try {
      const run = await post(`/matches/${match.id}/run`, coderBots[0].token, { sourceCode: starterCode, language: 'cpp' });
      if (run.status === 'runner_unavailable') runnerAvailable = false;
    } catch (error) {
      if (error.message.includes('(503)') && /runner|execution|judge/i.test(error.message)) runnerAvailable = false;
      else throw error;
    }
  }

  const attackTypes = ['BRACKET_ATTACK', 'TOKEN_TYPO_ATTACK', 'SEMICOLON_ATTACK', 'INCREMENT_ATTACK', 'CONDITION_CHANGE', 'OPERATOR_CHANGE', 'LOGICAL_CHANGE', 'BOUNDARY_ATTACK', 'EDGE_CASE_ATTACK'];
  const attackResults = [];
  // Each detective bot attacks once; the 7-second team cooldown is respected.
  for (let memberNumber = 0; memberNumber < 4; memberNumber += 1) {
    const batch = await Promise.all(matches.map(async (match, matchIndex) => {
      const bot = byTeam.get(match.detective_team_id)[memberNumber];
      const type = attackTypes[(matchIndex * 4 + memberNumber) % attackTypes.length];
      const result = await post(`/matches/${match.id}/attacks`, bot.token, { type });
      attackResults.push({ type, result: result.attack.result });
      return result;
    }));
    if (memberNumber < 3) await delay(7100);
  }

  // Coder teams restore their known-correct code. If the isolated judge is disabled,
  // record the blocked submission, then have the organizer close this local test match.
  let accepted = 0;
  for (const match of matches) {
    const coderBot = byTeam.get(match.coder_team_id)[0];
    await request(`/matches/${match.id}/code`, { method: 'PUT', token: coderBot.token, body: JSON.stringify({ sourceCode: starterCode, language: 'cpp' }) });
    try {
      const result = await post(`/matches/${match.id}/submit`, coderBot.token, { sourceCode: starterCode, language: 'cpp' });
      if (result.status === 'accepted') accepted += 1;
    } catch (error) {
      if (error.message.includes('(503)') && /runner|execution|judge/i.test(error.message)) runnerAvailable = false;
      else throw error;
    }
    if (!runnerAvailable) await post(`/matches/${match.id}/end`, admin, { winnerTeamId: match.detective_team_id, reason: 'bot_test_runner_unavailable' });
  }

  const finalOverview = await request('/tournament/overview', { token: admin });
  const summary = {
    registeredTeams: teams.length,
    registeredParticipants: participants.length,
    matchesStarted: started.matchesStarted,
    coderRoomChecks: matches.length * 4,
    detectiveAttacks: attackResults.length,
    attackTypesTried: [...new Set(attackResults.map((item) => item.type))],
    attacksApplied: attackResults.filter((item) => item.result === 'applied').length,
    attacksWithoutTarget: attackResults.filter((item) => item.result !== 'applied').length,
    acceptedCoderSubmissions: accepted,
    isolatedRunnerAvailable: runnerAvailable,
    completedMatches: finalOverview.stats.completed_matches,
    activeMatchesRemaining: finalOverview.stats.active_matches,
    localOnlyDatabase: process.env.BOT_TEST_DATABASE || 'dedicated local bot-test database',
  };
  console.log('\nBOT TEST SUMMARY');
  console.log(JSON.stringify(summary, null, 2));
  if (accepted !== 10 || !runnerAvailable || finalOverview.stats.completed_matches !== 10) process.exitCode = 1;
}

main().catch((error) => { console.error(`BOT TEST FAILED: ${error.message}`); process.exitCode = 1; });
