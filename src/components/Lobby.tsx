import { useEffect, useMemo, useRef, useState } from 'react';
import { TRACKS } from '../../shared/track.ts';
import {
  RTT_BAND_GREEN_MAX,
  RTT_BAND_YELLOW_MAX,
  SHIP_CLASSES,
  type ShipClass,
} from '../../shared/constants.ts';
import { ALLOWED_LAPS } from '../../shared/roomCore.ts';
import { getMixer } from '../audio/mixer.ts';

type Player = {
  id: string;
  name: string;
  color: string;
  bot: boolean;
  cls: ShipClass;
  ready: boolean;
  rtt: number | null;
  trackVote: string;
};

const pingColor = (rtt: number | null): string => {
  if (rtt === null) return '#666';
  if (rtt < RTT_BAND_GREEN_MAX) return '#3eff8b';
  if (rtt < RTT_BAND_YELLOW_MAX) return '#ffd23a';
  return '#ff4040';
};

type Props = {
  trackId: string;
  laps: number;
  players: Player[];
  myId: string | null;
  roomName: string;
  onCancel: () => void;
  onStartNow: () => void;
  onSetReady: (ready: boolean) => void;
  onSetTrack: (trackId: string) => void;
  onSetClass: (cls: ShipClass) => void;
  onSetLaps: (laps: number) => void;
};

const CLS_LABEL: Record<ShipClass, string> = {
  speed: 'SPD',
  tank: 'TNK',
  balanced: 'BAL',
};

const CLS_FULL: Record<ShipClass, string> = {
  speed: 'Speed',
  tank: 'Tank',
  balanced: 'Balanced',
};

const CLS_TIP: Record<ShipClass, string> = {
  speed: 'Speed: top speed +14%, slower turns, lighter HP',
  tank: 'Tank: tightest steering, sturdier walls, lower top speed',
  balanced: 'Balanced: middle of the road, best for new pilots',
};

const trackName = (id: string): string =>
  TRACKS.find((t) => t.id === id)?.name ?? id;

/**
 * Build the invite URL the host can share. We use the current window's
 * origin + path, force a `?room=...` param so anyone clicking joins the
 * same DO. If the user didn't pick a room, we generate a stable one from
 * the current ms timestamp so the URL is meaningful right away.
 */
/** Stable fallback room name — computed once per page load so repeated
 *  clicks on "Copy invite" always produce the same URL. */
const fallbackRoom = `room-${Date.now().toString(36)}`;

const buildInviteUrl = (room: string): string => {
  if (typeof window === 'undefined') return '';
  const r = room || fallbackRoom;
  const url = new URL(window.location.href);
  url.searchParams.set('room', r);
  url.searchParams.delete('profile');
  return url.toString();
};

export function Lobby({
  trackId,
  laps,
  players,
  myId,
  roomName,
  onCancel,
  onStartNow,
  onSetReady,
  onSetTrack,
  onSetClass,
  onSetLaps,
}: Props) {
  const humans = players.filter((p) => !p.bot);
  const me = myId ? humans.find((p) => p.id === myId) ?? null : null;
  // Host = longest-connected human; same logic the server uses to gate
  // start_now / set_laps. Whoever's first in the players list wins.
  const hostId = humans[0]?.id ?? null;
  const isHost = me !== null && me.id === hostId;
  const allReady = humans.length > 0 && humans.every((p) => p.ready);
  const [copied, setCopied] = useState(false);

  const voteTally = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of humans) counts.set(p.trackVote, (counts.get(p.trackVote) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [humans]);

  // Pulse the "playing X" indicator briefly whenever the active track
  // changes — visual feedback so a vote flip doesn't slip by unnoticed.
  const [trackJustChanged, setTrackJustChanged] = useState(false);
  const prevTrackRef = useRef(trackId);
  useEffect(() => {
    if (prevTrackRef.current === trackId) return;
    prevTrackRef.current = trackId;
    setTrackJustChanged(true);
    getMixer().play('ui-notify', 0.7);
    const t = window.setTimeout(() => setTrackJustChanged(false), 1200);
    return () => window.clearTimeout(t);
  }, [trackId]);

  // Notify when a new human pilot joins the room.
  const prevHumanCountRef = useRef(humans.length);
  useEffect(() => {
    if (humans.length > prevHumanCountRef.current) {
      getMixer().play('ui-notify', 0.5);
    }
    prevHumanCountRef.current = humans.length;
  }, [humans.length]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const onCopyInvite = async () => {
    const url = buildInviteUrl(roomName);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
      } catch {
        // give up silently
      }
    }
  };

  return (
    <div className="menu lobby-screen" data-testid="lobby">
      <h1>Lobby</h1>

      <div className="lobby-info" style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Your track vote:
          <select
            data-testid="track-select"
            value={me?.trackVote ?? trackId}
            onChange={(e) => onSetTrack(e.target.value)}
            style={{ minWidth: 140 }}
          >
            {TRACKS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: isHost ? 1 : 0.6 }}
          title={isHost ? '' : 'Only the host can change the lap count'}
        >
          Laps:
          <select
            data-testid="laps-select"
            value={laps}
            disabled={!isHost}
            onChange={(e) => onSetLaps(Number(e.target.value))}
          >
            {ALLOWED_LAPS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      {voteTally.length > 0 && (
        <div className="lobby-info" data-testid="vote-tally" style={{ fontSize: 12, opacity: 0.85 }}>
          Votes: {voteTally.map(([id, n], i) => (
            <span key={id} style={{ marginLeft: i === 0 ? 0 : 8 }}>
              <strong style={{ color: id === trackId ? '#3eff8b' : 'inherit' }}>{trackName(id)}</strong>
              {' '}
              <span style={{ opacity: 0.7 }}>×{n}</span>
            </span>
          ))}
          <span
            data-testid="active-track"
            style={{
              marginLeft: 12,
              opacity: 0.7,
              transition: 'transform 250ms ease, color 250ms ease',
              transform: trackJustChanged ? 'scale(1.12)' : 'scale(1)',
              color: trackJustChanged ? '#3eff8b' : undefined,
              display: 'inline-block',
            }}
          >
            → playing <strong>{trackName(trackId)}</strong>
          </span>
        </div>
      )}

      {me && (
        <div
          className="lobby-info"
          style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}
        >
          Your ship:
          {SHIP_CLASSES.map((c) => (
            <button
              key={c}
              onClick={() => {
                getMixer().play('ui-click');
                onSetClass(c);
              }}
              data-testid={`class-${c}`}
              aria-pressed={me.cls === c}
              title={CLS_TIP[c]}
              style={{
                minWidth: 84,
                background: me.cls === c ? '#1a4a2a' : undefined,
                fontWeight: me.cls === c ? 'bold' : undefined,
              }}
            >
              {CLS_FULL[c]}
            </button>
          ))}
        </div>
      )}

      <div className="pulse">
        {humans.length} pilot{humans.length === 1 ? '' : 's'}
        {humans.length > 0 && ` · ${humans.filter((p) => p.ready).length}/${humans.length} ready`}
      </div>
      <div className="lobby-info" style={{ minHeight: '1.2em' }}>
        {humans.length === 0
          ? 'Waiting for the first pilot…'
          : allReady
            ? 'Everyone ready — starting…'
            : isHost
              ? 'Click Ready, or hit Start now to bypass.'
              : 'Click Ready when you’re set. The host can also Start now.'}
      </div>

      <ul
        data-testid="player-list"
        style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6, maxHeight: 240, overflowY: 'auto' }}
      >
        {humans.map((p) => (
          <li
            key={p.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 6px',
              background: p.id === myId ? 'rgba(58, 160, 255, 0.08)' : 'transparent',
              borderRadius: 4,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: p.color,
                display: 'inline-block',
                boxShadow: `0 0 6px ${p.color}`,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {p.id === hostId && (
                <span aria-label="host" title="Host" style={{ marginRight: 4 }}>★</span>
              )}
              {p.name}
              {p.id === myId && <span style={{ opacity: 0.6 }}> (you)</span>}
            </span>
            <span
              aria-label={`voted for ${trackName(p.trackVote)}`}
              data-testid={`vote-${p.id}`}
              style={{
                fontSize: 10,
                opacity: 0.6,
                fontStyle: 'italic',
                maxWidth: 90,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {trackName(p.trackVote)}
            </span>
            <span
              aria-label={`class: ${p.cls}`}
              style={{
                fontSize: 11,
                opacity: 0.7,
                padding: '2px 6px',
                border: '1px solid currentColor',
                borderRadius: 3,
                letterSpacing: 1,
              }}
            >
              {CLS_LABEL[p.cls]}
            </span>
            <span
              aria-label={p.rtt !== null ? `${p.rtt} ms` : 'no ping data'}
              data-testid={`ping-${p.id}`}
              style={{
                fontSize: 11,
                color: pingColor(p.rtt),
                minWidth: 42,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {p.rtt !== null ? `${p.rtt} ms` : '— ms'}
            </span>
            <span
              aria-label={p.ready ? 'ready' : 'not ready'}
              style={{ width: 18, textAlign: 'center', color: p.ready ? '#3eff8b' : '#666' }}
            >
              {p.ready ? '✓' : '·'}
            </span>
          </li>
        ))}
      </ul>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginTop: 6 }}>
        {me && (
          <button
            onClick={() => {
              getMixer().play('ui-click');
              onSetReady(!me.ready);
            }}
            data-testid="ready-toggle"
            title="Race auto-starts when everyone in the lobby is ready"
            style={{ minWidth: 130, background: me.ready ? '#1a4a2a' : undefined }}
          >
            {me.ready ? '✓ Ready' : 'Ready'}
          </button>
        )}
        {isHost && (
          <button
            onClick={onStartNow}
            data-testid="start-now"
            title="Host only · skip Ready and start the race immediately"
            style={{ minWidth: 110 }}
          >
            Start now
          </button>
        )}
        <button onClick={onCopyInvite} data-testid="copy-invite" style={{ minWidth: 140 }}>
          {copied ? 'Copied!' : 'Copy invite link'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
