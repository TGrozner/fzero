type Props = {
  fps: number;
  p99: number;
  particles: number;
};

/**
 * Tiny dev-only overlay that surfaces real-time render-loop stats.
 * Shown when the page URL includes `?profile=1`.
 *
 * fps  — moving-window average frame rate.
 * p99  — 99th-percentile frame time over the last ~1.5s. Watch this for
 *        stutters that don't show up in the average.
 * particles — current live particle count (capped at 600 by the renderer).
 */
export function ProfileOverlay({ fps, p99, particles }: Props) {
  const fpsColor = fps >= 55 ? '#3eff8b' : fps >= 30 ? '#ffd23a' : '#ff4040';
  return (
    <div
      data-testid="profile-overlay"
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        padding: '6px 8px',
        background: 'rgba(8, 4, 28, 0.7)',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 4,
        fontFamily: 'ui-monospace, monospace',
        fontSize: 11,
        lineHeight: 1.4,
        color: '#fff',
        zIndex: 50,
        pointerEvents: 'none',
      }}
    >
      <div>
        <span style={{ color: 'var(--muted)' }}>FPS </span>
        <span style={{ color: fpsColor }}>{fps}</span>
        <span style={{ color: 'var(--muted)' }}> · p99 </span>
        <span>{p99}ms</span>
      </div>
      <div>
        <span style={{ color: 'var(--muted)' }}>particles </span>
        <span>{particles}</span>
      </div>
    </div>
  );
}
