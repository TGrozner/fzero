import { MAX_RACERS } from '../../shared/constants.ts';
import type { ClientState } from '../state.ts';

type Props = {
  state: ClientState;
  onAgain: () => void;
  onMenu: () => void;
};

export function Results({ state, onAgain, onMenu }: Props) {
  const ranking = state.standings;
  const top = ranking.slice(0, 10);
  const me = ranking.find((s) => s.id === state.myId) ?? null;
  return (
    <div className="results-screen" data-testid="results">
      <div className="results-card">
        <h2>Race Results</h2>
        <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
          {state.players[state.myId ?? '']?.name ?? 'You'} ·{' '}
          {me?.position ? `Finished ${ordinal(me.position)} / ${MAX_RACERS}` : 'No standing'}
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
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button onClick={onAgain}>Race again</button>
          <button onClick={onMenu}>Menu</button>
        </div>
      </div>
    </div>
  );
}

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
