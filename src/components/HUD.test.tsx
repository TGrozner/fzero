import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HUD } from './HUD.tsx';
import { buildInitialClientState } from '../state.ts';

describe('HUD', () => {
  it('does not render when there is no ship snapshot yet', () => {
    const state = buildInitialClientState();
    const { container } = render(<HUD state={state} />);
    expect(container.querySelector('[data-testid="hud"]')).toBeNull();
  });

  it('renders the local ship power and KO meters', () => {
    const state = {
      ...buildInitialClientState(),
      myId: 'p1',
      racersLeft: 87,
      snapshots: [
        {
          tick: 1,
          time: 12.5,
          receivedAt: 0,
          racersLeft: 87,
          ships: [
            { id: 'p1', x: 0, y: 0, h: 0, vx: 0, vy: 0, p: 0.7, k: 0.3, l: 1, a: 100, f: 0 },
          ],
        },
      ],
    };
    render(<HUD state={state} />);
    expect(screen.getByTestId('lap')).toHaveTextContent('Lap 2/3');
    expect(screen.getByTestId('time')).toHaveTextContent('0:12.50');
    expect(screen.getByTestId('racers-left')).toHaveTextContent('87');
    const power = screen.getByTestId('power-meter').querySelector('.fill') as HTMLElement;
    const ko = screen.getByTestId('ko-meter').querySelector('.fill') as HTMLElement;
    expect(power.style.width).toMatch(/^70(\.0+)?%$/);
    expect(ko.style.width).toMatch(/^30(\.0+)?%$/);
  });
});
