import { useEffect, useRef } from 'react';
import { GameSocket, resolveServerUrl } from '../net/socket.ts';
import type { Action } from '../state.ts';
import type { ClientMessage } from '../../shared/protocol.ts';

export type SocketAPI = {
  send: (msg: ClientMessage) => void;
  connect: () => void;
  disconnect: () => void;
};

export const useGameSocket = (
  dispatch: (a: Action) => void,
  enabled: boolean,
  trackId: string,
  pseudo: string,
  color: string,
): SocketAPI => {
  const ref = useRef<GameSocket | null>(null);
  const sentHello = useRef(false);

  useEffect(() => {
    if (!enabled) {
      ref.current?.disconnect();
      ref.current = null;
      return;
    }
    if (ref.current) return;
    sentHello.current = false;
    const sock = new GameSocket({
      onOpen: () => {
        dispatch({ type: 'CONNECTED' });
        if (!sentHello.current) {
          sock.send({ type: 'hello', name: pseudo, color });
          sentHello.current = true;
        }
      },
      onMessage: (msg) => dispatch({ type: 'SERVER_MESSAGE', message: msg, receivedAt: performance.now() }),
      onClose: () => dispatch({ type: 'DISCONNECTED' }),
      onError: () => dispatch({ type: 'CONNECTION_ERROR', error: 'connection error' }),
    });
    ref.current = sock;
    dispatch({ type: 'CONNECTING' });
    sock.connect(buildUrl(trackId));
    return () => {
      sock.disconnect();
      ref.current = null;
    };
  }, [enabled, trackId, pseudo, color, dispatch]);

  return {
    send: (msg) => ref.current?.send(msg),
    connect: () => {
      ref.current?.connect(buildUrl(trackId));
    },
    disconnect: () => ref.current?.disconnect(),
  };
};

const buildUrl = (trackId: string): string => {
  const base = `${resolveServerUrl()}?track=${encodeURIComponent(trackId)}`;
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fast') === '1') return `${base}&fast=1`;
  }
  return base;
};
