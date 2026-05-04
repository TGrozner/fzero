import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboard } from './useKeyboard.ts';

describe('useKeyboard input merging', () => {
  it('OR-combines keyboard and touch sources', () => {
    const { result } = renderHook(() => useKeyboard(true));
    // Initially nothing pressed.
    expect(result.current.ref.current.up).toBe(false);
    // Touch sets `up` true.
    act(() => result.current.setAction('touch', 'up', true));
    expect(result.current.ref.current.up).toBe(true);
    // Keyboard ALSO presses up.
    act(() => result.current.setAction('kbd', 'up', true));
    expect(result.current.ref.current.up).toBe(true);
    // Touch releases — kbd is still held.
    act(() => result.current.setAction('touch', 'up', false));
    expect(result.current.ref.current.up).toBe(true);
    // Keyboard releases — now off.
    act(() => result.current.setAction('kbd', 'up', false));
    expect(result.current.ref.current.up).toBe(false);
  });

  it('keeps independent action lanes per source', () => {
    const { result } = renderHook(() => useKeyboard(true));
    act(() => {
      result.current.setAction('touch', 'left', true);
      result.current.setAction('kbd', 'right', true);
    });
    expect(result.current.ref.current.left).toBe(true);
    expect(result.current.ref.current.right).toBe(true);
    act(() => result.current.setAction('touch', 'left', false));
    expect(result.current.ref.current.left).toBe(false);
    expect(result.current.ref.current.right).toBe(true);
  });

  it('keyboard events update the kbd source via window listeners', () => {
    const { result } = renderHook(() => useKeyboard(true));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    });
    expect(result.current.ref.current.spin).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter' }));
    });
    expect(result.current.ref.current.spin).toBe(false);
  });
});
