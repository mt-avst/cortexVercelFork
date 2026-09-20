import React, { useRef, useState } from 'react';
import { FirstHandAssetMeta } from '../../api/types';

function formatFileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes} min ${remainder} s` : `${remainder} s`;
}

function isVideo(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}

function isAudio(mimeType: string): boolean {
  return mimeType.startsWith('audio/');
}

// Signed media URLs are short-lived (~15 min). The review page can sit open longer than
// that, so on a playback error we re-fetch the outputs once per asset (which mints a fresh
// URL) before giving up and offering a manual reload. Capping the automatic retry avoids a
// loop when the media is genuinely unplayable rather than merely expired.
const AssetsSection: React.FC<{
  assets: FirstHandAssetMeta[];
  onRefresh?: () => void;
}> = ({ assets, onRefresh }) => {
  const autoRetries = useRef<Record<string, number>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});

  if (assets.length === 0) {
    return null;
  }

  const handleError = (assetId: string) => {
    const attempts = autoRetries.current[assetId] ?? 0;
    if (attempts < 1 && onRefresh) {
      autoRetries.current[assetId] = attempts + 1;
      onRefresh();
      return;
    }
    setFailed((prev) => ({ ...prev, [assetId]: true }));
  };

  const handleManualReload = (assetId: string) => {
    autoRetries.current[assetId] = 0;
    setFailed((prev) => ({ ...prev, [assetId]: false }));
    onRefresh?.();
  };

  // Default the player to the recording's own resolution rather than an
  // arbitrary small cap - scaled down only if it wouldn't fit the card.
  // preload="metadata" fetches just the header (duration/dimensions), not
  // the full file, so this sizing is already correct before anyone presses
  // play.
  const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const container = video.parentElement;
    if (!video.videoWidth || !container) return;
    video.style.width = `${Math.min(video.videoWidth, container.clientWidth)}px`;
  };

  return (
    <div className="cortex-analytics-card" style={{ marginBottom: '24px' }}>
      <div className="cortex-chart-header">
        <h5 className="cortex-chart-title">Recordings</h5>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {assets.map((asset) => {
          const duration = formatDuration(asset.duration_seconds);
          const playableVideo = asset.media_url && isVideo(asset.mime_type);
          const playableAudio = asset.media_url && isAudio(asset.mime_type);
          const hasFailed = failed[asset.asset_id];

          return (
            <li
              key={asset.asset_id}
              style={{
                padding: '10px 0',
                borderBottom: '1px solid var(--border-subtle-current)'
              }}
            >
              <span style={{ fontWeight: 500 }}>{asset.file_name}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginLeft: '10px' }}>
                {formatFileSize(asset.file_size_bytes)}
                {duration && ` · ${duration}`}
              </span>

              {(playableVideo || playableAudio) && !hasFailed && (
                <div style={{ marginTop: '8px' }}>
                  {playableVideo ? (
                    <video
                      key={asset.media_url as string}
                      controls
                      preload="metadata"
                      src={asset.media_url as string}
                      onError={() => handleError(asset.asset_id)}
                      onLoadedMetadata={handleLoadedMetadata}
                      style={{ width: '100%', maxWidth: '100%', borderRadius: '6px' }}
                    />
                  ) : (
                    <audio
                      key={asset.media_url as string}
                      controls
                      preload="none"
                      src={asset.media_url as string}
                      onError={() => handleError(asset.asset_id)}
                      style={{ width: '100%', maxWidth: '480px' }}
                    />
                  )}
                </div>
              )}

              {(playableVideo || playableAudio) && hasFailed && (
                <p className="cortex-stat-subtitle" style={{ fontSize: '0.75rem', marginTop: '8px', marginBottom: 0 }}>
                  Playback link could not be loaded.{' '}
                  <button
                    type="button"
                    className="cortex-link-button"
                    onClick={() => handleManualReload(asset.asset_id)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: 'var(--brand-orange-500)',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      font: 'inherit'
                    }}
                  >
                    Reload
                  </button>
                </p>
              )}

              {!playableVideo && !playableAudio && (
                <p className="cortex-stat-subtitle" style={{ fontSize: '0.75rem', marginTop: '4px', marginBottom: 0 }}>
                  Playback is not available for this recording.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default AssetsSection;
