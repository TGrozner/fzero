import { useEffect, useState } from 'react';
import { TRACKS } from '../../shared/track.ts';

type Player = { id: string; name: string; color: string; bot: boolean };

type Props = {
  trackId: string;
  players: Player[];
  startsIn: number;
  roomName: string;
  onCancel: () => void;
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
  // Strip any client-only flags that would propagate awkwardly to a guest.
  url.searchParams.delete('profile');
  return url.toString();
};

export function Lobby({ trackId, players, startsIn, roomName, onCancel }: Props) {
  const track = TRACKS.find((t) => t.id === trackId);
  const startsInDisplay = startsIn >= 0 ? Math.ceil(startsIn) : null;
  const humans = players.filter((p) => !p.bot);
  const [copied, setCopied] = useState(false);

  // Reset the "Copied!" badge after 1.5s.
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
      // Clipboard API can fail (insecure context, denied permission, etc).
      // Fall back to a textarea-based copy + selection.
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
        // give up silently — UI keeps the button enabled
      }
    }
  };

  return (
    <div className="menu lobby-screen" data-testid="lobby">
      <h1>Lobby</h1>
      <div className="lobby-info">
        Track: <strong>{track?.name ?? trackId}</strong>
      </div>
      <div className="pulse">{humans.length} pilot{humans.length === 1 ? '' : 's'}</div>
      <div className="lobby-info">
        {startsInDisplay !== null
          ? `Starts in ${startsInDisplay}s · bots fill remaining slots`
          : 'Waiting for at least one more pilot…'}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
        {humans.slice(0, 12).map((p) => (
          <li key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: p.color,
                display: 'inline-block',
                boxShadow: `0 0 6px ${p.color}`,
              }}
            />
            <span>{p.name}</span>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button
          onClick={onCopyInvite}
          data-testid="copy-invite"
          style={{ minWidth: 160 }}
        >
          {copied ? 'Copied!' : 'Copy invite link'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
