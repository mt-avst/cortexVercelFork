import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import AssetsSection from '../AssetsSection';
import { FirstHandAssetMeta } from '../../../api/types';

function asset(overrides: Partial<FirstHandAssetMeta> = {}): FirstHandAssetMeta {
  return {
    asset_id: 'asset_1',
    file_name: 'recording.webm',
    mime_type: 'video/webm',
    file_size_bytes: 10485760,
    duration_seconds: 870,
    uploaded_at: '2026-07-15T10:14:20.000Z',
    media_url: 'https://firsthand.example.com/api/sessions/s/assets/asset_1/media?exp=1&sig=a',
    ...overrides
  };
}

describe('AssetsSection', () => {
  it('renders nothing when there are no assets', () => {
    const { container } = render(<AssetsSection assets={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a <video> player for a video asset with a media_url', () => {
    const { container } = render(<AssetsSection assets={[asset()]} />);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('src', asset().media_url as string);
    expect(video).toHaveAttribute('controls');
    expect(container.querySelector('audio')).toBeNull();
  });

  it('renders an <audio> player for an audio asset', () => {
    const { container } = render(
      <AssetsSection
        assets={[asset({ mime_type: 'audio/webm', file_name: 'audio.webm' })]}
      />
    );
    expect(container.querySelector('audio')).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('shows a metadata-only fallback when media_url is null', () => {
    const { container } = render(<AssetsSection assets={[asset({ media_url: null })]} />);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.getByText('Playback is not available for this recording.')).toBeInTheDocument();
    expect(screen.getByText('recording.webm')).toBeInTheDocument();
  });

  it('re-fetches outputs once on a playback error, then offers a manual reload', () => {
    const onRefresh = vi.fn();
    const { container } = render(
      <AssetsSection assets={[asset()]} onRefresh={onRefresh} />
    );
    const video = container.querySelector('video') as HTMLVideoElement;

    // First error auto-refreshes to mint a fresh URL.
    fireEvent.error(video);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // A second error (same asset) exhausts the auto-retry and surfaces a manual reload.
    fireEvent.error(video);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    const reload = screen.getByRole('button', { name: 'Reload' });

    fireEvent.click(reload);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});
