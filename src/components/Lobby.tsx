import { TRACKS } from '../../shared/track.ts';

type Player = { id: string; name: string; color: string; bot: boolean };

type Props = {
  trackId: string;
  players: Player[];
  startsIn: number;
  onCancel: () => void;
};

export function Lobby({ trackId, players, startsIn, onCancel }: Props) {
  const track = TRACKS.find((t) => t.id === trackId);
  const startsInDisplay = startsIn >= 0 ? Math.ceil(startsIn) : null;
  const humans = players.filter((p) => !p.bot);
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
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}
