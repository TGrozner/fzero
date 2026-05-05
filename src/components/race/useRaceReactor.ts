import { useEffect, useRef, useState } from 'react';
import { type ClientState, findMyShip, myPosition } from '../../state.ts';
import { getMixer } from '../../audio/mixer.ts';
import { FLAG_FREE_BOOST, FLAG_SKYWAY } from '../../../shared/protocol.ts';
import {
  type BestTimesStore,
  loadBestTimes,
  saveBestTimes,
  updateLap,
  updateRace,
} from '../../storage/bestTimes.ts';

const formatLapMs = (ms: number): string => {
  const totalSecs = ms / 1000;
  const mins = Math.floor(totalSecs / 60);
  const secs = (totalSecs - mins * 60).toFixed(2);
  const padded = secs.padStart(5, '0');
  return `${mins}:${padded}`;
};

export type RaceFx = {
  lapFanfare: { id: number; lap: number } | null;
  positionToast: { id: number; pos: number } | null;
  perfectStart: { id: number } | null;
  pbToast: { id: number; label: string } | null;
};

/**
 * The audio + flying-overlay reactor: subscribes to ClientState changes
 * and fires SFX + transient UI overlays when interesting events arrive.
 *
 * Owns:
 *   • countdown ticks + GO chime
 *   • KO / hit / pickup SFX (gain weighted by my involvement)
 *   • lap fanfare + finish-line audio
 *   • personal-best detection (lap + race), toast + persist
 *   • position-overtake toast
 *   • perfect-start banner trigger
 *   • engine pad volume tied to local speed
 */
export const useRaceReactor = (state: ClientState): RaceFx => {
  const fxIdRef = useRef(0);
  const [lapFanfare, setLapFanfare] = useState<RaceFx['lapFanfare']>(null);
  const [positionToast, setPositionToast] = useState<RaceFx['positionToast']>(null);
  const [perfectStart, setPerfectStart] = useState<RaceFx['perfectStart']>(null);
  const [pbToast, setPbToast] = useState<RaceFx['pbToast']>(null);

  // PB store and per-race lap-boundary tracking.
  const bestTimesRef = useRef<BestTimesStore>(loadBestTimes());
  const lastLapBoundaryTimeRef = useRef(0);

  // Per-event de-dup refs (so React re-runs of the effect don't replay
  // every past event on every state mutation).
  const lastCountdownTickRef = useRef<number | null>(null);
  const lastConsumedKoAtRef = useRef(0);
  const lastConsumedHitAtRef = useRef(0);
  const lastConsumedPickupAtRef = useRef(0);
  const lastLapRef = useRef<number | null>(null);
  const lastPositionRef = useRef<number | null>(null);
  const lastFinishedRef = useRef(false);
  const lastPerfectStartCountRef = useRef(0);
  // SFX-only tracking for kinematic/flag transitions on the local ship.
  const prevPowerRef = useRef<number | null>(null);
  const prevSkywayRef = useRef(false);
  const prevFreeBoostRef = useRef(false);
  const lastWallSfxAtRef = useRef(0);
  const lastHitSfxAtRef = useRef(0);

  // Keep the synthwave pad running while the race screen is live.
  useEffect(() => {
    if (state.music) getMixer().ensureMusic();
  }, [state.music]);

  useEffect(() => {
    const mixer = getMixer();

    // ---- Countdown / GO chimes.
    if (state.phase === 'COUNTDOWN') {
      const v = Math.ceil(state.countdown);
      if (v >= 1 && v <= 3 && lastCountdownTickRef.current !== v) {
        lastCountdownTickRef.current = v;
        mixer.play('countdown-tick');
      }
    } else if (lastCountdownTickRef.current !== null && state.phase === 'RACING') {
      mixer.play('countdown-go');
      lastCountdownTickRef.current = null;
    }

    // ---- Perfect-start banner + chime.
    if (state.perfectStarts > lastPerfectStartCountRef.current) {
      lastPerfectStartCountRef.current = state.perfectStarts;
      const id = ++fxIdRef.current;
      mixer.play('finish', 0.7);
      setPerfectStart({ id });
      window.setTimeout(() => {
        setPerfectStart((cur) => (cur && cur.id === id ? null : cur));
      }, 1200);
    }

    // ---- KOs.
    for (const ko of state.koLog) {
      if (ko.time <= lastConsumedKoAtRef.current) continue;
      lastConsumedKoAtRef.current = ko.time;
      if (ko.id === state.myId) {
        mixer.play('ko', 1.2);
      } else if (ko.by === state.myId) {
        mixer.play('ko', 0.85);
      } else {
        mixer.play('ko', 0.5);
      }
    }

    // ---- Hits.
    for (const ev of state.hitEvents) {
      if (ev.at <= lastConsumedHitAtRef.current) continue;
      lastConsumedHitAtRef.current = ev.at;
      const meIs =
        ev.victim === state.myId
          ? 'victim'
          : ev.attacker === state.myId
            ? 'attacker'
            : 'other';
      const gain = meIs === 'other' ? 0.35 : 0.85;
      mixer.play('hit', gain);
      if (meIs !== 'other') lastHitSfxAtRef.current = ev.at;
    }

    // ---- Pickups.
    for (const ev of state.pickupEvents) {
      if (ev.at <= lastConsumedPickupAtRef.current) continue;
      lastConsumedPickupAtRef.current = ev.at;
      const isMine = ev.vehicleId === state.myId;
      // We only chime for our own pickups OR a mine hit by anyone (it's
      // a striking sound either way).
      if (!isMine && ev.kind !== 'mine') continue;
      const gain = isMine ? 1 : 0.5;
      if (ev.kind === 'boost') mixer.play('pickup-boost', gain);
      else if (ev.kind === 'heal') mixer.play('pickup-heal', gain);
      else mixer.play('pickup-mine', gain);
    }

    // ---- Wall scrapes (no dedicated event in the protocol). Detect a small
    // power drop that can't be attributed to a recent hit or pickup-mine —
    // those each have their own SFX. Throttle so a long wall scrape doesn't
    // machine-gun the SFX.
    const meForFlags = findMyShip(state);
    if (meForFlags) {
      const prevP = prevPowerRef.current;
      const nowMs = performance.now();
      if (prevP !== null) {
        const drop = prevP - meForFlags.p;
        const recentlyHit = nowMs - lastHitSfxAtRef.current < 250;
        if (
          drop > 0.005 &&
          drop < 0.04 &&
          !recentlyHit &&
          nowMs - lastWallSfxAtRef.current > 220
        ) {
          mixer.play('wall', 0.7);
          lastWallSfxAtRef.current = nowMs;
        }
      }
      prevPowerRef.current = meForFlags.p;

      // Skyway activation chime — fires once on the false → true edge.
      const sky = (meForFlags.f & FLAG_SKYWAY) !== 0;
      if (sky && !prevSkywayRef.current) mixer.play('skyway', 1);
      prevSkywayRef.current = sky;

      // Free-boost activation chime — fires once when the last-N boost kicks
      // in or anytime the flag goes off → on.
      const fb = (meForFlags.f & FLAG_FREE_BOOST) !== 0;
      if (fb && !prevFreeBoostRef.current) mixer.play('boost-on', 0.8);
      prevFreeBoostRef.current = fb;
    } else {
      prevPowerRef.current = null;
      prevSkywayRef.current = false;
      prevFreeBoostRef.current = false;
    }

    // ---- Lap progression: fanfare, finish, lap PB, race PB.
    const me = findMyShip(state);
    if (me) {
      const prevLap = lastLapRef.current;
      const lastSnap = state.snapshots[state.snapshots.length - 1];
      const serverTime = lastSnap?.time ?? 0;
      if (prevLap !== null && me.l > prevLap) {
        const id = ++fxIdRef.current;
        const lapMs = Math.max(0, (serverTime - lastLapBoundaryTimeRef.current) * 1000);
        lastLapBoundaryTimeRef.current = serverTime;
        const lapResult = updateLap(bestTimesRef.current, state.trackId, lapMs);
        bestTimesRef.current = lapResult.store;
        if (lapResult.improved) {
          const pbId = ++fxIdRef.current;
          setPbToast({ id: pbId, label: `LAP PB · ${formatLapMs(lapMs)}` });
          window.setTimeout(() => {
            setPbToast((cur) => (cur && cur.id === pbId ? null : cur));
          }, 1800);
        }
        if (me.l >= state.laps) {
          mixer.play('finish', 1);
          if (!lastFinishedRef.current) {
            lastFinishedRef.current = true;
            const raceResult = updateRace(
              bestTimesRef.current,
              state.trackId,
              serverTime * 1000,
            );
            bestTimesRef.current = raceResult.store;
            if (raceResult.improved) {
              const pbId = ++fxIdRef.current;
              setPbToast({
                id: pbId,
                label: `RACE PB · ${formatLapMs(serverTime * 1000)}`,
              });
              window.setTimeout(() => {
                setPbToast((cur) => (cur && cur.id === pbId ? null : cur));
              }, 2500);
            }
            saveBestTimes(bestTimesRef.current);
          }
        } else {
          mixer.play('lap', 1);
          setLapFanfare({ id, lap: me.l + 1 });
          window.setTimeout(() => {
            setLapFanfare((cur) => (cur && cur.id === id ? null : cur));
          }, 1400);
        }
      }
      lastLapRef.current = me.l;
      // Engine drone tracks local speed.
      const speed = Math.hypot(me.vx, me.vy);
      mixer.setEngineSpeed(Math.min(1, speed / 280));
    }

    // ---- Overtake toast (positive cue only).
    if (state.phase === 'RACING') {
      const pos = myPosition(state);
      if (pos !== null) {
        const prev = lastPositionRef.current;
        if (prev !== null && pos < prev) {
          const id = ++fxIdRef.current;
          mixer.play('overtake', 0.6);
          setPositionToast({ id, pos });
          window.setTimeout(() => {
            setPositionToast((cur) => (cur && cur.id === id ? null : cur));
          }, 1200);
        }
        lastPositionRef.current = pos;
      }
    }
  }, [state]);

  // Persist PBs on unmount (back-stop in case the race ended without
  // crossing the finish line — e.g. user left mid-race).
  useEffect(() => {
    return () => {
      saveBestTimes(bestTimesRef.current);
    };
  }, []);

  return { lapFanfare, positionToast, perfectStart, pbToast };
};
