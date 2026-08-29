import { vi } from 'vitest';
import { BookingArtifactsController } from '../useBookingArtifacts';

/**
 * An inert page-owned artefact controller for component tests, overridable
 * per test. Lives in its own module (not a .test file) so both the
 * ParticipantsTab and BookingArtifactsSection suites can import it without
 * re-registering each other's tests.
 */
export function buildArtifactsController(
  overrides: Partial<BookingArtifactsController> = {}
): BookingArtifactsController {
  return {
    artifactsByBooking: {},
    loadErrors: {},
    loadingIds: new Set<string>(),
    uploads: {},
    actionErrors: {},
    attestationDrafts: {},
    setAttestationDraft: vi.fn(),
    loadArtifacts: vi.fn(async () => undefined),
    uploadArtifact: vi.fn(async () => undefined),
    removeArtifact: vi.fn(async () => undefined),
    ...overrides
  };
}
