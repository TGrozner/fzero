import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Menu } from './Menu.tsx';
import { SHIP_COLORS } from '../../shared/constants.ts';

describe('Menu', () => {
  it('disables Race button until pseudo is set', () => {
    const dispatch = vi.fn();
    const onStart = vi.fn();
    render(
      <Menu
        pseudo=""
        color="#3aa0ff"
        trackId="mute-avenue"
        cls="balanced"
        roomName=""
        volume={0.6}
        music={true}
        onTrackChange={() => {}}
        onStart={onStart}
        dispatch={dispatch}
        busy={false}
      />,
    );
    const btn = screen.getByTestId('race-button') as HTMLButtonElement;
    expect(btn).toBeDisabled();
  });

  it('dispatches SET_PSEUDO on input change', () => {
    const dispatch = vi.fn();
    render(
      <Menu
        pseudo=""
        color="#3aa0ff"
        trackId="mute-avenue"
        cls="balanced"
        roomName=""
        volume={0.6}
        music={true}
        onTrackChange={() => {}}
        onStart={() => {}}
        dispatch={dispatch}
        busy={false}
      />,
    );
    fireEvent.change(screen.getByTestId('pseudo-input'), { target: { value: 'Tom' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_PSEUDO', pseudo: 'Tom' });
  });

  it('dispatches SET_COLOR when a swatch is clicked', () => {
    const dispatch = vi.fn();
    render(
      <Menu
        pseudo="Tom"
        color="#3aa0ff"
        trackId="mute-avenue"
        cls="balanced"
        roomName=""
        volume={0.6}
        music={true}
        onTrackChange={() => {}}
        onStart={() => {}}
        dispatch={dispatch}
        busy={false}
      />,
    );
    const second = SHIP_COLORS[1] as string;
    fireEvent.click(screen.getByTestId(`color-${second}`));
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_COLOR', color: second });
  });

  it('calls onStart when Race button is clicked', () => {
    const onStart = vi.fn();
    render(
      <Menu
        pseudo="Tom"
        color="#3aa0ff"
        trackId="mute-avenue"
        cls="balanced"
        roomName=""
        volume={0.6}
        music={true}
        onTrackChange={() => {}}
        onStart={onStart}
        dispatch={() => {}}
        busy={false}
      />,
    );
    fireEvent.click(screen.getByTestId('race-button'));
    expect(onStart).toHaveBeenCalled();
  });
});
