import React from 'react';
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

const AssetsSection: React.FC<{ assets: FirstHandAssetMeta[] }> = ({ assets }) => {
  if (assets.length === 0) {
    return null;
  }

  return (
    <div className="cortex-analytics-card" style={{ marginBottom: '24px' }}>
      <div className="cortex-chart-header">
        <h5 className="cortex-chart-title">Recordings</h5>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {assets.map((asset) => {
          const duration = formatDuration(asset.duration_seconds);
          return (
            <li
              key={asset.asset_id}
              style={{
                padding: '10px 0',
                borderBottom: '1px solid var(--cortex-border, rgba(255,255,255,0.04))'
              }}
            >
              <span style={{ fontWeight: 500 }}>{asset.file_name}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginLeft: '10px' }}>
                {formatFileSize(asset.file_size_bytes)}
                {duration && ` · ${duration}`}
              </span>
              <p className="cortex-stat-subtitle" style={{ fontSize: '0.75rem', marginTop: '4px', marginBottom: 0 }}>
                Playback in Cortex is coming in a future release.
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default AssetsSection;
