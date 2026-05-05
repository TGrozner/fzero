/**
 * Pages Function — forwards `/ws` to the Workers backend so the client can use
 * a same-origin WebSocket URL.
 *
 * Configure on the Pages project:
 *   WORKER_URL=https://<your-worker>.workers.dev
 *
 * If `WORKER_URL` is unset, returns 503 — set `VITE_SERVER_URL` at build time
 * instead and the client will connect directly to the Worker (one less hop,
 * and one less Pages Function invocation per session).
 */

interface Env {
  WORKER_URL?: string;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const target = env.WORKER_URL;
  if (!target) {
    return new Response(
      'WORKER_URL is not configured on this Pages project. Either set WORKER_URL ' +
        'to forward /ws to your Worker, or set VITE_SERVER_URL at build time so ' +
        'the client connects to the Worker directly.',
      { status: 503 },
    );
  }
  const incoming = new URL(request.url);
  const fwd = new URL('/ws', target);
  fwd.search = incoming.search;
  return fetch(fwd.toString(), request);
};
