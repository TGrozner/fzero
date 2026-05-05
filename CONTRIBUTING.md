# Contributing to Neon Drift

Thanks for taking the time to chip in. This is a small focused project, so the
guidelines stay simple.

## Workflow

1. Fork the repo.
2. Create a feature branch from `main`.
3. Run `npm install`.
4. Develop in TypeScript — strict mode is on, including `noUncheckedIndexedAccess`.
5. Before opening a PR, run:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   npm run build
   ```
   The full set is also wired into CI on every PR.
6. Open a PR against `main`. CI will run unit tests, type check, lint, build, and
   Playwright e2e.

## Style

- Prettier + ESLint enforced; `npm run format` applies the project style.
- One concern per PR. Smaller is better.
- Commits use conventional-ish prefixes already visible in `git log` (`feat:`,
  `fix:`, `perf:`, `chore:`). Match what's there — no strict spec required.

## Tests

- Pure logic (`shared/`) is covered by Vitest unit tests with an 85% coverage
  floor. Add tests for new mechanics there.
- React components have light component tests under `src/`.
- Playwright e2e specs live in `e2e/`. Keep them fast and deterministic.

## Architecture

See [README.md](README.md). The `shared/` directory is the source of truth for
game rules; both client and server import from it. Don't fork rules into the
server — extend `shared/` instead.

## Reporting bugs / requesting features

Use GitHub issues. A short repro (steps + expected/actual) saves a lot of time.

## Security

Please don't file public issues for security problems — see [SECURITY.md](SECURITY.md).
