import { useEffect, useRef } from 'react';
import { GameSocket, resolveServerUrl } from '../net/socket.ts';
import type { Action } from '../state.ts';
import type { ClientMessage } from '../../shared/protocol.ts';

export type SocketAPI = {
  send: (msg: ClientMessage) => void;
  connect: () => void;
  disconnect: () => void;
};

const SESSION_KEY = 'fzero99:session';

export const getOrCreateSession = (): string => {
  if (typeof window === 'undefined') return 'dev';
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const token =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    sessionStorage.setItem(SESSION_KEY, token);
    return token;
  } catch {
    return `s${Math.random().toString(36).slice(2)}`;
  }
};

const RECONNECT_BACKOFF_MS = [400, 800, 1600, 3200];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

export const useGameSocket = (
  dispatch: (a: Action) => void,
  enabled: boolean,
  trackId: string,
  pseudo: string,
  color: string,
  roomName: string,
): SocketAPI => {
  const ref = useRef<GameSocket | null>(null);
  const sessionRef = useRef<string>(getOrCreateSession());
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      if (reconnectTimer.current !== null) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      reconnectAttempts.current = 0;
      ref.current?.disconnect();
      ref.current = null;
      return;
    }
    if (ref.current) return;
    const open = (): void => {
      const sock = new GameSocket({
        onOpen: () => {
          dispatch({ type: 'CONNECTED' });
          reconnectAttempts.current = 0;
          sock.send({
            type: 'hello',
            name: pseudo,
            color,
            session: sessionRef.current,
          });
        },
        onMessage: (msg) =>
          dispatch({ type: 'SERVER_MESSAGE', message: msg, receivedAt: performance.now() }),
        onClose: () => {
          dispatch({ type: 'DISCONNECTED' });
          ref.current = null;
          // Auto-reconnect: only retry while the user still wants to be connected
          // and we haven't exhausted backoff slots.
          if (
            enabledRef.current &&
            reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS
          ) {
            const delay =
              RECONNECT_BACKOFF_MS[reconnectAttempts.current] ?? 3200;
            reconnectAttempts.current += 1;
            reconnectTimer.current = window.setTimeout(() => {
              reconnectTimer.current = null;
              if (enabledRef.current && !ref.current) open();
            }, delay);
          }
        },
        onError: () => dispatch({ type: 'CONNECTION_ERROR', error: 'connection error' }),
      });
      ref.current = sock;
      dispatch({ type: 'CONNECTING' });
      sock.connect(buildUrl(trackId, sessionRef.current, roomName));
    };
    open();
    return () => {
      if (reconnectTimer.current !== null) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      ref.current?.disconnect();
      ref.current = null;
    };
  }, [enabled, trackId, pseudo, color, roomName, dispatch]);

  return {
    send: (msg) => ref.current?.send(msg),
    connect: () => {
      ref.current?.connect(buildUrl(trackId, sessionRef.current, roomName));
    },
    disconnect: () => {
      if (reconnectTimer.current !== null) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      reconnectAttempts.current = MAX_RECONNECT_ATTEMPTS;
      ref.current?.disconnect();
      ref.current = null;
    },
  };
};

const buildUrl = (trackId: string, session: string, roomName: string): string => {
  let base = `${resolveServerUrl()}?track=${encodeURIComponent(trackId)}`;
  base += `&session=${encodeURIComponent(session)}`;
  if (roomName) base += `&room=${encodeURIComponent(roomName)}`;
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fast') === '1') base += '&fast=1';
    // URL-supplied room overrides the prop (back-compat).
    const urlRoom = params.get('room');
    if (urlRoom) base = base.replace(/&room=[^&]*/, '') + `&room=${encodeURIComponent(urlRoom)}`;
  }
  return base;
};
