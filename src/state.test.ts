import { describe, it, expect } from 'vitest';
import { reducer, buildInitialClientState, findMyShip, myPosition } from './state.ts';

const baseState = () => buildInitialClientState();

describe('reducer', () => {
  it('SET_PSEUDO updates pseudo', () => {
    const s = reducer(baseState(), { type: 'SET_PSEUDO', pseudo: 'Tom' });
    expect(s.pseudo).toBe('Tom');
  });

  it('SET_COLOR updates color', () => {
    const s = reducer(baseState(), { type: 'SET_COLOR', color: '#fff' });
    expect(s.color).toBe('#fff');
  });

  it('SET_TRACK updates trackId', () => {
    const s = reducer(baseState(), { type: 'SET_TRACK', trackId: 'big-blue' });
    expect(s.trackId).toBe('big-blue');
  });

  it('CONNECTING/CONNECTED/DISCONNECTED status transitions', () => {
    let s = baseState();
    s = reducer(s, { type: 'CONNECTING' });
    expect(s.status).toBe('connecting');
    s = reducer(s, { type: 'CONNECTED' });
    expect(s.status).toBe('connected');
    s = reducer(s, { type: 'DISCONNECTED' });
    expect(s.status).toBe('closed');
    expect(s.view).toBe('menu');
  });

  it('CONNECTION_ERROR populates error and resets view', () => {
    const s = reducer(baseState(), { type: 'CONNECTION_ERROR', error: 'oops' });
    expect(s.error).toBe('oops');
    expect(s.view).toBe('menu');
  });

  it('SERVER_MESSAGE welcome populates myId and players', () => {
    const s = reducer(baseState(), {
      type: 'SERVER_MESSAGE',
      receivedAt: 0,
      message: {
        type: 'welcome',
        yourId: 'p1',
        track: 'mute-avenue',
        phase: 'WAITING',
        countdown: 3,
        startsIn: 20,
        players: [
          { id: 'p1', name: 'Tom', color: '#fff', bot: false },
          { id: 'p2', name: 'Bob', color: '#000', bot: false },
        ],
      },
    });
    expect(s.myId).toBe('p1');
    expect(Object.keys(s.players)).toHaveLength(2);
    expect(s.view).toBe('lobby');
  });

  it('SERVER_MESSAGE phase RACING moves view to race', () => {
    const s = reducer(baseState(), {
      type: 'SERVER_MESSAGE',
      receivedAt: 0,
      message: { type: 'phase', phase: 'RACING' },
    });
    expect(s.phase).toBe('RACING');
    expect(s.view).toBe('race');
  });

  it('SERVER_MESSAGE snapshot stores ships and racers left', () => {
    const s = reducer(baseState(), {
      type: 'SERVER_MESSAGE',
      receivedAt: 100,
      message: {
        type: 'snapshot',
        tick: 1,
        time: 1.5,
        racersLeft: 50,
        ships: [{ id: 'p1', x: 0, y: 0, h: 0, vx: 0, vy: 0, p: 1, k: 0, l: 0, a: 0, f: 0 }],
        pk: 0xff,
      },
    });
    expect(s.snapshots.length).toBe(1);
    expect(s.racersLeft).toBe(50);
    expect(s.snapshots[0]?.pk).toBe(0xff);
  });

  it('SERVER_MESSAGE pickup queues a transient event', () => {
    const s = reducer(baseState(), {
      type: 'SERVER_MESSAGE',
      receivedAt: 200,
      message: { type: 'pickup', idx: 3, kind: 'boost', vehicleId: 'p1', time: 1.2 },
    });
    expect(s.pickupEvents.length).toBe(1);
    expect(s.pickupEvents[0]?.kind).toBe('boost');
  });

  it('SERVER_MESSAGE results moves to results view', () => {
    const s = reducer(baseState(), {
      type: 'SERVER_MESSAGE',
      receivedAt: 0,
      message: {
        type: 'results',
        standings: [
          { id: 'p1', position: 1, finishTime: 12.3, ko: false },
        ],
      },
    });
    expect(s.view).toBe('results');
    expect(s.standings.length).toBe(1);
  });

  it('TOGGLE_PAUSE flips paused', () => {
    const s = reducer(baseState(), { type: 'TOGGLE_PAUSE' });
    expect(s.paused).toBe(true);
    expect(reducer(s, { type: 'TOGGLE_PAUSE' }).paused).toBe(false);
  });

  it('SERVER_MESSAGE ko adds an entry to myKos when by===myId', () => {
    let s = reducer(baseState(), {
      type: 'SERVER_MESSAGE',
      receivedAt: 1000,
      message: {
        type: 'welcome',
        yourId: 'p1',
        track: 'mute-avenue',
        phase: 'RACING',
        countdown: 0,
        startsIn: -1,
        players: [],
      },
    });
    s = reducer(s, {
      type: 'SERVER_MESSAGE',
      receivedAt: 1500,
      message: { type: 'ko', id: 'b9', by: 'p1', time: 5 },
    });
    expect(s.myKos.length).toBe(1);
    expect(s.myKos[0]?.id).toBe('b9');
  });

  it('SERVER_MESSAGE ko ignores other-player KOs', () => {
    let s = reducer(baseState(), {
      type: 'SERVER_MESSAGE',
      receivedAt: 1000,
      message: {
        type: 'welcome',
        yourId: 'p1',
        track: 'mute-avenue',
        phase: 'RACING',
        countdown: 0,
        startsIn: -1,
        players: [],
      },
    });
    s = reducer(s, {
      type: 'SERVER_MESSAGE',
      receivedAt: 1500,
      message: { type: 'ko', id: 'b9', by: 'b3', time: 5 },
    });
    expect(s.myKos.length).toBe(0);
  });
});

describe('selectors', () => {
  const stateWithSnapshot = () => ({
    ...baseState(),
    myId: 'p1',
    snapshots: [
      {
        tick: 1,
        time: 1,
        receivedAt: 0,
        racersLeft: 99,
        pk: 0,
        ships: [
          { id: 'p1', x: 0, y: 0, h: 0, vx: 0, vy: 0, p: 1, k: 0, l: 0, a: 50, f: 0 },
          { id: 'p2', x: 0, y: 0, h: 0, vx: 0, vy: 0, p: 1, k: 0, l: 0, a: 200, f: 0 },
        ],
      },
    ],
  });

  it('findMyShip returns the local ship', () => {
    const s = stateWithSnapshot();
    expect(findMyShip(s)?.id).toBe('p1');
  });

  it('myPosition reflects arc length sort', () => {
    const s = stateWithSnapshot();
    expect(myPosition(s)).toBe(2); // p2 has higher arc length
  });

  it('myPosition returns null when no snapshot', () => {
    expect(myPosition(baseState())).toBeNull();
  });
});
