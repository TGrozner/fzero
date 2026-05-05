# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres loosely to [SemVer](https://semver.org/).

## [Unreleased]

### Added
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
- Production sourcemaps are now `hidden` (no `//# sourceMappingURL=` reference
  in shipped bundles) to avoid exposing source code in devtools.
- Vendor split: `react`/`react-dom` extracted into a separate chunk.
- `wrangler.toml` no longer hardcodes an account id; configure via the
  `CLOUDFLARE_ACCOUNT_ID` env var instead.
- `scripts/smoke-test.mjs` requires `SMOKE_URL` and no longer hardcodes a
  personal subdomain.

## [0.1.0] - 2026-05-05

Initial public release.

- 99-player synthwave anti-grav battle-royale racing.
- 3 tracks, 3 ship classes, pickups, KO meter, Skyway, perfect-start.
- Cloudflare Worker + Durable Object backend; React 19 + Canvas 2D client.
- Touch controls, mobile-ready, personal best persistence.
