import {
  type ClientMessage,
  type ServerMessage,
  decodeServer,
  encode,
} from '../../shared/protocol.ts';

const DEFAULT_DEV_URL = 'ws://127.0.0.1:8787/ws';

export const resolveServerUrl = (): string => {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const fromEnv = env?.['VITE_SERVER_URL'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return DEFAULT_DEV_URL;
    }
    return `${proto}://${window.location.host}/ws`;
  }
  return DEFAULT_DEV_URL;
};

export type SocketHandlers = {
  onOpen: () => void;
  onMessage: (msg: ServerMessage) => void;
  onClose: () => void;
  onError: (err: Event) => void;
};

export class GameSocket {
  private ws: WebSocket | null = null;
  private handlers: SocketHandlers;

  constructor(handlers: SocketHandlers) {
    this.handlers = handlers;
  }

  connect(url: string): void {
    if (this.ws) this.disconnect();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('open', () => this.handlers.onOpen());
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      const msg = decodeServer(e.data);
      if (msg) this.handlers.onMessage(msg);
    });
    ws.addEventListener('close', () => {
      this.handlers.onClose();
      this.ws = null;
    });
    ws.addEventListener('error', (e) => this.handlers.onError(e));
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode(msg));
  }

  disconnect(): void {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }
}
