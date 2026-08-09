import type { FactSource } from '@agentic-os/contracts';
import { query, queryOne, transaction } from '../../db/client';
import type { ExtractedFact } from '../orchestrator/llm';

/**
 * Life graph: запись и разрешение конфликтов.
 *
 * Главное свойство — ничего не удаляем физически. Устаревший факт закрывается
 * по времени и помечается superseded_by, чтобы ассистент мог сказать
 * «раньше ты говорил иначе», а не молча подменить правду.
 */

/** Приоритет источника при конфликте: прямое утверждение бьёт вывод. */
const SOURCE_RANK: Record<FactSource, number> = {
  user_said: 100,
  user_confirmed: 95,
  calendar: 70,
  contacts: 65,
  email: 60,
  procedure: 55,
  inferred: 20,
};

export async function recordEpisode(
  userId: string,
  kind: string,
  payload: unknown,
  jobId?: string | null
): Promise<void> {
  await query('INSERT INTO episode (user_id, kind, payload, job_id) VALUES ($1, $2, $3, $4)', [
    userId,
    kind,
    JSON.stringify(payload),
    jobId ?? null,
  ]);
}

export async function upsertEntity(
  userId: string,
  type: string,
  label: string
): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM entity WHERE user_id = $1 AND type = $2 AND lower(label) = lower($3) AND archived_at IS NULL',
    [userId, type, label]
  );
  if (existing) return existing.id;

  const created = await queryOne<{ id: string }>(
    'INSERT INTO entity (user_id, type, label) VALUES ($1, $2, $3) RETURNING id',
    [userId, type, label]
  );
  if (!created) throw new Error('failed to create entity');
  return created.id;
}

export interface AddFactInput {
  userId: string;
  subjectId: string;
  predicate: string;
  value?: string | undefined;
  source: FactSource;
  sourceRef?: string | undefined;
  confidence: number;
  validFrom?: string | null;
}

/**
 * Записать факт с разрешением конфликта против текущих фактов
 * того же субъекта и предиката.
 */
export async function addFact(input: AddFactInput): Promise<{ id: string; superseded: string | null }> {
  return transaction(async (client) => {
    const current = await client.query<{
      id: string;
      object_value: unknown;
      source: FactSource;
      confidence: number;
    }>(
      `SELECT id, object_value, source, confidence
         FROM fact
        WHERE user_id = $1 AND subject_id = $2 AND predicate = $3 AND valid_to IS NULL
        FOR UPDATE`,
      [input.userId, input.subjectId, input.predicate]
    );

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO fact
         (user_id, subject_id, predicate, object_value, source, source_ref, confidence, observed_at, valid_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
       RETURNING id`,
      [
        input.userId,
        input.subjectId,
        input.predicate,
        input.value === undefined ? null : JSON.stringify(input.value),
        input.source,
        input.sourceRef ?? null,
        input.confidence,
        input.validFrom ?? null,
      ]
    );
    const newId = inserted.rows[0]?.id;
    if (!newId) throw new Error('failed to insert fact');

    let superseded: string | null = null;

    for (const old of current.rows) {
      const sameValue = JSON.stringify(old.object_value) === JSON.stringify(input.value ?? null);
      if (sameValue) continue;

      const newRank = SOURCE_RANK[input.source] ?? 0;
      const oldRank = SOURCE_RANK[old.source] ?? 0;

      // Новый факт побеждает, если источник не слабее. При равном источнике
      // побеждает более свежее наблюдение — оно и есть новое.
      if (newRank >= oldRank) {
        await client.query(
          'UPDATE fact SET valid_to = now(), superseded_by = $1 WHERE id = $2',
          [newId, old.id]
        );
        superseded = old.id;
      } else {
        // Старый факт сильнее: новый сразу закрывается, но сохраняется —
        // это сигнал о противоречии, а не мусор.
        await client.query('UPDATE fact SET valid_to = now() WHERE id = $1', [newId]);
      }
    }

    return { id: newId, superseded };
  });
}

/** Записать пачку извлечённых фактов. Источник обязателен: без провенанса факт бесполезен. */
export async function ingestFacts(
  userId: string,
  facts: readonly ExtractedFact[],
  source: FactSource,
  sourceRef?: string
): Promise<number> {
  let written = 0;
  for (const f of facts) {
    const subjectId = await upsertEntity(userId, f.entityType, f.entityLabel);
    await addFact({
      userId,
      subjectId,
      predicate: f.predicate,
      value: f.value,
      source,
      sourceRef,
      confidence: f.confidence,
    });
    written += 1;
  }
  return written;
}

export interface GraphSnapshot {
  entities: number;
  facts: number;
  recent: Array<{ label: string; predicate: string; value: unknown; confidence: number; source: string }>;
}

/** Компактный срез графа — для экрана «что я о тебе знаю» и для отладки. */
export async function snapshot(userId: string, limit = 20): Promise<GraphSnapshot> {
  const [counts] = await query<{ entities: string; facts: string }>(
    `SELECT
       (SELECT count(*) FROM entity WHERE user_id = $1 AND archived_at IS NULL) AS entities,
       (SELECT count(*) FROM fact   WHERE user_id = $1 AND valid_to IS NULL)     AS facts`,
    [userId]
  );

  const recent = await query<{
    label: string;
    predicate: string;
    object_value: unknown;
    confidence: number;
    source: string;
  }>(
    `SELECT e.label, f.predicate, f.object_value, f.confidence, f.source
       FROM fact f JOIN entity e ON e.id = f.subject_id
      WHERE f.user_id = $1 AND f.valid_to IS NULL
      ORDER BY f.observed_at DESC
      LIMIT $2`,
    [userId, limit]
  );

  return {
    entities: Number(counts?.entities ?? 0),
    facts: Number(counts?.facts ?? 0),
    recent: recent.map((r) => ({
      label: r.label,
      predicate: r.predicate,
      value: r.object_value,
      confidence: r.confidence,
      source: r.source,
    })),
  };
}
