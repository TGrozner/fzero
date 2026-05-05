# Neon Drift

[![CI](https://github.com/TGrozner/neon-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/TGrozner/neon-drift/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A 99-player synthwave anti-grav battle-royale racer, built end-to-end with React + TypeScript + Cloudflare Workers + Durable Objects.

> Top-down anti-grav racing. Real-time WebSocket multiplayer. Bots fill empty seats so it's always 99 racers on the grid.

> **Play live:** _link added once the Pages project is configured — see [Deployment](#deployment)._

## Features

- **99 simultaneous racers** on the same track. Humans + AI bots fill remaining slots.
- **Power Meter**: shared HP / boost gauge — boost costs HP, off-track erodes HP, walls hurt. HP=0 = KO.
- **Spin attack** (Enter) — bumps and damages nearby ships.
- **Side attacks** (Q/E) — lateral burst that knocks rivals away.
- **Skyway** (Space) — once the KO Meter is full, fly above the track for 5s, immune to collisions.
- **Last-20 boost** — when racers drop below 20, every survivor gets a free 3s boost.
- **3 tracks** — `Mute Avenue` (oval), `Big Blue` (peanut), and `Port Town` (chicane).
- **3 ship classes** — Speed (top speed), Tank (steering + restitution), Balanced.
- **Perfect start** — full throttle on GO grants a free 1.5 s boost.
- **Pickups** — boost pads, heal plates, and mines, respawning every 5 s.
- **Death cam** — when you're KO'd, the camera locks onto whoever did it for ~1.5 s.
- **Spectator mode** — after your KO, the camera follows the leader so you can watch the rest of the race play out.
- **Personal bests** — best lap + best race per track, persisted locally.
- **Mobile-ready** — touch joystick + action buttons on phones / tablets.
- Real-time **server-authoritative** simulation @ 30 Hz, snapshots @ 20 Hz, with client interpolation.
- Lobby with auto-start: 25s after the first pilot joins, shortened to 12s when a 2nd shows up.

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

> Tip: append `?fast=1` (e.g. http://localhost:5173/?fast=1) to shorten the lobby auto-start timer to 2 s — handy when racing solo against bots.

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
                                          │  - 30 Hz simulation  │
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

Designed to run cleanly on the Workers free tier (100k req/day, 1M Durable Object invocations/month). Built-in protections:

- Rooms hibernate when empty — Durable Object alarms stop scheduling once the last player leaves.
- Per-socket input rate limit (60 msg/s) prevents a misbehaving client from inflating DO request counts.
- Single 30 Hz simulation tick produces snapshots at 20 Hz; client interpolation hides the gap.
- Concurrent room cap (`MAX_ROOMS` constant) protects against a single attacker spawning many DO instances by repeatedly changing `?room=`.

If your free tier still drains too fast, raise `SERVER_TICK_MS` in `shared/constants.ts` (e.g. from 33 to 50) — the client interpolates so the visual hit is small.

## License

MIT.
