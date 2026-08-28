import { DEFAULT_CONSENT_TEXT } from "./inline-study";
import { DEFAULT_SURVEY_CONSENT_TEXT } from "./survey-authoring";

/**
 * The approved wording for a MODERATED session - a live call with a researcher
 * (#79). Defined here rather than in a study vocabulary file because a
 * moderated session has no study: its consent is anchored on the opportunity
 * and accepted at booking time, so there is no inline-study or survey-authoring
 * module for this text to live in.
 *
 * The wording has to cover what the other two templates do not: the session
 * happens on a third-party call, the recording - when there is one - is made by
 * the meeting platform, and what Cortex stores is an ingested copy plus its
 * transcript. "May be" is deliberate: a researcher can run an unrecorded
 * session under the same consent, and promising less than might happen is the
 * failure mode, not promising more.
 */
export const DEFAULT_MODERATED_CONSENT_TEXT =
  "This is a live session with a researcher on a video call. The call may be " +
  "recorded on the meeting platform, and the recording and its transcript may be " +
  "stored for research analysis, visible to the research team. You can decline " +
  "recording at the start of the call or ask for it to stop at any point; " +
  "anything recorded up to that point is still kept for the research team.";

/**
 * Consent templates: the approved wording, versioned, and the rule that decides
 * whether a given study is actually running on it.
 *
 * Before this existed, `firsthand.studies.consent_text` was one free-text column
 * with two hardcoded defaults and no way to tell - at a glance or at all -
 * whether the sentence a participant accepted was the wording the organisation
 * approved or something a researcher typed over it. Every study looked the same
 * from the outside.
 *
 * The governance model is deliberately small: a study either runs on a NAMED
 * template at a NAMED version, or it runs on `custom` wording. There is no
 * approval workflow, no template editor and no draft state - those need an
 * owner concept this product does not have yet. What is not deferrable, and is
 * what this module provides, is knowing WHICH of the two a study is on, and
 * recording it where it cannot drift from the wording it describes.
 */

/**
 * Which vocabulary the consent is written for, and therefore which template
 * family applies. The three cannot share copy: `recorded` describes screen and
 * microphone capture by this product, `survey` states plainly that nothing is
 * recorded, and `moderated` describes a live call recorded - if at all - by the
 * meeting platform and ingested afterwards (#79).
 *
 * `recorded` and `survey` are also `firsthand.studies.kind` values, constrained
 * by `studies_kind_check` (migration 0009). `moderated` deliberately is NOT: a
 * moderated session has no study, its consent lives on the opportunity row, and
 * this union widening must never reach that CHECK.
 */
export type ConsentKind = "recorded" | "survey" | "moderated";

export const RECORDED_CONSENT_TEMPLATE_ID = "recorded-default";
export const SURVEY_CONSENT_TEMPLATE_ID = "survey-default";
export const MODERATED_CONSENT_TEMPLATE_ID = "moderated-default";

/**
 * The template id a study carries when its wording is nobody's approved
 * wording. Not a template: there is no `custom` text, because custom text is
 * whatever the author wrote.
 */
export const CUSTOM_CONSENT_TEMPLATE_ID = "custom";

export interface ConsentTemplateVersion {
  /** Stable across versions. This is what `consent_template_id` stores. */
  readonly id: string;
  /** Monotonic per id. This is what `consent_template_version` stores. */
  readonly version: number;
  /** Which study kind the template is written for. */
  readonly kind: ConsentKind;
  /** Shown to the author in place of the wording when consent is locked. */
  readonly name: string;
  /** One line naming what the wording actually covers. */
  readonly summary: string;
  /** The approved wording itself, verbatim. */
  readonly text: string;
}

/**
 * Every version of every template, including superseded ones.
 *
 * Superseded versions are kept rather than replaced, and that is the whole
 * point of storing a version number: a study approved on v1 must keep reading
 * as approved-on-v1 after v2 ships, instead of silently reclassifying as
 * `custom` the moment somebody improves the wording. Deleting a version from
 * this list retroactively rewrites what past studies claim.
 *
 * `text` is the source of truth for v1 of both templates. The v1 strings are
 * ALSO embedded verbatim in migration `0013`, which classifies the rows that
 * predate this module and cannot import TypeScript;
 * `consent-templates.test.ts` pins the two against each other so that editing
 * a shipped version's wording - which is a version bump, not an edit - cannot
 * pass silently.
 */
export type ConsentTemplateRegistry = readonly ConsentTemplateVersion[];

const CONSENT_TEMPLATE_VERSIONS: ConsentTemplateRegistry = [
  {
    id: RECORDED_CONSENT_TEMPLATE_ID,
    version: 1,
    kind: "recorded",
    name: "Standard recorded-session consent",
    summary:
      "Screen and microphone recording, who sees the recording, and how a participant ends it.",
    text: DEFAULT_CONSENT_TEXT
  },
  {
    id: SURVEY_CONSENT_TEMPLATE_ID,
    version: 1,
    kind: "survey",
    name: "Standard survey consent",
    summary:
      "What is stored, who sees it, and that no screen, microphone or camera is recorded.",
    text: DEFAULT_SURVEY_CONSENT_TEXT
  },
  {
    id: MODERATED_CONSENT_TEMPLATE_ID,
    version: 1,
    kind: "moderated",
    name: "Standard live-session consent",
    summary:
      "A live call that may be recorded on the meeting platform, what is stored afterwards, and how a participant declines.",
    text: DEFAULT_MODERATED_CONSENT_TEXT
  }
];

/**
 * The template id that applies to consent of this kind. A lookup rather than a
 * ternary so a fourth kind is a compile error here, not a silent fall-through
 * to the recorded template - whose central claim (this product records your
 * screen) would be false copy for it.
 */
const TEMPLATE_ID_BY_KIND: Record<ConsentKind, string> = {
  recorded: RECORDED_CONSENT_TEMPLATE_ID,
  survey: SURVEY_CONSENT_TEMPLATE_ID,
  moderated: MODERATED_CONSENT_TEMPLATE_ID
};

export const consentTemplateIdForKind = (kind: ConsentKind): string =>
  TEMPLATE_ID_BY_KIND[kind];

/**
 * Whether an id names custom wording rather than a template.
 *
 * Treats absent and null as custom deliberately. A row with no recorded
 * template is a row whose provenance nobody knows, and the safe reading of
 * "unknown" is "not approved" - claiming approval for wording that has never
 * been checked is the one failure this whole module exists to prevent.
 */
export const isCustomConsentTemplate = (
  templateId: string | null | undefined,
  registry: ConsentTemplateRegistry = CONSENT_TEMPLATE_VERSIONS
): boolean =>
  !templateId || !registry.some((template) => template.id === templateId);

/** One specific version, or null when nothing has ever been published as it. */
export const findConsentTemplate = (
  templateId: string | null | undefined,
  version: number | null | undefined,
  registry: ConsentTemplateRegistry = CONSENT_TEMPLATE_VERSIONS
): ConsentTemplateVersion | null =>
  registry.find(
    (template) => template.id === templateId && template.version === version
  ) ?? null;

/**
 * Any version of a named template, for saying WHAT a study is on when the
 * version it claims is not one anything published. Returns the latest known
 * version, so a caller that needs the exact one must compare - see the badge in
 * ConsentStep, which prints a version number only on an exact match.
 */
export const namedConsentTemplate = (
  templateId: string | null | undefined,
  registry: ConsentTemplateRegistry = CONSENT_TEMPLATE_VERSIONS
): ConsentTemplateVersion | null =>
  latestOf(registry.filter((template) => template.id === templateId));

/**
 * The highest-versioned entry, or null for an empty list.
 *
 * Written as a reduce with a SEED rather than seedless, because the seedless
 * form on a one-element array returns that element without ever calling the
 * comparison - which is what this registry holds today. The comparison was
 * therefore dead code, and an inverted `>` survived a mutation pass unnoticed.
 * Every published template still has exactly one version; the point is that the
 * rule which will decide the answer when there are two is executed and testable
 * now, rather than first running in anger on the day a v2 ships.
 */
const latestOf = (
  versions: ConsentTemplateRegistry
): ConsentTemplateVersion | null =>
  versions.reduce<ConsentTemplateVersion | null>(
    (latest, candidate) =>
      latest === null || candidate.version > latest.version ? candidate : latest,
    null
  );

/**
 * The version an author writing a NEW study of this kind starts on: the highest
 * published version of that kind's template.
 *
 * `registry` is injectable so the version-selection rule can be exercised
 * against a two-version registry. Without that seam the branch that matters
 * most - a study staying on v1 after v2 ships - could not be tested at all
 * until the day it was too late to find out it was wrong.
 */
export const currentConsentTemplate = (
  kind: ConsentKind,
  registry: ConsentTemplateRegistry = CONSENT_TEMPLATE_VERSIONS
): ConsentTemplateVersion => {
  const id = consentTemplateIdForKind(kind);
  const latest = latestOf(registry.filter((template) => template.id === id));

  if (!latest) {
    throw new Error(`No consent template published for kind "${kind}".`);
  }

  return latest;
};

/**
 * Whether two pieces of consent wording are the same wording.
 *
 * Trims before comparing, and only trims. A trailing newline picked up from a
 * textarea is not a deviation from approved wording and must not mark a study
 * as running on custom consent - but a changed word is, so nothing else is
 * normalised. Collapsing internal whitespace would let "we never record your
 * screen" and "we never  record your screen" compare equal, which is harmless,
 * and would tempt the next change into case-folding, which is not.
 */
export const consentTextMatches = (left: string, right: string): boolean =>
  left.trim() === right.trim();

export interface ResolvedConsentTemplate {
  /** A template id, or `custom`. */
  readonly id: string;
  /** The template's version, or null when the wording is custom. */
  readonly version: number | null;
}

/**
 * Decide what template a study is actually on, from its wording.
 *
 * The claim is an INPUT, never the answer. A client may say a study runs on
 * `recorded-default` v1; this checks whether the wording it sent actually IS
 * that wording, and downgrades it to `custom` when it is not. That asymmetry is
 * the security property: a caller can always understate its approval (send
 * approved wording with no claim, and get the template back), and can never
 * overstate it (send edited wording claiming a template, and get `custom`).
 *
 * The claim earns its place in the two cases derivation alone cannot handle:
 *
 * - After v2 ships, a study still carrying v1's wording resolves to v1 rather
 *   than to `custom`, because the claim selects which version to compare
 *   against. Without it, publishing better wording would mass-reclassify every
 *   existing study as unapproved.
 * - A claim naming a template belonging to the OTHER kind is refused before it
 *   is compared, so a recorded study can never be recorded as running on the
 *   survey template, whose central sentence - "Nothing is recorded" - would be
 *   false about it.
 */
export const resolveConsentTemplate = (
  input: {
    kind: ConsentKind;
    consentText: string;
    claimedTemplateId?: string | null;
    claimedTemplateVersion?: number | null;
  },
  registry: ConsentTemplateRegistry = CONSENT_TEMPLATE_VERSIONS
): ResolvedConsentTemplate => {
  const claimed = findConsentTemplate(
    input.claimedTemplateId,
    input.claimedTemplateVersion,
    registry
  );

  if (
    claimed &&
    claimed.kind === input.kind &&
    consentTextMatches(input.consentText, claimed.text)
  ) {
    return { id: claimed.id, version: claimed.version };
  }

  const current = currentConsentTemplate(input.kind, registry);
  if (consentTextMatches(input.consentText, current.text)) {
    return { id: current.id, version: current.version };
  }

  return { id: CUSTOM_CONSENT_TEMPLATE_ID, version: null };
};

/**
 * The version a new study of each kind starts on.
 *
 * Named constants rather than repeated `currentConsentTemplate(...)` calls at
 * the four places the form seeds its state, so that "what a blank study starts
 * on" reads as one decision made once instead of four that could drift.
 */
export const RECORDED_CONSENT_TEMPLATE = currentConsentTemplate("recorded");
export const SURVEY_CONSENT_TEMPLATE = currentConsentTemplate("survey");
export const MODERATED_CONSENT_TEMPLATE = currentConsentTemplate("moderated");

/**
 * Every published version, for tests and for anything that needs to enumerate
 * them. A copy, so a caller cannot reorder or truncate the registry in place.
 */
export const allConsentTemplates = (): ConsentTemplateVersion[] => [
  ...CONSENT_TEMPLATE_VERSIONS
];
