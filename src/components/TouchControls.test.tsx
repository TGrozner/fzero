import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  // jsdom + Element.setPointerCapture is a no-op stub; we don't need it
  // to actually capture for the test, but it needs to exist or the
  // pointerdown handler throws.
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setPointerCapture !== 'function') {
    proto.setPointerCapture = function (this: HTMLElement) {};
  }
  // Stub navigator.vibrate so haptic() never throws (jsdom has no vibrate).
  Object.defineProperty(navigator, 'vibrate', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

describe('TouchControls', () => {
  it('renders the joystick area, action buttons, and UI buttons', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    expect(screen.getByTestId('touch-pad')).toBeTruthy();
    expect(screen.getByTestId('touch-spin')).toBeTruthy();
    expect(screen.getByTestId('touch-q')).toBeTruthy();
    expect(screen.getByTestId('touch-e')).toBeTruthy();
    expect(screen.getByTestId('touch-boost')).toBeTruthy();
    expect(screen.getByTestId('touch-skyway')).toBeTruthy();
    expect(screen.getByTestId('touch-pause')).toBeTruthy();
    expect(screen.getByTestId('touch-leave')).toBeTruthy();
  });

  it('routes action button presses through input.setAction', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const spy = setSpy(input);

    fireEvent.pointerDown(screen.getByTestId('touch-spin'));
    expect(spy).toHaveBeenCalledWith('touch', 'spin', true);
    fireEvent.pointerUp(screen.getByTestId('touch-spin'));
    expect(spy).toHaveBeenCalledWith('touch', 'spin', false);

    fireEvent.pointerDown(screen.getByTestId('touch-boost'));
    expect(spy).toHaveBeenCalledWith('touch', 'boost', true);
    fireEvent.pointerUp(screen.getByTestId('touch-boost'));
    expect(spy).toHaveBeenCalledWith('touch', 'boost', false);

    fireEvent.pointerDown(screen.getByTestId('touch-q'));
    expect(spy).toHaveBeenCalledWith('touch', 'sideLeft', true);

    fireEvent.pointerDown(screen.getByTestId('touch-e'));
    expect(spy).toHaveBeenCalledWith('touch', 'sideRight', true);

    fireEvent.pointerDown(screen.getByTestId('touch-skyway'));
    expect(spy).toHaveBeenCalledWith('touch', 'skyway', true);
  });

  it('clears the action on pointerCancel and pointerLeave (not just pointerUp)', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const spy = setSpy(input);
    const btn = screen.getByTestId('touch-spin');

    fireEvent.pointerDown(btn);
    fireEvent.pointerCancel(btn);
    expect(spy).toHaveBeenCalledWith('touch', 'spin', false);

    spy.mockClear();
    fireEvent.pointerDown(btn);
    fireEvent.pointerLeave(btn);
    expect(spy).toHaveBeenCalledWith('touch', 'spin', false);
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

  it('shows the visible joystick when the pad is touched and hides it on release', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const pad = screen.getByTestId('touch-pad');

    expect(screen.queryByTestId('touch-joystick-base')).toBeNull();
    expect(screen.queryByTestId('touch-joystick-knob')).toBeNull();

    act(() => {
      fireEvent.pointerDown(pad, { pointerId: 1, clientX: 100, clientY: 200 });
    });
    expect(screen.getByTestId('touch-joystick-base')).toBeTruthy();
    expect(screen.getByTestId('touch-joystick-knob')).toBeTruthy();

    act(() => {
      fireEvent.pointerUp(pad, { pointerId: 1 });
    });
    expect(screen.queryByTestId('touch-joystick-base')).toBeNull();
    expect(screen.queryByTestId('touch-joystick-knob')).toBeNull();
  });

  it('drives steer/throttle bits from the joystick gesture', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const spy = setSpy(input);
    const pad = screen.getByTestId('touch-pad');

    act(() => {
      fireEvent.pointerDown(pad, { pointerId: 1, clientX: 100, clientY: 200 });
    });
    spy.mockClear();
    // Push the finger up + right past the dead zone — should set up + right true.
    act(() => {
      fireEvent.pointerMove(pad, { pointerId: 1, clientX: 160, clientY: 140 });
    });
    expect(spy).toHaveBeenCalledWith('touch', 'up', true);
    expect(spy).toHaveBeenCalledWith('touch', 'right', true);
    // Down/left stay clear.
    expect(spy).toHaveBeenCalledWith('touch', 'down', false);
    expect(spy).toHaveBeenCalledWith('touch', 'left', false);

    spy.mockClear();
    act(() => {
      fireEvent.pointerUp(pad, { pointerId: 1 });
    });
    // Release zeroes everything.
    expect(spy).toHaveBeenCalledWith('touch', 'up', false);
    expect(spy).toHaveBeenCalledWith('touch', 'right', false);
  });

  it('ignores a second pointer while one is already controlling the joystick', () => {
    const input = buildInput();
    render(<TouchControls input={input} onPause={() => {}} onLeave={() => {}} />);
    const pad = screen.getByTestId('touch-pad');

    act(() => {
      fireEvent.pointerDown(pad, { pointerId: 1, clientX: 100, clientY: 200 });
    });
    const spy = setSpy(input);
    spy.mockClear();
    // Second pointer starts: should be ignored — first gesture stays in
    // control. (No new setStick calls from the second pointer.)
    act(() => {
      fireEvent.pointerDown(pad, { pointerId: 2, clientX: 300, clientY: 100 });
    });
    // The first pointer's anchor stays put; no spurious "up" from the new one.
    // Move the SECOND pointer — it should be ignored.
    spy.mockClear();
    act(() => {
      fireEvent.pointerMove(pad, { pointerId: 2, clientX: 500, clientY: 50 });
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
