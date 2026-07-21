import type { StudyStep } from "../../shared/firsthand/contract";

/**
 * The study's primary task page: the first runnable task step that carries a
 * target_url. This is the page the participant opens and shares before
 * recording starts, so it has to be resolved before the runner mounts - the
 * runner works step by step, but the setup handoff needs the destination up
 * front.
 *
 * A study with no target_url on any task step is not a first-hand study (a
 * pure survey, say): this returns null and the setup flow falls back to a
 * single start action rather than the open-then-share sequence.
 */
export function getPrimaryTargetUrl(steps: StudyStep[]): string | null {
  const firstTargetStep = steps.find(
    (step) => step.type !== "end" && Boolean(step.target_url)
  );

  return firstTargetStep?.target_url ?? null;
}

export type TargetDescription = {
  /**
   * The hostname a participant will recognise in the share picker, or null
   * when the target is a relative path (same-origin demo pages) whose host is
   * this app's own host and would be misleading to show.
   */
  host: string | null;
  /**
   * What to call the target in copy: the hostname when we have one, otherwise
   * a neutral "the task page". Never the raw, token-laden URL.
   */
  label: string;
};

const NEUTRAL_LABEL = "the task page";

/**
 * Turns a raw target URL into something worth showing a participant. We never
 * surface the full URL - it is long, often carries query tokens, and is not
 * how anyone identifies a window in the picker. The hostname is: it is short,
 * stable, and matches the title Chrome shows against the shared window.
 */
export function describeTarget(rawUrl: string): TargetDescription {
  try {
    const parsed = new URL(rawUrl);

    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return { host: parsed.host, label: parsed.host };
    }
  } catch {
    // Relative path or unparseable: fall through to the neutral label. A
    // relative target resolves to this app's own origin, so claiming its host
    // would point the participant at the wrong window.
  }

  return { host: null, label: NEUTRAL_LABEL };
}
