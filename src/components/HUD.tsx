import { findMyShip, type ClientState, myPosition } from '../state.ts';
import { MAX_RACERS } from '../../shared/constants.ts';

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
  return (
    <div className="hud" data-testid="hud">
      <div className="hud-top">
        <div className="position" data-testid="position">
          {pos ?? '-'}
          <span className="total">/{MAX_RACERS}</span>
        </div>
        <div className="lap" data-testid="lap">
          Lap {ship.l + 1}/3
        </div>
        <div className="time" data-testid="time">
          {formatTime(time)}
        </div>
      </div>
      <div className="racers-left">
        Racers
        <span className="count" data-testid="racers-left">{state.racersLeft}</span>
      </div>
      <div className="hud-bar">
        <div>
          <div className="meter-label">Power</div>
          <div className="meter power" data-testid="power-meter">
            <div className="fill" style={{ width: `${(power * 100).toFixed(1)}%` }} />
          </div>
        </div>
        <div>
          <div className="meter-label">KO Meter</div>
          <div className="meter ko" data-testid="ko-meter">
            <div className="fill" style={{ width: `${(ko * 100).toFixed(1)}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

const formatTime = (s: number): string => {
  const mins = Math.floor(s / 60);
  const secs = (s - mins * 60).toFixed(2);
  const padded = secs.padStart(5, '0');
  return `${mins}:${padded}`;
};
