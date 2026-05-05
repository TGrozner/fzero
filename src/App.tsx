import {
  useReducer,
  useRef,
  useState,
  useCallback,
  useEffect,
  lazy,
  Suspense,
} from 'react';
import { reducer, buildInitialClientState } from './state.ts';
import { Menu } from './components/Menu.tsx';
import { Lobby } from './components/Lobby.tsx';
import { Results } from './components/Results.tsx';
import { useGameSocket } from './hooks/useGameSocket.ts';
import { getMixer } from './audio/mixer.ts';
import {
  applyRaceOutcome,
  loadCareerStats,
  saveCareerStats,
} from './storage/careerStats.ts';
import {
  DEFAULT_SHIP_CLASS,
  SHIP_CLASSES,
  type ShipClass,
} from '../shared/constants.ts';

// Race carries the renderer + audio loop + most of the game-only code.
// Splitting it out shrinks the menu landing chunk by ~40%.
const Race = lazy(() =>
  import('./components/Race.tsx').then((m) => ({ default: m.Race })),
);

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
  const [connectAsSpectator, setConnectAsSpectator] = useState(false);
  const lastRecordedResultsRef = useRef<readonly unknown[] | null>(null);

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

  // Pause audio when the tab is hidden so backgrounded sessions don't keep
  // the AudioContext spinning. requestAnimationFrame already pauses naturally,
  // so the render loop and input loop are handled by the browser.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) getMixer().suspend();
      else getMixer().unlock();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
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
    connectAsSpectator,
  );

  const handleStart = useCallback(async () => {
    getMixer().unlock();
    // Pre-flight the room: if a race is already in progress we silently
    // connect as a spectator so the user lands in the action right away
    // (and gets auto-promoted into the next race).
    let asSpectator = false;
    try {
      const baseUrl = (() => {
        const env = (import.meta as { env?: Record<string, string | undefined> }).env;
        const fromEnv = env?.['VITE_SERVER_URL'];
        if (fromEnv) return fromEnv.replace(/^wss?:\/\//, 'https://').replace(/\/ws.*$/, '');
        if (typeof window !== 'undefined') {
          if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
            return 'http://127.0.0.1:8787';
          }
          return window.location.origin;
        }
        return '';
      })();
      const room = state.roomName ? `?room=${encodeURIComponent(state.roomName)}` : '';
      const res = await fetch(`${baseUrl}/status${room}`);
      if (res.ok) {
        const j: { phase: string } = await res.json();
        asSpectator = j.phase !== 'WAITING';
      }
    } catch {
      // /status is best-effort; if it fails, attempt as a regular player.
    }
    setConnectAsSpectator(asSpectator);
    setConnectRequested(true);
  }, [state.roomName]);

  const handleLeave = useCallback(() => {
    setConnectRequested(false);
    setConnectAsSpectator(false);
    socket.disconnect();
    dispatch({ type: 'SET_VIEW', view: 'menu' });
  }, [socket]);

  // The server now auto-promotes connected results-screen viewers when the
  // FINISHED → WAITING cooldown elapses, so we can just send everyone back
  // to the lobby view and let the welcome arrive naturally. Falls back to a
  // hard reconnect if the connection somehow died.
  const handleAgain = useCallback(() => {
    if (state.status === 'connected') {
      dispatch({ type: 'SET_VIEW', view: 'lobby' });
      return;
    }
    setConnectRequested(false);
    setConnectAsSpectator(false);
    socket.disconnect();
    setTimeout(() => setConnectRequested(true), 120);
  }, [socket, state.status]);

  // Lobby ping: 30 s cadence so other players see your RTT next to your name.
  // Race already pings every 10 s for the local HUD; this just keeps something
  // ticking while we're sitting in the lobby waiting to ready up.
  useEffect(() => {
    if (state.view !== 'lobby' || state.status !== 'connected') return;
    const sendPing = () => socket.send({ type: 'ping', ts: performance.now() });
    sendPing();
    const t = window.setInterval(sendPing, 30_000);
    return () => window.clearInterval(t);
  }, [state.view, state.status, socket]);

  // Forward our measured RTT to the server so the lobby player list can show
  // every human's ping. Throttled by setRtt() server-side (≥10 ms change).
  useEffect(() => {
    if (state.rttMs === null || state.status !== 'connected') return;
    socket.send({ type: 'set_rtt', rtt: state.rttMs });
  }, [state.rttMs, state.status, socket]);

  // Career-stats accumulation. Fires once per race when results land — guard
  // by reference equality on the standings array so a re-render or a re-entry
  // of the results screen doesn't double-count. Reads localStorage fresh
  // each fire instead of holding a copy in React state, so the Menu (which
  // also reads on every render) stays in sync without a re-render loop.
  useEffect(() => {
    if (state.view !== 'results' || state.standings.length === 0) return;
    if (lastRecordedResultsRef.current === state.standings) return;
    lastRecordedResultsRef.current = state.standings;
    const me = state.myId
      ? state.standings.find((s) => s.id === state.myId) ?? null
      : null;
    if (!me) return;
    const next = applyRaceOutcome(loadCareerStats(), {
      position: me.ko ? null : me.position,
      ko: me.ko,
      kosScored: state.myKosThisRace,
      totalRacers: state.standings.length,
    });
    saveCareerStats(next);
  }, [state.view, state.standings, state.myId, state.myKosThisRace]);

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
          laps={state.laps}
          players={Object.values(state.players)}
          myId={state.myId}
          roomName={state.roomName}
          onCancel={handleLeave}
          onStartNow={() => socket.send({ type: 'start_now' })}
          onSetReady={(ready) => socket.send({ type: 'set_ready', ready })}
          onSetTrack={(trackId) => socket.send({ type: 'set_track', trackId })}
          onSetClass={(cls) => socket.send({ type: 'set_class', cls })}
          onSetLaps={(n) => socket.send({ type: 'set_laps', laps: n })}
        />
      )}
      {state.view === 'race' && (
        <Suspense fallback={<div className="lobby-screen"><div className="pulse">LOADING…</div></div>}>
          <Race state={state} dispatch={dispatch} socket={socket} onLeave={handleLeave} />
        </Suspense>
      )}
      {state.view === 'results' && (
        <Results state={state} onAgain={handleAgain} onMenu={handleLeave} />
      )}
    </div>
  );
}
