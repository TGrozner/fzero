# F-Zero 99

A 99-player online battle-royale racing game inspired by Nintendo's F-Zero 99, built end-to-end with React + TypeScript + Cloudflare Workers + Durable Objects.

> Top-down anti-grav racing. Real-time WebSocket multiplayer. Bots fill empty seats so it's always 99 racers on the grid.

## Features

- **99 simultaneous racers** on the same track. Humans + AI bots fill remaining slots.
- **Power Meter**: shared HP / boost gauge — boost costs HP, off-track erodes HP, walls hurt. HP=0 = KO.
- **Spin attack** (Enter) — bumps and damages nearby ships.
- **Side attacks** (Q/E) — lateral burst that knocks rivals away.
- **Skyway** (Space) — once the KO Meter is full, fly above the track for 5s, immune to collisions.
- **Last-20 boost** — when racers drop below 20, every survivor gets a free 3s boost.
- **2 tracks** — `Mute Avenue` (oval) and `Big Blue` (peanut).
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
npx wrangler deploy                                    # Worker (server)
npx wrangler pages deploy dist --project-name=fzero    # Pages (client)
```

The client picks the server URL from `VITE_SERVER_URL` (set this in your Pages project env) and falls back to `wss://<your-pages-domain>/ws`.

## Live

Public URL: see the GitHub release / repo description (filled in after deploy).

## License

MIT.
