import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TouchControls } from './TouchControls.tsx';
import type { InputApi, KeyState } from '../hooks/useKeyboard.ts';

const buildInput = (): InputApi & { _state: KeyState } => {
  const state: KeyState = {
    up: false,
    down: false,
    left: false,
    right: false,
    boost: false,
    spin: false,
    sideLeft: false,
    sideRight: false,
    skyway: false,
    pause: false,
    menu: false,
  };
  const api = {
    ref: { current: state },
    setAction: vi.fn((_source, action: keyof KeyState, value: boolean) => {
      state[action] = value;
    }),
    _state: state,
  } as unknown as InputApi & { _state: KeyState };
  return api;
};

const setSpy = (api: ReturnType<typeof buildInput>) =>
  api.setAction as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TouchControls', () => {
  it('auto-engages throttle on mount and clears it on unmount', () => {
    const input = buildInput();
    const { unmount } = render(
      <TouchControls input={input} onPause={() => {}} onLeave={() => {}} />,
    );
    const spy = setSpy(input);
    expect(spy).toHaveBeenCalledWith('touch', 'up', true);
    spy.mockClear();
    unmount();
    expect(spy).toHaveBeenCalledWith('touch', 'up', false);
  });

  it('renders the steer buttons, action buttons, and UI buttons', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    for (const tid of [
      'touch-left',
      'touch-right',
      'touch-spin',
      'touch-q',
      'touch-e',
      'touch-boost',
      'touch-skyway',
      'touch-pause',
      'touch-leave',
    ]) {
      expect(screen.getByTestId(tid)).toBeTruthy();
    }
  });

  it('does NOT render a brake button (auto-throttle is the only forward control)', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    expect(screen.queryByTestId('touch-brake')).toBeNull();
  });

  it('groups the LEFT-thumb actions (Q + ◀ + SPIN) into the same cluster', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const left = screen.getByTestId('touch-left');
    const cluster = left.closest('.touch-cluster-left');
    expect(cluster).not.toBeNull();
    expect(cluster!.contains(screen.getByTestId('touch-q'))).toBe(true);
    expect(cluster!.contains(screen.getByTestId('touch-spin'))).toBe(true);
    // RIGHT-thumb actions stay out of the left cluster.
    expect(cluster!.contains(screen.getByTestId('touch-right'))).toBe(false);
    expect(cluster!.contains(screen.getByTestId('touch-e'))).toBe(false);
  });

  it('groups the RIGHT-thumb actions (E + ▶ + BOOST + SKY) into the same cluster', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const right = screen.getByTestId('touch-right');
    const cluster = right.closest('.touch-cluster-right');
    expect(cluster).not.toBeNull();
    expect(cluster!.contains(screen.getByTestId('touch-e'))).toBe(true);
    expect(cluster!.contains(screen.getByTestId('touch-boost'))).toBe(true);
    expect(cluster!.contains(screen.getByTestId('touch-skyway'))).toBe(true);
    // LEFT-thumb actions stay out of the right cluster.
    expect(cluster!.contains(screen.getByTestId('touch-left'))).toBe(false);
    expect(cluster!.contains(screen.getByTestId('touch-q'))).toBe(false);
  });

  it('routes hold-to-fire actions through input.setAction with immediate release', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const spy = setSpy(input);
    spy.mockClear();

    fireEvent.pointerDown(screen.getByTestId('touch-left'));
    expect(spy).toHaveBeenCalledWith('touch', 'left', true);
    fireEvent.pointerUp(screen.getByTestId('touch-left'));
    expect(spy).toHaveBeenCalledWith('touch', 'left', false);

    fireEvent.pointerDown(screen.getByTestId('touch-right'));
    expect(spy).toHaveBeenCalledWith('touch', 'right', true);
    fireEvent.pointerUp(screen.getByTestId('touch-right'));
    expect(spy).toHaveBeenCalledWith('touch', 'right', false);

    fireEvent.pointerDown(screen.getByTestId('touch-boost'));
    expect(spy).toHaveBeenCalledWith('touch', 'boost', true);
    fireEvent.pointerUp(screen.getByTestId('touch-boost'));
    expect(spy).toHaveBeenCalledWith('touch', 'boost', false);
  });

  it('latches tap-fire actions for >= 150 ms so the next 10 Hz tick observes them', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const spy = setSpy(input);
    spy.mockClear();

    fireEvent.pointerDown(screen.getByTestId('touch-spin'));
    expect(spy).toHaveBeenCalledWith('touch', 'spin', true);

    // Fast tap: release immediately. The bit must stay TRUE briefly so the
    // 100 ms server snapshot has time to observe it.
    spy.mockClear();
    fireEvent.pointerUp(screen.getByTestId('touch-spin'));
    expect(spy).not.toHaveBeenCalledWith('touch', 'spin', false);

    // After the latch window, the deferred clear fires.
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(spy).toHaveBeenCalledWith('touch', 'spin', false);
  });

  it('latches all tap-fire actions (spin, sideLeft, sideRight, skyway)', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const spy = setSpy(input);

    for (const [tid, action] of [
      ['touch-spin', 'spin'],
      ['touch-q', 'sideLeft'],
      ['touch-e', 'sideRight'],
      ['touch-skyway', 'skyway'],
    ] as const) {
      spy.mockClear();
      fireEvent.pointerDown(screen.getByTestId(tid));
      fireEvent.pointerUp(screen.getByTestId(tid));
      // Press fires immediately, release is deferred.
      expect(spy).toHaveBeenCalledWith('touch', action, true);
      expect(spy).not.toHaveBeenCalledWith('touch', action, false);
      act(() => {
        vi.advanceTimersByTime(160);
      });
      expect(spy).toHaveBeenCalledWith('touch', action, false);
    }
  });

  it('clears hold-to-fire bits on pointerCancel and pointerLeave (not just pointerUp)', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const spy = setSpy(input);
    const btn = screen.getByTestId('touch-left');

    spy.mockClear();
    fireEvent.pointerDown(btn);
    fireEvent.pointerCancel(btn);
    expect(spy).toHaveBeenCalledWith('touch', 'left', false);

    spy.mockClear();
    fireEvent.pointerDown(btn);
    fireEvent.pointerLeave(btn);
    expect(spy).toHaveBeenCalledWith('touch', 'left', false);
  });

  it('calls onPause and onLeave when the UI buttons are tapped', () => {
    const input = buildInput();
    const onPause = vi.fn();
    const onLeave = vi.fn();
    render(<TouchControls input={input} onPause={onPause} onLeave={onLeave} />);

    fireEvent.pointerDown(screen.getByTestId('touch-pause'));
    expect(onPause).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByTestId('touch-leave'));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
