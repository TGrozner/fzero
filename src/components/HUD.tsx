import { findMyShip, type ClientState, myPosition, liveLeaderboard } from '../state.ts';
import {
  MAX_RACERS,
  SIDE_ATTACK_COOLDOWN_S,
  SPIN_ATTACK_COOLDOWN_S,
} from '../../shared/constants.ts';

type Props = {
  state: ClientState;
};

export function HUD({ state }: Props) {
  const ship = findMyShip(state);
  const pos = myPosition(state);
  const time = state.snapshots[state.snapshots.length - 1]?.time ?? 0;
  if (!ship) return null;
  const power = Math.max(0, ship.p);
  const ko = Math.max(0, ship.k);
  const koReady = ko >= 0.999;
  const powerLow = power < 0.25;
  const speed = Math.hypot(ship.vx, ship.vy);
  const spinFrac = 1 - Math.max(0, ship.sc) / SPIN_ATTACK_COOLDOWN_S;
  const sideFrac = 1 - Math.max(0, ship.dc) / SIDE_ATTACK_COOLDOWN_S;
  return (
    <div className="hud" data-testid="hud">
      <div className="hud-top">
        <div className="position" data-testid="position">
          {pos ?? '-'}
          <span className="total">/{MAX_RACERS}</span>
        </div>
        <div className="lap" data-testid="lap">
          Lap {ship.l + 1}/{state.laps}
        </div>
        <div className="time" data-testid="time">
          {formatTime(time)}
        </div>
        <div className="speed" data-testid="speed">
          {Math.round(speed)}
          <span className="speed-unit"> u/s</span>
        </div>
      </div>
      <div className="racers-left">
        Racers
        <span className="count" data-testid="racers-left">{state.racersLeft}</span>
      </div>
      <Leaderboard state={state} />
      <div className="hud-bar">
        <div>
          <div className="meter-label">Power</div>
          <div
            className={`meter power${powerLow ? ' meter-low' : ''}`}
            data-testid="power-meter"
          >
            <div className="fill" style={{ width: `${(power * 100).toFixed(1)}%` }} />
          </div>
        </div>
        <div>
          <div className="meter-label">
            KO Meter {koReady && <span className="meter-ready">SKYWAY READY</span>}
          </div>
          <div
            className={`meter ko${koReady ? ' meter-ready-glow' : ''}`}
            data-testid="ko-meter"
          >
            <div className="fill" style={{ width: `${(ko * 100).toFixed(1)}%` }} />
          </div>
        </div>
        <div className="cooldowns" data-testid="cooldowns">
          <Cooldown
            label="SPIN"
            keyHint="↵"
            frac={spinFrac}
            color="#ff3ad1"
            testid="cd-spin"
          />
          <Cooldown
            label="SIDE"
            keyHint="Q/E"
            frac={sideFrac}
            color="#3affe1"
            testid="cd-side"
          />
        </div>
      </div>
    </div>
  );
}

const Leaderboard = ({ state }: { state: ClientState }): React.JSX.Element | null => {
  const rows = liveLeaderboard(state, 3);
  if (rows.length === 0) return null;
  return (
    <div className="mini-leaderboard" data-testid="leaderboard">
      {rows.map((r, i) => {
        const isPinned = i === rows.length - 1 && r.position > 3;
        return (
          <div
            key={r.id}
            className={`lb-row${r.isMe ? ' me' : ''}${r.inactive ? ' inactive' : ''}${isPinned ? ' pinned' : ''}`}
            data-testid={`lb-${r.position}`}
          >
            <span className="lb-pos">{r.position}</span>
            <span className="lb-color" style={{ background: r.color }} />
            <span className="lb-name">{r.name}</span>
            <span className="lb-gap">
              {i === 0 ? '—' : `−${Math.round(r.gap)}m`}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const Cooldown = ({
  label,
  keyHint,
  frac,
  color,
  testid,
}: {
  label: string;
  keyHint: string;
  frac: number;
  color: string;
  testid: string;
}): React.JSX.Element => {
  const ready = frac >= 0.999;
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <div
      className={`cd${ready ? ' cd-ready' : ''}`}
      data-testid={testid}
      data-ready={ready ? '1' : '0'}
    >
      <div
        className="cd-fill"
        style={{ width: `${pct.toFixed(0)}%`, background: color }}
      />
      <div className="cd-label">
        <span>{label}</span>
        <span className="cd-key">{keyHint}</span>
      </div>
    </div>
  );
};

const formatTime = (s: number): string => {
  const mins = Math.floor(s / 60);
  const secs = (s - mins * 60).toFixed(2);
  const padded = secs.padStart(5, '0');
  return `${mins}:${padded}`;
};
