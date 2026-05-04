import { MAX_RACERS } from '../../shared/constants.ts';
import type { ClientState } from '../state.ts';
import { findTrack } from '../../shared/track.ts';

type Props = {
  state: ClientState;
  onAgain: () => void;
  onMenu: () => void;
};

export function Results({ state, onAgain, onMenu }: Props) {
  const ranking = state.standings;
  const top = ranking.slice(0, 10);
  const me = ranking.find((s) => s.id === state.myId) ?? null;
  const recent = state.koLog.slice(-6).reverse();
  const myScored = state.koLog.filter((k) => k.by === state.myId).length;
  return (
    <div className="results-screen" data-testid="results">
      <div className="results-card">
        <h2>Race Results</h2>
        <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          {state.players[state.myId ?? '']?.name ?? 'You'} ·{' '}
          {me?.position ? `Finished ${ordinal(me.position)} / ${MAX_RACERS}` : 'No standing'}
          {myScored > 0 ? ` · ${myScored} KO${myScored > 1 ? 's' : ''}` : ''}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="results-row" style={{ fontSize: 11, color: 'var(--muted)' }}>
            <span>#</span>
            <span>Pilot</span>
            <span>Time</span>
            <span>State</span>
          </div>
          {top.map((s) => {
            const player = state.players[s.id];
            return (
              <div
                key={s.id}
                className={`results-row${s.id === state.myId ? ' you' : ''}`}
                data-testid={`results-row-${s.id}`}
              >
                <span>{s.position}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: player?.color ?? '#888',
                    }}
                  />
                  {player?.name ?? s.id}
                </span>
                <span>{s.finishTime !== null ? `${s.finishTime.toFixed(2)}s` : '—'}</span>
                <span>{s.ko ? 'KO' : s.finishTime !== null ? 'Fin' : '—'}</span>
              </div>
            );
          })}
        </div>
        {me && me.position > 10 && (
          <div className="results-row you">
            <span>{me.position}</span>
            <span>{state.players[me.id]?.name ?? me.id}</span>
            <span>{me.finishTime !== null ? `${me.finishTime.toFixed(2)}s` : '—'}</span>
            <span>{me.ko ? 'KO' : me.finishTime !== null ? 'Fin' : '—'}</span>
          </div>
        )}
        {recent.length > 0 && (
          <div data-testid="ko-replay">
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>
              Recent eliminations
            </div>
            <KoReplayMap state={state} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {recent.map((ko) => {
                const victim = state.players[ko.id];
                const attacker = ko.by ? state.players[ko.by] : null;
                const isMyKill = ko.by === state.myId;
                return (
                  <div
                    key={`${ko.id}-${ko.time}`}
                    className="results-row"
                    data-testid={`ko-${ko.id}`}
                    style={
                      isMyKill
                        ? { borderColor: 'rgba(255, 210, 58, 0.5)', background: 'rgba(255, 210, 58, 0.06)' }
                        : undefined
                    }
                  >
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {`${ko.time.toFixed(1)}s`}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Dot color={attacker?.color ?? '#666'} />
                      {attacker?.name ?? (ko.by ? ko.by : 'Track')}
                    </span>
                    <span style={{ color: 'var(--muted)' }}>KO →</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Dot color={victim?.color ?? '#666'} />
                      {victim?.name ?? ko.id}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button onClick={onAgain}>Race again</button>
          <button onClick={onMenu}>Menu</button>
        </div>
      </div>
    </div>
  );
}

const Dot = ({ color }: { color: string }): React.JSX.Element => (
  <span
    style={{
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: color,
      display: 'inline-block',
    }}
  />
);

/**
 * Tiny SVG showing where each recent KO happened on the track outline.
 * No animation — just a static "highlights" recap.
 */
const KoReplayMap = ({ state }: { state: ClientState }): React.JSX.Element | null => {
  let track;
  try {
    track = findTrack(state.trackId);
  } catch {
    return null;
  }
  // Compute bounds.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of track.centerline) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = track.halfWidth + 16;
  minX -= pad;
  maxX += pad;
  minY -= pad;
  maxY += pad;
  const w = maxX - minX;
  const h = maxY - minY;
  const W = 280;
  const H = Math.max(80, Math.round((W * h) / w));
  const xform = (x: number, y: number): [number, number] => [
    ((x - minX) / w) * W,
    ((y - minY) / h) * H,
  ];
  const path = track.centerline
    .map((p, i) => {
      const [x, y] = xform(p.x, p.y);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ') + ' Z';
  return (
    <svg
      data-testid="ko-replay-map"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: 'block', margin: '0 auto', marginBottom: 8 }}
    >
      <path
        d={path}
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth={track.halfWidth * (W / w)}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d={path} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={1} />
      {state.koLog.map((ko, i) => {
        if (ko.x === null || ko.y === null) return null;
        const [cx, cy] = xform(ko.x, ko.y);
        const attackerColor = ko.by ? state.players[ko.by]?.color ?? '#888' : '#aaa';
        return (
          <g key={`${ko.id}-${i}`}>
            <circle cx={cx} cy={cy} r={5} fill={attackerColor} opacity={0.85} />
            <circle cx={cx} cy={cy} r={2.5} fill="#0a0524" />
          </g>
        );
      })}
    </svg>
  );
};

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
