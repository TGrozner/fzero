import { useReducer, useState, useCallback, useEffect } from 'react';
import { reducer, buildInitialClientState } from './state.ts';
import { Menu } from './components/Menu.tsx';
import { Lobby } from './components/Lobby.tsx';
import { Race } from './components/Race.tsx';
import { Results } from './components/Results.tsx';
import { useGameSocket } from './hooks/useGameSocket.ts';
import { getMixer } from './audio/mixer.ts';
import {
  DEFAULT_SHIP_CLASS,
  SHIP_CLASSES,
  type ShipClass,
} from '../shared/constants.ts';

const STORAGE_KEY = 'neon-drift:profile';

type Profile = {
  pseudo: string;
  color: string;
  trackId: string;
  cls: ShipClass;
  roomName: string;
  volume: number;
  music: boolean;
};

const sanitizeClass = (raw: unknown): ShipClass =>
  SHIP_CLASSES.includes(raw as ShipClass) ? (raw as ShipClass) : DEFAULT_SHIP_CLASS;

const loadProfile = (): Profile => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        pseudo: '',
        color: '#3aa0ff',
        trackId: 'mute-avenue',
        cls: DEFAULT_SHIP_CLASS,
        roomName: '',
        volume: 0.6,
        music: true,
      };
    }
    const obj = JSON.parse(raw) as Partial<Profile> & { cls?: unknown };
    return {
      pseudo: obj.pseudo ?? '',
      color: obj.color ?? '#3aa0ff',
      trackId: obj.trackId ?? 'mute-avenue',
      cls: sanitizeClass(obj.cls),
      roomName: obj.roomName ?? '',
      volume: typeof obj.volume === 'number' ? obj.volume : 0.6,
      music: obj.music !== false,
    };
  } catch {
    return {
      pseudo: '',
      color: '#3aa0ff',
      trackId: 'mute-avenue',
      cls: DEFAULT_SHIP_CLASS,
      roomName: '',
      volume: 0.6,
      music: true,
    };
  }
};

export function App() {
  const profile = loadProfile();
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    ...buildInitialClientState(),
    pseudo: profile.pseudo,
    color: profile.color,
    trackId: profile.trackId,
    cls: profile.cls,
    roomName: profile.roomName,
    volume: profile.volume,
    music: profile.music,
  }));
  const [connectRequested, setConnectRequested] = useState(false);

  // Push audio settings to the singleton mixer whenever they change.
  useEffect(() => {
    const m = getMixer();
    m.setVolume(state.volume);
    m.setMusicEnabled(state.music);
  }, [state.volume, state.music]);

  // Best-effort: unlock the audio context on the first user gesture.
  useEffect(() => {
    const onGesture = () => {
      getMixer().unlock();
    };
    window.addEventListener('pointerdown', onGesture, { once: true });
    window.addEventListener('keydown', onGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onGesture);
      window.removeEventListener('keydown', onGesture);
    };
  }, []);

  const persist = useCallback(
    (p: Omit<Profile, never>) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
      } catch {
        // ignore
      }
    },
    [],
  );

  // Persist whenever any setting changes (debounced naturally by React batching).
  useEffect(() => {
    persist({
      pseudo: state.pseudo,
      color: state.color,
      trackId: state.trackId,
      cls: state.cls,
      roomName: state.roomName,
      volume: state.volume,
      music: state.music,
    });
  }, [
    persist,
    state.pseudo,
    state.color,
    state.trackId,
    state.cls,
    state.roomName,
    state.volume,
    state.music,
  ]);

  const socket = useGameSocket(
    dispatch,
    connectRequested,
    state.trackId,
    state.pseudo,
    state.color,
    state.roomName,
    state.cls,
  );

  const handleStart = useCallback(() => {
    setConnectRequested(true);
    getMixer().unlock();
  }, []);

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
          cls={state.cls}
          roomName={state.roomName}
          volume={state.volume}
          music={state.music}
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
          roomName={state.roomName}
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
