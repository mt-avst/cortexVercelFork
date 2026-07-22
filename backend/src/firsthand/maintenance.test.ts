import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { runFirstHandMaintenance } from './maintenance';
import { logger } from '../utils/logger';

describe('runFirstHandMaintenance', () => {
  it('runs the transcript backstop and upload reaper with default limits', async () => {
    const processTranscripts = vi.fn(async () => ({ processed: 2 }));
    const processUploadCleanup = vi.fn(async () => ({ cleaned: 1 }));

    const summary = await runFirstHandMaintenance({
      processTranscripts,
      processUploadCleanup
    });

    expect(processTranscripts).toHaveBeenCalledWith(5);
    expect(processUploadCleanup).toHaveBeenCalledWith(20);
    expect(summary).toEqual({
      transcript: { processed: 2 },
      uploadCleanup: { cleaned: 1 }
    });
  });

  it('honours configured limits', async () => {
    const processTranscripts = vi.fn(async () => ({}));
    const processUploadCleanup = vi.fn(async () => ({}));

    await runFirstHandMaintenance({
      processTranscripts,
      processUploadCleanup,
      transcriptLimit: 3,
      uploadCleanupLimit: 50
    });

    expect(processTranscripts).toHaveBeenCalledWith(3);
    expect(processUploadCleanup).toHaveBeenCalledWith(50);
  });

  it('isolates a failing job: the other still runs and the runner never throws', async () => {
    const processTranscripts = vi.fn(async () => {
      throw new Error('transcript boom');
    });
    const processUploadCleanup = vi.fn(async () => ({ cleaned: 4 }));

    const summary = await runFirstHandMaintenance({
      processTranscripts,
      processUploadCleanup
    });

    expect(processUploadCleanup).toHaveBeenCalledWith(20);
    expect(summary.uploadCleanup).toEqual({ cleaned: 4 });
    expect(summary.transcript).toEqual({ error: 'transcript boom' });
    expect(logger.error).toHaveBeenCalled();
  });
});
