# Find the Hacker

Full-stack competition platform for teams of three to five. The Node.js service owns accounts, team isolation, match state and deadlines, submissions, attacks, scores, organizer actions, and the tournament record. MongoDB stores durable documents; Socket.IO publishes scoped live match events.

## Architecture and trust boundaries

- **Browser:** responsive participant and organizer interface. Browsers are clients only; the server checks every match action and uses database timestamps for deadlines.
- **API:** Express, JSON validation, rate limits, HTTP-only session cookie, JWT bearer support, role checks, audit events, and Socket.IO authentication.
- **Database:** MongoDB models in `server/db/models.js`. Users, teams, tournaments, rounds, problems, matches, participant progress, scores, final competitions, and audit logs are separate collections. Every participant gets an individual progress record for each paired match. Code saves, public runs, submissions, attacks, role, and a capped activity history are persisted there.
- **Code judge:** `server/sandbox/runner.js` speaks to a separate authenticated runner API. Execution is **disabled by default** and fails closed. Do not point this at an ordinary web process or run participant code inside the application container. A production judge must isolate every job with no network, CPU/memory/process/time/output limits, temporary storage, and a disposable filesystem. Its API contract is described below.

## Run locally

Requirements: Node.js 20+, npm, Docker Engine with Compose, and a separate isolated runner for code execution. MongoDB runs as a single-node replica set in Compose so transactions used for match actions work locally.

1. Copy `.env.example` to `.env` and replace the JWT secret and organizer password.
2. Start the database and app: `docker compose up --build -d`.
3. Apply indexes and initialize the event and organizer (safe to rerun):

   ```sh
   docker compose exec app npm run db:migrate
   docker compose exec app npm run db:seed
   ```

4. Open `http://localhost:3000`. Health check: `http://localhost:3000/health`.

The seed creates the tournament, first round, and organizer account. It does not create fake teams, participant accounts, matches, or challenge data. Participants register through the website, and the organizer adds real challenges from the Problems section. Default local organizer credentials (change these before exposing the service):

- Organizer: `admin@findhacker.local` / `ChangeThisAdminPassword!`
- There are no participant demo accounts. Use **Register a team** on the sign-in screen to enroll a team of three to five individual participants.
- Use **Organizer registration** for additional administrator accounts. It requires the private `ADMIN_REGISTRATION_KEY` from `.env`; never publish or share that key publicly.

The first participant is the team captain and is signed in after registration. Each participant can later sign in with their own email and password. Teams are paired in registration order when a second unpaired team completes registration. One team receives the coder role and the other receives the detective role; roles alternate across matches. The organizer creates challenges in **Problems**, assigns one to each ready match from the dashboard, then starts that match. Individual progress records are initialized for every member of both teams in a pair and updated as they save code, run tests, submit, or attack.

### Local Node process

For a local MongoDB replica set, set `MONGODB_URI` in `.env`, then run `npm ci`, `npm run db:migrate`, `npm run db:seed`, and `npm start`. Transactions require a replica set; a standalone `mongod` is not sufficient. `npm run dev` enables Node's watch mode.

## Isolated runner integration

Set `EXECUTION_MODE=runner-api`, `RUNNER_URL`, and `RUNNER_TOKEN` only after deploying a hardened judge on a private network. The application calls `POST {RUNNER_URL}/v1/execute` with bearer authentication and JSON:

```json
{
  "language": "cpp",
  "sourceCode": "...",
  "input": "...",
  "limits": { "timeMs": 2000, "memoryMb": 128, "outputBytes": 65536, "network": false }
}
```

The judge must return JSON with `exitCode` (integer), `stdout` and `stderr` (strings), and optional `executionMs` (integer). It must enforce the supplied limits itself; the application also aborts requests after the configured timeout plus one second. Never trust judge-provided hidden input/output in API responses. Hidden cases are loaded only by the server and only pass/fail summaries are returned.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `MONGODB_URI` | MongoDB connection string; transactions require replica-set mode |
| `JWT_SECRET` | Required secret, at least 32 characters |
| `ADMIN_REGISTRATION_KEY` | Private invite key for creating additional organizer accounts |
| `JWT_EXPIRES_IN` | Session token lifetime |
| `COOKIE_SECURE` | Set `true` behind HTTPS |
| `CLIENT_ORIGIN` | Allowed browser origin |
| `MATCH_DURATION_SECONDS` | Default match length |
| `ATTACKS_PER_DETECTIVE` | Default per-player attack budget |
| `REGISTRATION_OPEN` | `true` to accept team signups during the active event |
| `TOURNAMENT_NAME` | Event initialized by the seed command |
| `EXECUTION_MODE` | `disabled` (default) or `runner-api` |
| `RUNNER_URL`, `RUNNER_TOKEN` | Private isolated judge endpoint and token |
| `CODE_TIMEOUT_MS`, `CODE_MEMORY_MB`, `CODE_OUTPUT_BYTES` | Default runner limits |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Seed organizer credentials |

Tournament-level configuration is stored as JSON in `tournaments.config`; it can set match duration, attack tokens, score values, early completion bonus, successful attack score, and final score weights.

## API overview

Authenticated APIs accept the HTTP-only session cookie from the UI or an `Authorization: Bearer <token>` header. Login is rate-limited. Errors use `{ "error": { "code", "message", "requestId" } }`.

| Method | Route | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/registration/status` | Public | Registration availability and event name |
| `POST` | `/api/registration` | Public, rate-limited | Register one team and three to five participant accounts; pair teams automatically |
| `POST` | `/api/registration/admin` | Public, invite-key protected | Register an organizer account |
| `POST` | `/api/auth/login` | Public | Sign in |
| `POST` | `/api/auth/logout` | User | Clear session cookie |
| `GET` | `/api/auth/me` | User | Identity and team |
| `GET` | `/api/matches` | User/admin | Assigned or all matches |
| `GET` | `/api/matches/:id` | Participant/admin | Match, public cases, role-filtered code |
| `PUT` | `/api/matches/:id/code` | Coder | Persist current code during active match |
| `POST` | `/api/matches/:id/run` | Coder | Run public tests in judge |
| `POST` | `/api/matches/:id/submit` | Coder | Server-side hidden evaluation |
| `POST` | `/api/matches/:id/attacks` | Detective | Apply one allowlisted change |
| `POST` | `/api/matches/:id/start`, `/pause`, `/end` | Admin | Control or override match |
| `PATCH` | `/api/matches/:id/problem` | Admin | Assign or clear the challenge before a match starts |
| `GET` | `/api/matches/:id/attacks` | Participant/admin | Redacted history for teams; attribution for admins |
| `GET` | `/api/tournament/overview`, `/rounds`, `/standings`, `/groups/:name` | User/admin | Event status and standings |
| `POST` | `/api/tournament/teams`, `/rounds`, `/matches`, `/advance` | Admin | Register a team or configure tournament progression |
| `PATCH` | `/api/tournament/teams/:id`, `/settings` | Admin | Update team or scoring/config |
| `GET`, `POST`, `PUT`, `DELETE` | `/api/problems` | User/admin | List; organizers manage problems and test cases |
| `POST` | `/api/final/from-groups` | Admin | Select group winners and create a five-team final |
| `GET` | `/api/final/current` | Finalist/admin | Final status and standings |
| `POST` | `/api/final/:id/start`, `/submit`, `/complete` | Admin/participant | Run final and publish ranking |
| `GET` | `/api/tournament/audit` | Admin | Audit trail |
| `GET` | `/api/progress/me` | User | Read the signed-in participant’s saved progress |
| `GET` | `/api/progress` | Admin | Review participant progress across matches |

### Realtime events

Connect with the session cookie or the login token. Join a match with `match:join` and `{ matchId }`; membership is checked server-side. Match events are emitted only to that match room: `match:started`, `match:paused`, `code:changed`, `attack:applied`, `test:result`, `submission:received`, and `match:completed`. Detective identity is omitted from participant attack events. Final completion is announced as `tournament:final:completed` to authenticated sockets.

## Deployment checklist

- Put the app behind TLS, set `COOKIE_SECURE=true`, set a precise `CLIENT_ORIGIN`, and use a high-entropy `JWT_SECRET`.
- Keep `ADMIN_REGISTRATION_KEY` private, share it only with approved organizers, and rotate it after organizer onboarding.
- Change seed passwords or disable seed credentials before public launch. Back up MongoDB and restrict database access to the application and administrators.
- Deploy the isolated runner separately on a private network; keep its token secret, deny outbound network by default, and review its container/VM isolation and compiler/runtime images.
- Use a shared Socket.IO adapter such as Redis before running multiple app replicas. The included in-memory Socket.IO adapter is intended for a single app process.
- Configure database backups, logs/metrics/alerts, HTTPS ingress, secret rotation, retention, and a restore drill.
- Run dependency and container image scanning in CI. The match timer is persisted as a database deadline, so app restarts do not extend matches.

## Current implementation boundaries

This repository contains the runnable web/API/database system and an isolated-runner integration boundary. It intentionally does not execute untrusted programs in the app process; code run/submit returns a service-unavailable response until a trusted judge is deployed. Tournament group generation and five-team final scoring are implemented, but the event operator still needs to configure real challenge content, verify scoring weights, and validate judge behavior before using this for a live prize competition. The default UI uses a compact code textarea; Monaco can be added as an editor dependency without changing the API contract.
