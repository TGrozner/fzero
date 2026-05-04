import { useReducer, useState, useCallback } from 'react';
import { reducer, buildInitialClientState } from './state.ts';
import { Menu } from './components/Menu.tsx';
import { Lobby } from './components/Lobby.tsx';
import { Race } from './components/Race.tsx';
import { Results } from './components/Results.tsx';
import { useGameSocket } from './hooks/useGameSocket.ts';

const STORAGE_KEY = 'fzero99:profile';

const loadProfile = (): { pseudo: string; color: string; trackId: string; roomName: string } => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { pseudo: '', color: '#3aa0ff', trackId: 'mute-avenue', roomName: '' };
    const obj = JSON.parse(raw) as {
      pseudo?: string;
      color?: string;
      trackId?: string;
      roomName?: string;
    };
    return {
      pseudo: obj.pseudo ?? '',
      color: obj.color ?? '#3aa0ff',
      trackId: obj.trackId ?? 'mute-avenue',
      roomName: obj.roomName ?? '',
    };
  } catch {
    return { pseudo: '', color: '#3aa0ff', trackId: 'mute-avenue', roomName: '' };
  }
};

export function App() {
  const profile = loadProfile();
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    ...buildInitialClientState(),
    pseudo: profile.pseudo,
    color: profile.color,
    trackId: profile.trackId,
    roomName: profile.roomName,
  }));
  const [connectRequested, setConnectRequested] = useState(false);

  const persist = useCallback(
    (pseudo: string, color: string, trackId: string, roomName: string) => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ pseudo, color, trackId, roomName }),
        );
      } catch {
        // ignore
      }
    },
    [],
  );

  const socket = useGameSocket(
    dispatch,
    connectRequested,
    state.trackId,
    state.pseudo,
    state.color,
    state.roomName,
  );

  const handleStart = useCallback(() => {
    persist(state.pseudo, state.color, state.trackId, state.roomName);
    setConnectRequested(true);
  }, [persist, state.pseudo, state.color, state.trackId, state.roomName]);

  const handleLeave = useCallback(() => {
    setConnectRequested(false);
    socket.disconnect();
    dispatch({ type: 'SET_VIEW', view: 'menu' });
  }, [socket]);

  const handleAgain = useCallback(() => {
    setConnectRequested(false);
    socket.disconnect();
    setTimeout(() => setConnectRequested(true), 120);
  }, [socket]);

  return (
    <div className="app">
      {state.error && (
        <div className="error-banner" data-testid="error-banner">{state.error}</div>
      )}
      {state.view === 'menu' && (
        <Menu
          pseudo={state.pseudo}
          color={state.color}
          trackId={state.trackId}
          roomName={state.roomName}
          onTrackChange={(id) => dispatch({ type: 'SET_TRACK', trackId: id })}
          onStart={handleStart}
          dispatch={dispatch}
          busy={state.status === 'connecting'}
        />
      )}
      {state.view === 'lobby' && (
        <Lobby
          trackId={state.trackId}
          players={Object.values(state.players)}
          startsIn={state.startsIn}
          onCancel={handleLeave}
        />
      )}
      {state.view === 'race' && (
        <Race state={state} dispatch={dispatch} socket={socket} onLeave={handleLeave} />
      )}
      {state.view === 'results' && (
        <Results state={state} onAgain={handleAgain} onMenu={handleLeave} />
      )}
    </div>
  );
}
