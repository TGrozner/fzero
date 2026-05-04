import type { Action } from '../state.ts';
import { SHIP_CLASSES, SHIP_COLORS, type ShipClass } from '../../shared/constants.ts';
import { TRACKS } from '../../shared/track.ts';

type Props = {
  pseudo: string;
  color: string;
  trackId: string;
  cls: ShipClass;
  roomName: string;
  volume: number;
  music: boolean;
  onTrackChange: (id: string) => void;
  onStart: () => void;
  dispatch: (a: Action) => void;
  busy: boolean;
};

const CLASS_INFO: Record<ShipClass, { label: string; tagline: string }> = {
  speed: { label: 'Speed', tagline: 'Top speed +14%, slower turns, lighter HP' },
  tank: { label: 'Tank', tagline: 'Tightest steering, sturdier walls, lower top speed' },
  balanced: { label: 'Balanced', tagline: 'No-fuss baseline, best for new pilots' },
};

export function Menu({
  pseudo,
  color,
  trackId,
  cls,
  roomName,
  volume,
  music,
  onTrackChange,
  onStart,
  dispatch,
  busy,
}: Props) {
  const canStart = pseudo.trim().length >= 1 && !busy;
  return (
    <div className="menu" data-testid="menu">
      <h1>F-ZERO 99</h1>
      <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        <label htmlFor="pseudo">Pilot name</label>
        <input
          id="pseudo"
          data-testid="pseudo-input"
          type="text"
          maxLength={16}
          value={pseudo}
          autoFocus
          onChange={(e) => dispatch({ type: 'SET_PSEUDO', pseudo: e.target.value })}
          placeholder="Enter your callsign"
        />
      </div>
      <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <label>Ship color</label>
        <div className="color-row">
          {SHIP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch${c === color ? ' selected' : ''}`}
              data-testid={`color-${c}`}
              aria-label={`Select color ${c}`}
              onClick={() => dispatch({ type: 'SET_COLOR', color: c })}
              style={{ background: c, color: c, padding: 0 }}
            />
          ))}
        </div>
      </div>
      <div
        className="row"
        style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
        data-testid="class-picker"
      >
        <label>Ship class</label>
        <div className="class-row">
          {SHIP_CLASSES.map((c) => {
            const info = CLASS_INFO[c];
            return (
              <button
                key={c}
                type="button"
                data-testid={`class-${c}`}
                aria-pressed={c === cls}
                className={`class-chip${c === cls ? ' selected' : ''}`}
                onClick={() => dispatch({ type: 'SET_CLASS', cls: c })}
              >
                <span className="class-label">{info.label}</span>
                <span className="class-tagline">{info.tagline}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <label htmlFor="track">Track</label>
        <select
          id="track"
          data-testid="track-select"
          value={trackId}
          onChange={(e) => onTrackChange(e.target.value)}
          style={{
            background: 'rgba(255,255,255,0.06)',
            color: 'var(--text)',
            border: '1px solid rgba(255,255,255,0.15)',
            padding: '8px',
            borderRadius: 4,
          }}
        >
          {TRACKS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        <label htmlFor="room">Room (optional)</label>
        <input
          id="room"
          data-testid="room-input"
          type="text"
          maxLength={24}
          value={roomName}
          onChange={(e) =>
            dispatch({
              type: 'SET_ROOM',
              roomName: e.target.value.replace(/[^A-Za-z0-9_-]/g, ''),
            })
          }
          placeholder="Leave blank for global lobby"
        />
      </div>
      <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        <label htmlFor="volume">
          Volume <span style={{ color: 'var(--text)' }}>{Math.round(volume * 100)}%</span>
        </label>
        <input
          id="volume"
          data-testid="volume-input"
          type="range"
          min={0}
          max={100}
          value={Math.round(volume * 100)}
          onChange={(e) =>
            dispatch({ type: 'SET_VOLUME', volume: Number(e.target.value) / 100 })
          }
        />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            margin: 0,
            textTransform: 'none',
            letterSpacing: 0,
            fontSize: 13,
            color: 'var(--text)',
          }}
        >
          <input
            data-testid="music-input"
            type="checkbox"
            checked={music}
            onChange={(e) => dispatch({ type: 'SET_MUSIC', music: e.target.checked })}
          />
          Music
        </label>
      </div>
      <button
        data-testid="race-button"
        onClick={onStart}
        disabled={!canStart}
        style={{ marginTop: 8 }}
      >
        {busy ? 'Connecting…' : 'Race'}
      </button>
      <div className="controls-help">
        WASD / Arrows to drive · Shift boost · Q/E side attack · Enter spin attack · Space skyway · P pause · Esc menu
      </div>
    </div>
  );
}
