# Neon Drift

[![CI](https://github.com/TGrozner/neon-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/TGrozner/neon-drift/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A 99-player synthwave anti-grav battle-royale racer, built end-to-end with React + TypeScript + Cloudflare Workers + Durable Objects.

> Top-down anti-grav racing. Real-time WebSocket multiplayer. Bots fill empty seats so it's always 99 racers on the grid.

> **Play live:** https://neon-drift-31d.pages.dev

## Features

### Racing
- **99 simultaneous racers** on the same track. Humans + AI bots fill remaining slots.
- **Power Meter**: shared HP / boost gauge — boost costs HP, off-track erodes HP, walls hurt. HP=0 = KO.
- **Spin attack** (Enter) — bumps and damages nearby ships.
- **Side attacks** (Q/E) — lateral burst that knocks rivals away.
- **Skyway** (Space) — once the KO Meter is full, fly above the track for 5 s, immune to collisions.
- **Last-20 boost** — when racers drop below 20, every survivor gets a free 3 s boost.
- **3 tracks** — `Mute Avenue` (oval), `Big Blue` (peanut), and `Port Town` (chicane).
- **3 ship classes** — Speed, Tank, Balanced. Switchable per-player from the lobby.
- **Configurable lap count** — 1 / 2 / 3 / 5, picked by the host before the race.
- **Perfect start** — full throttle on GO grants a free 1.5 s boost.
- **Pickups** — boost pads, heal plates, and mines, respawning every 5 s.
- **Death cam** — when you're KO'd, the camera locks onto whoever did it for ~1.5 s.
- **Live spectator** — after your KO the camera follows the leader so you can watch the rest of the race.
- **In-race name labels** — human player names float above their ships so you can spot your friends in the pack (bots are unlabeled to keep the screen readable).

### Multiplayer lobby
- **Host model** — the longest-connected human is the host. Auto-transfers when the host leaves.
  Only the host can change the lap count or trigger Start Now.
- **Track voting** — every player votes for a track from the dropdown; the active track follows the
  majority. Ties keep the current track. The lobby shows the live tally and the winning track.
- **Per-player ready** — race auto-starts as soon as every human ticks Ready.
- **Start Now** — the host can override Ready to launch the race immediately.
- **Spectator mode** — joining a room while a race is in progress drops you into the action as an
  observer (no vehicle, full snapshots). You're auto-promoted to a player when the next race starts.
- **Auto-rejoin** — at the end of every race, all still-connected sockets are re-promoted into the
  fresh lobby without disconnect / reconnect. Friend groups can chain matches without churn.
- **Per-player ping** — each pilot's RTT shows next to their name in the lobby (green / yellow / red).
- **Career stats** — races, wins, podiums, KOs, deaths persisted in localStorage and shown on the menu.
- **Personal bests** — best lap + best race per track, persisted locally.
- **Invite link** — one-click copy of a `?room=…` URL so friends land in the same room.
- **Mobile-ready** — touch joystick + action buttons on phones / tablets.

### Net
- Server-authoritative simulation at **10 Hz** (one tick = one Durable Object alarm). Client
  interpolates between snapshots so the gap is invisible at the wheel.

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vite + React 19 + TypeScript (strict + noUncheckedIndexedAccess) |
| Rendering | Canvas 2D |
| Backend | Cloudflare Workers + Durable Objects (1 DO per room) |
| Protocol | JSON over WebSocket (WebSocket Hibernation API) |
| Tests | Vitest + @testing-library/react + Playwright |
| Lint | ESLint + Prettier |
| CI/CD | GitHub Actions |

## Controls

| Action | Keys |
|---|---|
| Steer / accel / brake | WASD or Arrow keys |
| Boost | Shift |
| Spin attack | Enter |
| Side attack (left/right) | Q / E |
| Skyway (when KO Meter full) | Space |
| Pause overlay (display only) | P |
| Leave race | Escape |

On phones / tablets: a left-side joystick steers and accelerates, right-side buttons map to boost / spin / side / Skyway.

### Lobby flow

1. Pick a pseudo, color, and ship class on the menu, optionally set a `room` to private-match with friends.
2. **Race** lands you in the lobby. The first pilot to join is the host (★).
3. Vote for a track from the dropdown — the active track always follows the majority vote.
4. Click **Ready**. When everyone's ticked, the race starts after a 3-second countdown.
5. Host-only buttons:
   - **Start now** — launch the race immediately, ignoring Ready flags.
   - **Laps** — 1 / 2 / 3 / 5 (changing the lap count clears everyone's Ready).
6. After a race ends, the cooldown auto-rolls everyone back into the lobby for the next match.
7. Joining a room mid-race lands you in **spectator** mode — you watch the race in real time and
   are auto-promoted to a player when the lobby reopens.

## Accessibility

- Respects `prefers-reduced-motion`: screen shake, vignette pulse and trail flicker are disabled when the OS asks for less motion.
- Full keyboard navigation in the menus (focus rings, `Tab` cycles).
- Audio is opt-out (mute in the menu) and never auto-plays without a user gesture.

## Running locally

Pre-requisites: Node 20+ and a one-time `npx wrangler login` for Cloudflare.

```bash
npm install
npm run dev          # starts vite (5173) + wrangler dev (8787) in parallel
```

Open http://localhost:5173.

> Tip: append `?fast=1` (e.g. http://localhost:5173/?fast=1) to arm a 2 s auto-start timer instead of using the Ready / Start Now flow — handy for e2e tests and solo bot racing.

## Scripts

```bash
npm run dev          # vite + wrangler dev (concurrently)
npm run build        # tsc -b && vite build
npm run preview      # serve dist/ for prod check
npm run lint         # eslint
npm run typecheck    # tsc -b --noEmit
npm test             # vitest
npm run test:cov     # vitest + coverage threshold
npm run e2e          # playwright (spawns wrangler dev + preview server)
npm run deploy:server  # wrangler deploy
npm run deploy:client  # wrangler pages deploy
```

## Project layout

```
shared/        # pure logic shared by client + server
  vec2.ts          # 2D math
  rng.ts           # mulberry32 seeded RNG + string hash
  track.ts         # centerline geometry, checkpoints, edges, starting grid
  physics.ts       # vehicle dynamics, wall collision, side attack impulses
  attacks.ts       # spin attack damage + KO detection
  race.ts          # per-frame race step (physics + attacks + collisions + lap)
  bot.ts           # AI bots (lookahead + avoidance + profiles)
  protocol.ts      # WS message + input encoding
  roomCore.ts      # framework-free room state machine
  constants.ts     # game-wide tunables

server/        # Cloudflare Worker entry + Durable Object wrapper around RoomCore

src/           # Vite + React client
  state.ts         # client UI reducer
  net/socket.ts    # tiny WS wrapper
  hooks/           # useGameLoop, useKeyboard, useGameSocket
  render/          # Canvas 2D renderer + minimap
  components/      # Menu, Lobby, Race, HUD, Results

e2e/           # Playwright tests
```

## Architecture

```
                ┌──────────────┐  WebSocket   ┌────────────────────┐
   browser  ◄──►│ React client │ ◄──────────► │ Cloudflare Worker  │
                │  Canvas2D    │              │  Room (DurableObj) │
                └──────────────┘              └────────────────────┘
                                                      │
                                                      ▼
                                          ┌──────────────────────┐
                                          │ RoomCore (pure TS)   │
                                          │  - 10 Hz simulation  │
                                          │  - 99 vehicles       │
                                          │  - bot AI in-loop    │
                                          └──────────────────────┘
```

The client only sends inputs (`{throttle, steer, boost, spin, sideLeft, sideRight, skyway}`).
Positions, HP, KO state, lap progression — everything authoritative — comes from the server.
Bots run in the same `RoomCore` simulation so they're indistinguishable from humans on the wire.

## Deployment

`main` branch deploys via GitHub Actions to Cloudflare Workers + Pages **if** the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets are set on the repo.

To deploy manually:

```bash
npx wrangler deploy                                                     # Worker (server)
npm run build && npx wrangler pages deploy dist --project-name=neon-drift   # Pages (client)
```

The client picks the WebSocket URL in this order:

1. `VITE_SERVER_URL` (build-time env) — recommended. Set it on the Pages project / Actions repo variable. Example: `wss://neon-drift-server.<your>.workers.dev/ws`.
2. Same-origin `/ws` — works when the Pages project pairs with the bundled Pages Function at [`functions/ws.ts`](functions/ws.ts), which forwards to the Worker. Set `WORKER_URL=https://<your-worker>.workers.dev` on the Pages project.

Option 1 is the cheapest (one less hop, no Pages Function invocations). Option 2 is handy when you want a single domain or your Worker isn't publicly reachable.

### Cloudflare free tier

Designed to run cleanly on the Workers free tier (100 k requests / day total — covers Worker
invocations + Durable Object requests + Pages Functions). Built-in protections:

- **10 Hz simulation tick** — the dominant cost driver. Each alarm fire is one DO request; client
  interpolation (100 ms render delay) hides the gap between snapshots. See `SERVER_TICK_HZ` in
  [shared/constants.ts](shared/constants.ts) — drop to 5 Hz if you start scraping the daily limit.
- **10 Hz client input throttle** — inputs are aligned with the tick rate; a misbehaving client
  gets closed by the per-socket rate limiter (`WS_INPUT_RATE_LIMIT_PER_S` = 30, ~3× headroom).
- **1 Hz alarm in WAITING** — lobbies bleed `startsIn` once a second instead of 5×.
- **Empty-room hibernation** — Durable Object alarms stop scheduling once the last player leaves
  AND the room is back in WAITING.
- **Sanitized room names** — `?room=` is alphanumeric + dash + underscore, ≤ 32 chars, so a hostile
  client can't spawn a thousand DOs by varying the param.
- **Auto-abandon** — the race ends as soon as the last human disconnects, freeing the DO for the
  next lobby instead of letting the simulation run to completion against a wall of bots.
- **No sourcemaps in prod** — `sourcemap: false` in [vite.config.ts](vite.config.ts) keeps the JS
  bundles minified-only on Pages.

A daily GitHub Actions cron (`.github/workflows/cf-usage.yml`) queries the Cloudflare GraphQL
Analytics API and opens an issue if the past 24 h consumption crosses 80 % of the free tier — set
the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets and the token must include the
"Account Analytics: Read" permission.

If your free tier still drains too fast, lower `SERVER_TICK_HZ` further in `shared/constants.ts`
and bump `INTERP_DELAY_MS` in `src/render/renderer.ts` to match (one full tick interval). The
visual hit at 3 Hz is just barely perceptible at 60 fps render; below that, ships start looking
"jumpy" near the camera.

## Tests

```bash
npm test                 # unit tests (vitest)
npm run e2e              # Playwright e2e against a local wrangler dev + preview server
SMOKE_URL=wss://… node scripts/smoke-test.mjs           # ~5 DO req prod liveness check
SMOKE_URL=wss://… node scripts/multi-client-test.mjs    # 6 multi-client coherence cases against prod
FULL=1 SMOKE_URL=… node scripts/multi-client-test.mjs   # +2 long-running auto-rejoin cases (~80 s each)
```

## License

MIT.
