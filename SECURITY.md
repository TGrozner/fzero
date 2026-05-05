# Security Policy

## Supported versions

Only the latest commit on `main` is supported. There are no LTS releases.

## Reporting a vulnerability

Please report security issues **privately** rather than via a public GitHub
issue. The fastest channel is a GitHub security advisory:

- https://github.com/TGrozner/neon-drift/security/advisories/new

Include:

- A clear description of the vulnerability.
- Steps to reproduce, ideally with a minimal proof of concept.
- The impact you believe it has (data exposure, abuse vector, denial of service, etc).

You will get an acknowledgement within 7 days. If a fix is needed, we will
coordinate a release before public disclosure.

## Scope

This project includes a Cloudflare Worker, a Cloudflare Pages site, and a
WebSocket protocol. In-scope issues include:

- Remote code execution or unauthenticated state corruption in the Worker / DO.
- Abuse vectors that could exhaust the Cloudflare free-tier quota (e.g. DO
  request amplification, room-spawning, message floods that bypass the
  per-socket rate limit).
- XSS, content injection, or auth bypass in the client.
- Memory or storage leaks in the Durable Object.

Out of scope: bugs that only affect non-default configurations, theoretical
issues without a proof of concept, social-engineering attacks.
