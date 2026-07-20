
import type { PoolClient } from "pg";

import { stepTypeSchema, type Study, type StudyStep } from "../../../shared/firsthand/contract";
import {
  isPostgresRuntimeConfigured,
  withRuntimeDatabaseClient
} from "./runtime-database";

export type StudyStatus = "draft" | "launched" | "archived";

export type StudyRecord = Study & {
  status: StudyStatus;
  created_at: string;
  updated_at: string;
};

export type StudyWithSteps = {
  study: StudyRecord;
  steps: StudyStep[];
};

export type CreateStudyInput = {
  id?: string;
  title: string;
  intro_text: string;
  consent_text: string;
  brand_name?: string;
  estimated_duration_minutes?: number;
  locale?: string;
  status?: StudyStatus;
  steps: StudyStep[];
};

export type UpdateStudyInput = {
  title?: string;
  intro_text?: string;
  consent_text?: string;
  brand_name?: string | null;
  estimated_duration_minutes?: number | null;
  locale?: string | null;
  status?: StudyStatus;
  steps?: StudyStep[];
};

type StudyRow = {
  id: string;
  title: string;
  intro_text: string;
  consent_text: string;
  brand_name: string | null;
  estimated_duration_minutes: number | null;
  locale: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type StudyStepRow = {
  id: string;
  study_id: string;
  step_order: number;
  type: string;
  prompt: string;
  target_url: string | null;
  helper_text: string | null;
  is_required: boolean;
  options: string[] | null;
};

export function isStudiesPersistenceConfigured() {
  return isPostgresRuntimeConfigured();
}

export async function listStudies(): Promise<StudyRecord[]> {
  if (!isPostgresRuntimeConfigured()) {
    return [];
  }

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query<StudyRow>(
      `
        SELECT id, title, intro_text, consent_text, brand_name,
               estimated_duration_minutes, locale, status, created_at, updated_at
        FROM studies
        ORDER BY updated_at DESC, title ASC
      `
    );

    return result.rows.map(mapStudyRow);
  });
}

export async function getStudyById(studyId: string): Promise<StudyWithSteps | null> {
  if (!isPostgresRuntimeConfigured()) {
    return null;
  }

  return withRuntimeDatabaseClient(async (client) => {
    return loadStudyWithSteps(client, studyId);
  });
}

export async function createStudy(input: CreateStudyInput): Promise<StudyWithSteps> {
  ensurePostgresConfigured();
  validateSteps(input.steps);

  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const studyId = input.id ?? `study_${crypto.randomUUID()}`;
      const status = input.status ?? "draft";

      await client.query(
        `
          INSERT INTO studies (
            id, title, intro_text, consent_text, brand_name,
            estimated_duration_minutes, locale, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          studyId,
          input.title,
          input.intro_text,
          input.consent_text,
          input.brand_name ?? null,
          input.estimated_duration_minutes ?? null,
          input.locale ?? null,
          status
        ]
      );

      await insertStudySteps(client, studyId, input.steps);

      const stored = await loadStudyWithSteps(client, studyId);

      if (!stored) {
        throw new Error("Study was inserted but could not be re-loaded.");
      }

      await client.query("COMMIT");
      return stored;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function updateStudy(
  studyId: string,
  input: UpdateStudyInput
): Promise<StudyWithSteps | null> {
  ensurePostgresConfigured();

  if (input.steps) {
    validateSteps(input.steps);
  }

  return withRuntimeDatabaseClient(async (client) => {
    await client.query("BEGIN");

    try {
      const existing = await loadStudyWithSteps(client, studyId);

      if (!existing) {
        await client.query("COMMIT");
        return null;
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown) => {
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      };

      if (input.title !== undefined) push("title", input.title);
      if (input.intro_text !== undefined) push("intro_text", input.intro_text);
      if (input.consent_text !== undefined) push("consent_text", input.consent_text);
      if (input.brand_name !== undefined) push("brand_name", input.brand_name);
      if (input.estimated_duration_minutes !== undefined) {
        push("estimated_duration_minutes", input.estimated_duration_minutes);
      }
      if (input.locale !== undefined) push("locale", input.locale);
      if (input.status !== undefined) push("status", input.status);

      if (updates.length > 0) {
        updates.push("updated_at = NOW()");
        values.push(studyId);
        await client.query(
          `UPDATE studies SET ${updates.join(", ")} WHERE id = $${values.length}`,
          values
        );
      }

      if (input.steps) {
        await client.query(`DELETE FROM study_steps WHERE study_id = $1`, [studyId]);
        await insertStudySteps(client, studyId, input.steps);

        if (updates.length === 0) {
          await client.query(`UPDATE studies SET updated_at = NOW() WHERE id = $1`, [
            studyId
          ]);
        }
      }

      const stored = await loadStudyWithSteps(client, studyId);
      await client.query("COMMIT");
      return stored;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function deleteStudy(studyId: string): Promise<boolean> {
  ensurePostgresConfigured();

  return withRuntimeDatabaseClient(async (client) => {
    const result = await client.query(`DELETE FROM studies WHERE id = $1`, [studyId]);
    return (result.rowCount ?? 0) > 0;
  });
}

async function loadStudyWithSteps(
  client: PoolClient,
  studyId: string
): Promise<StudyWithSteps | null> {
  const studyResult = await client.query<StudyRow>(
    `
      SELECT id, title, intro_text, consent_text, brand_name,
             estimated_duration_minutes, locale, status, created_at, updated_at
      FROM studies
      WHERE id = $1
    `,
    [studyId]
  );
  const studyRow = studyResult.rows[0];

  if (!studyRow) {
    return null;
  }

  const stepResult = await client.query<StudyStepRow>(
    `
      SELECT id, study_id, step_order, type, prompt, target_url,
             helper_text, is_required, options
      FROM study_steps
      WHERE study_id = $1
      ORDER BY step_order ASC
    `,
    [studyId]
  );

  return {
    study: mapStudyRow(studyRow),
    steps: stepResult.rows.map(mapStudyStepRow)
  };
}

async function insertStudySteps(
  client: PoolClient,
  studyId: string,
  steps: StudyStep[]
) {
  for (const step of steps) {
    await client.query(
      `
        INSERT INTO study_steps (
          id, study_id, step_order, type, prompt, target_url,
          helper_text, is_required, options
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        step.step_id,
        studyId,
        step.order,
        step.type,
        step.prompt,
        step.target_url ?? null,
        step.helper_text ?? null,
        step.is_required ?? false,
        step.options ? JSON.stringify(step.options) : null
      ]
    );
  }
}

function mapStudyRow(row: StudyRow): StudyRecord {
  return {
    id: row.id,
    title: row.title,
    intro_text: row.intro_text,
    consent_text: row.consent_text,
    brand_name: row.brand_name ?? undefined,
    estimated_duration_minutes: row.estimated_duration_minutes ?? undefined,
    locale: row.locale ?? undefined,
    status: normalizeStudyStatus(row.status),
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at)
  };
}

function mapStudyStepRow(row: StudyStepRow): StudyStep {
  const stepType = stepTypeSchema.parse(row.type);

  return {
    step_id: row.id,
    order: row.step_order,
    type: stepType,
    prompt: row.prompt,
    target_url: row.target_url ?? undefined,
    helper_text: row.helper_text ?? undefined,
    is_required: row.is_required,
    options: row.options ?? undefined
  };
}

function normalizeStudyStatus(status: string): StudyStatus {
  if (status === "launched" || status === "archived") {
    return status;
  }

  return "draft";
}

function ensurePostgresConfigured() {
  if (!isPostgresRuntimeConfigured()) {
    throw new Error(
      "FirstHand studies require a configured PostgreSQL database. Set DATABASE_URL or POSTGRES_URL."
    );
  }
}

function validateSteps(steps: StudyStep[]) {
  if (steps.length === 0) {
    throw new Error("Study must include at least one step.");
  }

  const stepIds = new Set<string>();
  const stepOrders = new Set<number>();

  for (const step of steps) {
    if (stepIds.has(step.step_id)) {
      throw new Error(`Duplicate step_id: ${step.step_id}`);
    }

    if (stepOrders.has(step.order)) {
      throw new Error(`Duplicate step order: ${step.order}`);
    }

    if (step.type === "single_choice" && (!step.options || step.options.length < 2)) {
      throw new Error(
        `single_choice step "${step.step_id}" must include at least two options.`
      );
    }

    stepIds.add(step.step_id);
    stepOrders.add(step.order);
  }
}

function toIsoString(value: Date | string): string {
  return new Date(value).toISOString();
}
