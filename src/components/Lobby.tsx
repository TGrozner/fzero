import { useEffect, useState } from 'react';
import { TRACKS } from '../../shared/track.ts';
import { SHIP_CLASSES, type ShipClass } from '../../shared/constants.ts';
import { ALLOWED_LAPS } from '../../shared/roomCore.ts';

type Player = {
  id: string;
  name: string;
  color: string;
  bot: boolean;
  cls: ShipClass;
  ready: boolean;
  rtt: number | null;
};

const pingColor = (rtt: number | null): string => {
  if (rtt === null) return '#666';
  if (rtt < 80) return '#3eff8b';
  if (rtt < 180) return '#ffd23a';
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

/**
 * Build the invite URL the host can share. We use the current window's
 * origin + path, force a `?room=...` param so anyone clicking joins the
 * same DO. If the user didn't pick a room, we generate a stable one from
 * the current ms timestamp so the URL is meaningful right away.
 */
const buildInviteUrl = (room: string): string => {
  if (typeof window === 'undefined') return '';
  const r = room || `room-${Date.now().toString(36)}`;
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
  const allReady = humans.length > 0 && humans.every((p) => p.ready);
  const [copied, setCopied] = useState(false);

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
          Track:
          <select
            data-testid="track-select"
            value={trackId}
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
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Laps:
          <select
            data-testid="laps-select"
            value={laps}
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

      {me && (
        <div
          className="lobby-info"
          style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}
        >
          Your ship:
          {SHIP_CLASSES.map((c) => (
            <button
              key={c}
              onClick={() => onSetClass(c)}
              data-testid={`class-${c}`}
              aria-pressed={me.cls === c}
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
            : 'Click Ready when you’re set, or hit Start now to bypass.'}
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
              {p.name}
              {p.id === myId && <span style={{ opacity: 0.6 }}> (you)</span>}
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
            onClick={() => onSetReady(!me.ready)}
            data-testid="ready-toggle"
            style={{ minWidth: 130, background: me.ready ? '#1a4a2a' : undefined }}
          >
            {me.ready ? '✓ Ready' : 'Ready'}
          </button>
        )}
        <button onClick={onStartNow} data-testid="start-now" style={{ minWidth: 110 }}>
          Start now
        </button>
        <button onClick={onCopyInvite} data-testid="copy-invite" style={{ minWidth: 140 }}>
          {copied ? 'Copied!' : 'Copy invite link'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
