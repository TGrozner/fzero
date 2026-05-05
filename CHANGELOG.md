# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres loosely to [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Multiplayer lobby coherence pass.** Single source of authority for global
  decisions, fair process for shared ones:
  - **Host model.** Longest-connected human is the host (★). Auto-transfers
    when they leave. Only the host can change the lap count or trigger
    Start Now; non-host attempts are silently ignored both client-side
    (button hidden / select disabled) and server-side (defense in depth).
  - **Track voting.** `set_track` records a vote; the active track follows
    the majority. Ties keep the current track. The lobby shows the live
    tally and per-player vote.
  - **Configurable lap count** — 1 / 2 / 3 / 5, host-controlled.
  - **Per-player ship-class switcher** in the lobby.
  - **Per-player ping** — RTT shows next to each name in green / yellow / red
    bands. Lobby pings every 30 s to keep readings fresh.
  - **Spectator mode.** `?spectator=1` joins a room mid-race as an observer
    (no vehicle, full snapshots). Auto-promoted to a player when the next
    race starts. Pre-flight `/status` makes the client switch to spectator
    silently when the room is busy instead of throwing a 409.
  - **Auto-rejoin between races.** At the FINISHED → WAITING cooldown the
    server re-promotes every still-connected socket (players + spectators)
    with a fresh personalized welcome — no disconnect / reconnect dance.
- **Career stats** persisted in localStorage: races, wins (+win rate),
  podiums, KOs, deaths. Shown on the menu under the per-track PB row.
- **In-race name labels** for human players (skipped for bots so the screen
  stays readable on a 99-grid).
- `/status` Worker endpoint returning `{phase, humans, maxPlayers, trackId,
  laps}` so clients can pre-flight a room before attempting an upgrade.
- `scripts/multi-client-test.mjs` — 6 fast multi-client integration cases
  against the live worker, plus 2 long-running auto-rejoin cases behind
  `FULL=1`.
- Daily `cf-usage.yml` GitHub Actions workflow that queries the Cloudflare
  GraphQL Analytics API and opens an issue when consumption exceeds 80 % of
  the Workers free tier.
- `prefers-reduced-motion` support across HUD effects, screen shake, and
  damage vignette.
- Audio suspends when the tab is hidden (saves CPU on backgrounded sessions).
- Pages Function (`functions/ws.ts`) for same-origin WebSocket forwarding to
  the Worker.
- Open Graph / Twitter card meta tags, web app manifest, apple-touch-icon.
- Per-socket WebSocket rate limit and message-size cap on the server.
- Room-name validation (alphanumeric, length-capped) to prevent DO spam.
- CSP, HSTS, and other security headers via Pages `_headers`.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates.
- `.env.example` documenting `VITE_SERVER_URL`.

### Changed
- **Lobby auto-start removed.** The 20 s / 12 s timer that fired regardless
  of whether anyone wanted to play is gone. Players control the launch via
  the per-player Ready toggle (race auto-starts when everyone's ticked) or
  the host's Start Now override.
- **Server tick rate stays at 10 Hz** with client input rate matched — a
  brief experiment at 5 Hz (to maximise free-tier headroom) made the racing
  feel noticeably mushy in real play, so it was reverted. `INTERP_DELAY_MS`
  is 100 ms (one full tick) for smooth interpolation without making inputs
  feel laggy. Drop both rates if free-tier consumption ever becomes a
  problem.
- Outer Worker → Durable Object subfetch now forwards every query param
  except `?room=` (was stripping `?session=` and `?spectator=`, which
  broke reconnection and made spectator mode unreachable).
- Production sourcemaps disabled (`sourcemap: false`) — `'hidden'` still
  uploaded the `.map` files to Pages where they were publicly fetchable.
- Vendor split: `react`/`react-dom` extracted into a separate chunk.
- `wrangler.toml` no longer hardcodes an account id; configure via the
  `CLOUDFLARE_ACCOUNT_ID` env var instead.
- `scripts/smoke-test.mjs` requires `SMOKE_URL`, uses Node 22+ native
  `WebSocket`, hits a dedicated `?room=smoke` so it never collides with
  real player traffic, and skips `fast=1` so it doesn't trigger a full
  ~1900-DO-request race per CI run (now ~5 DO requests per run).

### Fixed
- Sourcemaps were being served from Pages even with `sourcemap: 'hidden'`
  — anyone who knew the bundle hash could fetch `<bundle>.map` and read
  source. Now disabled outright in production builds.

## [0.1.0] - 2026-05-05

Initial public release.

- 99-player synthwave anti-grav battle-royale racing.
- 3 tracks, 3 ship classes, pickups, KO meter, Skyway, perfect-start.
- Cloudflare Worker + Durable Object backend; React 19 + Canvas 2D client.
- Touch controls, mobile-ready, personal best persistence.
