import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ConsentTemplateVersion } from "../../../shared/firsthand/consent-templates";
import {
  CUSTOM_CONSENT_TEMPLATE_ID,
  RECORDED_CONSENT_TEMPLATE_ID,
  SURVEY_CONSENT_TEMPLATE_ID,
  allConsentTemplates,
  consentTextMatches,
  currentConsentTemplate,
  findConsentTemplate,
  namedConsentTemplate,
  isCustomConsentTemplate,
  resolveConsentTemplate
} from "../../../shared/firsthand/consent-templates";
import { DEFAULT_CONSENT_TEXT } from "../../../shared/firsthand/inline-study";
import { DEFAULT_SURVEY_CONSENT_TEXT } from "../../../shared/firsthand/survey-authoring";
import {
  DEFAULT_MODERATED_CONSENT_TEXT,
  MODERATED_CONSENT_TEMPLATE_ID,
  MODERATED_CONSENT_TYPES,
  MODERATED_CONSENT_TEMPLATE,
  bookingConsentText
} from "../../../shared/firsthand/consent-templates";

const RECORDED_V1 = currentConsentTemplate("recorded");
const SURVEY_V1 = currentConsentTemplate("survey");

describe("resolveConsentTemplate", () => {
  /**
   * The security property, stated once as a pair.
   *
   * A caller may always UNDERSTATE its approval - send the approved wording
   * with no claim at all and be told, correctly, that it is the approved
   * wording. A caller may never OVERSTATE it - send edited wording under an
   * approved template id and get `custom` back. Every other case in this file
   * is a corner of one of those two.
   */
  it("believes a claim only when the wording actually is that wording", () => {
    expect(
      resolveConsentTemplate({
        kind: "recorded",
        consentText: DEFAULT_CONSENT_TEXT,
        claimedTemplateId: RECORDED_CONSENT_TEMPLATE_ID,
        claimedTemplateVersion: 1
      })
    ).toEqual({ id: RECORDED_CONSENT_TEMPLATE_ID, version: 1 });
  });

  it("downgrades a claim the wording does not support", () => {
    expect(
      resolveConsentTemplate({
        kind: "recorded",
        consentText: `${DEFAULT_CONSENT_TEXT} We also share it with our client.`,
        claimedTemplateId: RECORDED_CONSENT_TEMPLATE_ID,
        claimedTemplateVersion: 1
      })
    ).toEqual({ id: CUSTOM_CONSENT_TEMPLATE_ID, version: null });
  });

  it("recognises the approved wording with no claim at all", () => {
    expect(
      resolveConsentTemplate({
        kind: "survey",
        consentText: DEFAULT_SURVEY_CONSENT_TEXT
      })
    ).toEqual({ id: SURVEY_CONSENT_TEMPLATE_ID, version: 1 });
  });

  /**
   * A recorded study may not be recorded as running on the survey template.
   *
   * The survey wording's central claim is "Nothing is recorded: no screen, no
   * microphone and no camera", which is false about a session that records the
   * screen and the microphone. Accepting the claim because the TEXT matched
   * would file a study under an approval for wording that contradicts what it
   * does, which is worse than filing it as custom.
   */
  it("refuses a claim naming the other kind's template, even when the text matches it", () => {
    expect(
      resolveConsentTemplate({
        kind: "recorded",
        consentText: DEFAULT_SURVEY_CONSENT_TEXT,
        claimedTemplateId: SURVEY_CONSENT_TEMPLATE_ID,
        claimedTemplateVersion: 1
      })
    ).toEqual({ id: CUSTOM_CONSENT_TEMPLATE_ID, version: null });

    expect(
      resolveConsentTemplate({
        kind: "survey",
        consentText: DEFAULT_CONSENT_TEXT,
        claimedTemplateId: RECORDED_CONSENT_TEMPLATE_ID,
        claimedTemplateVersion: 1
      })
    ).toEqual({ id: CUSTOM_CONSENT_TEMPLATE_ID, version: null });
  });

  it("ignores a claim naming a version nothing was ever published as", () => {
    expect(
      resolveConsentTemplate({
        kind: "recorded",
        consentText: DEFAULT_CONSENT_TEXT,
        claimedTemplateId: RECORDED_CONSENT_TEMPLATE_ID,
        claimedTemplateVersion: 99
      })
      // Falls through to the current-version comparison, which the text does
      // match - so an invented version number cannot make approved wording read
      // as custom, and cannot invent an approval either.
    ).toEqual({ id: RECORDED_CONSENT_TEMPLATE_ID, version: 1 });
  });

  it("treats a claim of `custom` as no claim", () => {
    expect(
      resolveConsentTemplate({
        kind: "recorded",
        consentText: DEFAULT_CONSENT_TEXT,
        claimedTemplateId: CUSTOM_CONSENT_TEMPLATE_ID,
        claimedTemplateVersion: null
      })
    ).toEqual({ id: RECORDED_CONSENT_TEMPLATE_ID, version: 1 });
  });

  /**
   * Whitespace alone must not mark a default as customised - a textarea adds a
   * trailing newline for free, and a study reading "Custom wording" because
   * somebody pressed Enter would train authors to ignore the badge.
   */
  it.each([
    ["a trailing newline", `${DEFAULT_CONSENT_TEXT}\n`],
    ["leading spaces", `   ${DEFAULT_CONSENT_TEXT}`],
    ["both", `\n\t${DEFAULT_CONSENT_TEXT}  \n`]
  ])("still recognises the template through %s", (_label, text) => {
    expect(
      resolveConsentTemplate({ kind: "recorded", consentText: text })
    ).toEqual({ id: RECORDED_CONSENT_TEMPLATE_ID, version: 1 });
  });

  /**
   * And the other direction, which is the one that matters more: trimming must
   * not be widened into normalising. A single changed word inside the sentence
   * is a deviation, and a comparison that collapsed whitespace or folded case
   * would be one step away from missing it.
   */
  it("does not treat a changed word as whitespace", () => {
    const altered = DEFAULT_CONSENT_TEXT.replace(
      "is visible to the research team",
      "is visible to the research team and our client"
    );

    expect(altered).not.toBe(DEFAULT_CONSENT_TEXT);
    expect(
      resolveConsentTemplate({ kind: "recorded", consentText: altered })
    ).toEqual({ id: CUSTOM_CONSENT_TEMPLATE_ID, version: null });
  });
});

describe("consentTextMatches", () => {
  it("trims both sides and compares nothing else", () => {
    expect(consentTextMatches("  a b  ", "a b")).toBe(true);
    expect(consentTextMatches("a b", "a  b")).toBe(false);
    expect(consentTextMatches("a b", "A b")).toBe(false);
  });
});

describe("isCustomConsentTemplate", () => {
  /**
   * Null, undefined and an unrecognised id all read as custom, and that is a
   * decision rather than a convenience: a row whose provenance nobody
   * established has not been approved, and the only unsafe direction here is
   * showing an approval badge on wording nothing checked.
   */
  it.each([
    [null],
    [undefined],
    [""],
    ["something-invented"],
    [CUSTOM_CONSENT_TEMPLATE_ID]
  ])("reads %s as custom", (id) => {
    expect(isCustomConsentTemplate(id as string | null | undefined)).toBe(true);
  });

  it.each([[RECORDED_CONSENT_TEMPLATE_ID], [SURVEY_CONSENT_TEMPLATE_ID]])(
    "does not read %s as custom",
    (id) => {
      expect(isCustomConsentTemplate(id)).toBe(false);
    }
  );
});

describe("namedConsentTemplate", () => {
  it("names a template without needing the version to be one that exists", () => {
    expect(namedConsentTemplate(SURVEY_CONSENT_TEMPLATE_ID)).toEqual(SURVEY_V1);
  });

  it("names nothing for custom wording or an id nothing published", () => {
    expect(namedConsentTemplate(CUSTOM_CONSENT_TEMPLATE_ID)).toBeNull();
    expect(namedConsentTemplate(null)).toBeNull();
    expect(namedConsentTemplate("invented-later")).toBeNull();
  });
});

/**
 * The behaviour the `consent_template_version` COLUMN exists for, tested
 * against a synthetic registry because the shipped one holds a single version
 * per id and therefore cannot exercise it.
 *
 * This is not hypothetical coverage. With one version per id the selection rule
 * was a seedless `reduce` over a one-element array, which returns that element
 * WITHOUT calling the comparison - so the comparison was dead code, an inverted
 * `>` survived a mutation pass unnoticed, and the promise these columns make
 * ("a study written against v1 stays attributed to v1 after v2 ships") had
 * never once been executed. The registry parameter exists so that it can be.
 */
describe("version selection, against a two-version registry", () => {
  const V1: ConsentTemplateVersion = {
    id: RECORDED_CONSENT_TEMPLATE_ID,
    version: 1,
    kind: "recorded",
    name: "Recorded consent",
    summary: "The first wording",
    text: "Version one wording."
  };
  const V2: ConsentTemplateVersion = {
    ...V1,
    version: 2,
    text: "Version two wording, which says more."
  };
  // Deliberately NOT in version order: the rule has to pick the highest
  // version, not the last entry, and a list already sorted cannot tell the two
  // apart.
  const REGISTRY = [V2, V1];

  it("treats the highest version as current, whatever order the registry is in", () => {
    expect(currentConsentTemplate("recorded", REGISTRY)).toEqual(V2);
    expect(currentConsentTemplate("recorded", [V1, V2])).toEqual(V2);
  });

  it("keeps a v1 study on v1 once v2 has shipped", () => {
    // THE test. Without the claim this resolves against v2's text, does not
    // match, and mass-reclassifies every untouched v1 study as `custom`.
    expect(
      resolveConsentTemplate(
        {
          kind: "recorded",
          consentText: V1.text,
          claimedTemplateId: V1.id,
          claimedTemplateVersion: 1
        },
        REGISTRY
      )
    ).toEqual({ id: V1.id, version: 1 });
  });

  it("recognises v2 wording as v2 even when the claim says v1", () => {
    expect(
      resolveConsentTemplate(
        {
          kind: "recorded",
          consentText: V2.text,
          claimedTemplateId: V1.id,
          claimedTemplateVersion: 1
        },
        REGISTRY
      )
    ).toEqual({ id: V2.id, version: 2 });
  });

  it("still refuses wording that is neither version", () => {
    expect(
      resolveConsentTemplate(
        {
          kind: "recorded",
          consentText: "Something a researcher wrote",
          claimedTemplateId: V1.id,
          claimedTemplateVersion: 1
        },
        REGISTRY
      )
    ).toEqual({ id: CUSTOM_CONSENT_TEMPLATE_ID, version: null });
  });

  it("names the latest version of a template when asked for it by id alone", () => {
    expect(namedConsentTemplate(V1.id, REGISTRY)).toEqual(V2);
  });
});

describe("the template registry", () => {
  it("publishes exactly one template per kind, at version 1", () => {
    expect(allConsentTemplates().map((template) => [template.id, template.version])).toEqual(
      [
        [RECORDED_CONSENT_TEMPLATE_ID, 1],
        [SURVEY_CONSENT_TEMPLATE_ID, 1],
        [MODERATED_CONSENT_TEMPLATE_ID, 1]
      ]
    );
  });

  it("hands out a copy, so a caller cannot edit the registry in place", () => {
    const first = allConsentTemplates();
    first.length = 0;
    expect(allConsentTemplates()).toHaveLength(3);
  });

  it("carries the two shipped defaults verbatim", () => {
    expect(RECORDED_V1.text).toBe(DEFAULT_CONSENT_TEXT);
    expect(SURVEY_V1.text).toBe(DEFAULT_SURVEY_CONSENT_TEXT);
    expect(RECORDED_V1.kind).toBe("recorded");
    expect(SURVEY_V1.kind).toBe("survey");
  });

  it("has a name and a summary for every version, because the author sees them in place of the wording", () => {
    for (const template of allConsentTemplates()) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.summary.length).toBeGreaterThan(0);
    }
  });

  it("returns null for a version nothing published", () => {
    expect(findConsentTemplate(RECORDED_CONSENT_TEMPLATE_ID, 2)).toBeNull();
    expect(findConsentTemplate("no-such-template", 1)).toBeNull();
  });
});

/**
 * The migration cannot import TypeScript, so version 1's wording exists twice:
 * here, and as a SQL literal in `0013_firsthand_consent_template.sql` which
 * classified every row that predated this module.
 *
 * That duplication is unavoidable and a migration's checksum is frozen the
 * moment it is applied, so the file can never be corrected. What CAN be caught
 * is the other half drifting: editing `DEFAULT_CONSENT_TEXT` is publishing a
 * new version of the wording, not amending version 1, and doing it in place
 * would leave the migration describing a version that no longer exists and
 * every backfilled row claiming wording nobody can now read. This fails when
 * that happens, and the fix is to add version 2 to the registry rather than to
 * edit the string.
 */
describe("migration 0013's embedded copy of version 1", () => {
  const sql = readFileSync(
    path.resolve(
      __dirname,
      "../../db/firsthand-migrations/0013_firsthand_consent_template.sql"
    ),
    "utf8"
  );

  it("still contains the exact recorded wording it classified against", () => {
    expect(sql).toContain(DEFAULT_CONSENT_TEXT);
  });

  it("still contains the exact survey wording it classified against", () => {
    expect(sql).toContain(DEFAULT_SURVEY_CONSENT_TEXT);
  });

  it("names the same two template ids the registry does", () => {
    expect(sql).toContain(`'${RECORDED_CONSENT_TEMPLATE_ID}'`);
    expect(sql).toContain(`'${SURVEY_CONSENT_TEMPLATE_ID}'`);
    expect(sql).toContain(`'${CUSTOM_CONSENT_TEMPLATE_ID}'`);
  });

  /**
   * The backfill's LOGIC, not only its wording.
   *
   * The three tests above pin the two literals, and an independent mutation
   * pass showed that is all they pin: swapping the survey arm to
   * `recorded-default`, stamping version 2, dropping the CHECK's version
   * requirement and widening `WHERE consent_template_id IS NULL` to `WHERE
   * true` all survived the entire suite. That backfill decides the initial and
   * permanent classification of every study that predates C1, and its checksum
   * freezes the moment it is applied - there is no second chance to notice.
   *
   * Pinned as TEXT because a migration cannot be executed here (CI runs the
   * backend suites with no Postgres) and because the file is immutable by
   * policy once applied - so a text pin can never legitimately false-fail, and
   * every edit to it is by definition a mistake worth failing on.
   */
  const flat = sql.replace(/\s+/g, " ");
  const caseBlock = (column: string): string => {
    const start = flat.indexOf(`${column} = CASE`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = flat.indexOf(" END", start);
    expect(end).toBeGreaterThan(start);
    return flat.slice(start, end);
  };

  it("classifies each kind against its OWN template, not the other one", () => {
    const ids = caseBlock("consent_template_id");

    expect(ids).toContain(
      `WHEN kind = 'survey' AND btrim(consent_text) = btrim('${DEFAULT_SURVEY_CONSENT_TEXT}') THEN 'survey-default'`
    );
    expect(ids).toContain(
      `WHEN kind <> 'survey' AND btrim(consent_text) = btrim('${DEFAULT_CONSENT_TEXT}') THEN 'recorded-default'`
    );
    // And everything else is custom - the safe direction, and the only one that
    // cannot assert an approval nothing checked.
    expect(ids).toContain("ELSE 'custom'");
    expect(ids).not.toContain("ELSE 'recorded-default'");
    expect(ids).not.toContain("ELSE 'survey-default'");
  });

  it("stamps version 1, and only version 1, on both matched arms", () => {
    const versions = caseBlock("consent_template_version");

    expect(versions).toContain(
      `WHEN kind = 'survey' AND btrim(consent_text) = btrim('${DEFAULT_SURVEY_CONSENT_TEXT}') THEN 1`
    );
    expect(versions).toContain(
      `WHEN kind <> 'survey' AND btrim(consent_text) = btrim('${DEFAULT_CONSENT_TEXT}') THEN 1`
    );
    expect(versions).toContain("ELSE NULL");
    // Version 1 is the only version this migration could possibly have
    // classified against, because it is the only version that existed when it
    // was written.
    expect(versions).not.toMatch(/THEN [02-9]/);
  });

  it("touches only rows nothing has classified yet", () => {
    // `WHERE true` would re-stamp rows a later release had already classified,
    // including any correction made after this migration ran.
    expect(flat).toContain("WHERE consent_template_id IS NULL");
    expect(flat).not.toMatch(/UPDATE firsthand\.studies[^;]*WHERE true/);
  });

  it("constrains the pair to its three legal shapes, version included", () => {
    const check = flat.slice(
      flat.indexOf("CHECK ("),
      flat.indexOf("END $$", flat.indexOf("CHECK ("))
    );

    expect(check).toContain(
      "(consent_template_id IS NULL AND consent_template_version IS NULL)"
    );
    expect(check).toContain(
      "(consent_template_id = 'custom' AND consent_template_version IS NULL)"
    );
    // The arm that stops a named template being stored with no version - a row
    // that cannot answer the one question these columns exist to answer.
    expect(check).toContain(
      "(consent_template_id <> 'custom' AND consent_template_version IS NOT NULL)"
    );
  });
});

/**
 * `DEFAULT_CONSENT_TEXT` has had a pinning test since the day a sentence in it
 * promised a stop control the recording flow does not have.
 * `DEFAULT_SURVEY_CONSENT_TEXT` has never had one, and now that both are
 * version 1 of a governed template - the wording an author is shown and told is
 * approved - the asymmetry is not defensible.
 */
describe("DEFAULT_SURVEY_CONSENT_TEXT", () => {
  it("does not describe a recording, because a survey records nothing", () => {
    expect(DEFAULT_SURVEY_CONSENT_TEXT).not.toMatch(/records your screen/i);
    expect(DEFAULT_SURVEY_CONSENT_TEXT).not.toMatch(/screen share|sharing/i);
    expect(DEFAULT_SURVEY_CONSENT_TEXT).not.toMatch(/microphone will|we record/i);
  });

  it("says plainly that nothing is captured", () => {
    expect(DEFAULT_SURVEY_CONSENT_TEXT).toMatch(/nothing is recorded/i);
    expect(DEFAULT_SURVEY_CONSENT_TEXT).toMatch(/camera/i);
  });

  it("says what happens to answers already given, because leaving is allowed", () => {
    expect(DEFAULT_SURVEY_CONSENT_TEXT).toMatch(/close the page/i);
    expect(DEFAULT_SURVEY_CONSENT_TEXT).toMatch(/already answered is kept/i);
  });

  it("is not the recorded wording", () => {
    expect(DEFAULT_SURVEY_CONSENT_TEXT).not.toBe(DEFAULT_CONSENT_TEXT);
  });
});

describe("DEFAULT_MODERATED_CONSENT_TEXT (#79)", () => {
  it("says the recording, when there is one, is the meeting platform's", () => {
    // The central factual difference from the recorded template: Cortex does
    // not capture the call. Claiming it does would be false copy.
    expect(DEFAULT_MODERATED_CONSENT_TEXT).toMatch(/recorded on the meeting platform/i);
    expect(DEFAULT_MODERATED_CONSENT_TEXT).not.toMatch(/records your screen/i);
    expect(DEFAULT_MODERATED_CONSENT_TEXT).not.toMatch(/screen share|sharing/i);
  });

  it("says 'may be', never 'is', about recording", () => {
    // A researcher can run an unrecorded session under this consent; wording
    // that promises recording always happens would be wrong about those.
    expect(DEFAULT_MODERATED_CONSENT_TEXT).toMatch(/may be recorded/i);
    expect(DEFAULT_MODERATED_CONSENT_TEXT).not.toMatch(/will be recorded/i);
  });

  it("covers the transcript, because ingest stores one alongside the recording", () => {
    expect(DEFAULT_MODERATED_CONSENT_TEXT).toMatch(/transcript/i);
  });

  it("tells the participant how to decline, and what happens to what exists", () => {
    expect(DEFAULT_MODERATED_CONSENT_TEXT).toMatch(/decline/i);
    expect(DEFAULT_MODERATED_CONSENT_TEXT).toMatch(/up to that point/i);
  });

  it("is neither of the other two wordings", () => {
    expect(DEFAULT_MODERATED_CONSENT_TEXT).not.toBe(DEFAULT_CONSENT_TEXT);
    expect(DEFAULT_MODERATED_CONSENT_TEXT).not.toBe(DEFAULT_SURVEY_CONSENT_TEXT);
  });
});

describe("the moderated kind never reaches firsthand.studies (#79)", () => {
  /*
   * `moderated` consent is anchored on the OPPORTUNITY row: a moderated session
   * has no study, and `studies_kind_check` (migration 0009) permits exactly
   * ('recorded','survey'). These pins hold the boundary from both sides - the
   * migration must not learn the kind, and the kind must not silently become a
   * studies value - because the failure mode is an INSERT that violates the
   * CHECK in production, long after every unit test has passed.
   */
  const kindCheckSql = readFileSync(
    path.resolve(__dirname, "../../db/firsthand-migrations/0009_firsthand_study_kind.sql"),
    "utf8"
  );

  it("migration 0009's CHECK still names exactly recorded and survey", () => {
    expect(kindCheckSql).toMatch(/kind IN \('recorded',\s*'survey'\)/);
    expect(kindCheckSql).not.toMatch(/moderated/);
  });

  it("migration 0013 never classifies against the moderated template", () => {
    const sql0013 = readFileSync(
      path.resolve(__dirname, "../../db/firsthand-migrations/0013_firsthand_consent_template.sql"),
      "utf8"
    );
    expect(sql0013).not.toMatch(/moderated/);
  });
});

describe("bookingConsentText (audit row 9 - baseline on the booking path)", () => {
  // Pinned as literals: the set is a governance decision, and deriving the
  // expectation from the constant under test could not see it change.
  it("is exactly the two moderated bookable types", () => {
    expect([...MODERATED_CONSENT_TYPES].sort()).toEqual(["interview", "test"]);
  });

  it.each(["test", "interview"])(
    "returns the Cortex baseline for a %s with no wording of its own",
    (type) => {
      expect(bookingConsentText(type, null)).toBe(MODERATED_CONSENT_TEMPLATE.text);
      expect(bookingConsentText(type, "")).toBe(MODERATED_CONSENT_TEMPLATE.text);
      expect(bookingConsentText(type, "   ")).toBe(MODERATED_CONSENT_TEMPLATE.text);
    }
  );

  it("returns a moderated opportunity's OWN wording, trimmed, over the baseline", () => {
    expect(bookingConsentText("test", "  We record the call.  ")).toBe("We record the call.");
  });

  it.each(["survey", "poll", "question", "unmoderated"])(
    "returns '' for %s - a non-moderated type has nothing to accept",
    (type) => {
      expect(bookingConsentText(type, null)).toBe("");
      // A stray stored string on a non-moderated type is still not booking
      // consent - no phantom step.
      expect(bookingConsentText(type, "leftover text")).toBe("");
    }
  );

  it("the baseline it returns is the current moderated template's wording", () => {
    expect(MODERATED_CONSENT_TEMPLATE.text).toBe(DEFAULT_MODERATED_CONSENT_TEXT);
    expect(MODERATED_CONSENT_TEMPLATE.id).toBe(MODERATED_CONSENT_TEMPLATE_ID);
  });

  // A single stable assertion (not table-driven) so the mutation canary can name
  // one test that fails when the baseline fallback is dropped.
  it("a live session with no wording of its own falls back to the moderated baseline", () => {
    expect(bookingConsentText("test", null)).toBe(MODERATED_CONSENT_TEMPLATE.text);
  });
});
