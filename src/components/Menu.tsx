import type { Action } from '../state.ts';
import { SHIP_COLORS } from '../../shared/constants.ts';
import { TRACKS } from '../../shared/track.ts';

type Props = {
  pseudo: string;
  color: string;
  trackId: string;
  roomName: string;
  onTrackChange: (id: string) => void;
  onStart: () => void;
  dispatch: (a: Action) => void;
  busy: boolean;
};

export function Menu({
  pseudo,
  color,
  trackId,
  roomName,
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
