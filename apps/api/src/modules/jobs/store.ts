import { randomUUID } from 'node:crypto';
import type { Job, JobStatus, JobStep } from '@agentic-os/contracts';
import { query, queryOne, transaction } from '../../db/client';

/**
 * Хранилище задач.
 *
 * Задача — персистентный автомат, а не сообщение в чате: бытовые дела ждут
 * ответа врача, доставку и наступления вторника. Всё состояние в базе,
 * ничего в памяти процесса — иначе деплой тихо теряет задачи, а это худший
 * вид отказа для ассистента.
 */

interface JobRow {
  id: string;
  user_id: string;
  goal: string;
  status: JobStatus;
  artifacts: Job['artifacts'];
  graph_refs: string[];
  budget: Partial<Job['budget']>;
  wake_at: Date | null;
  pending_question: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StepRow {
  id: string;
  job_id: string;
  idx: number;
  title: string;
  tool: string;
  args: Record<string, unknown>;
  idempotency_key: string;
  status: JobStep['status'];
  depends_on: number[];
  result: unknown;
  error: string | null;
  attempts: number;
  max_attempts: number;
  postconditions: string[];
  compensation: { tool: string; args: Record<string, unknown> } | null;
}

const DEFAULT_BUDGET: Job['budget'] = {
  maxToolCalls: 40,
  maxCostRub: 25,
  maxDurationMs: 7 * 24 * 3600 * 1000,
  spentRub: 0,
  toolCalls: 0,
};

function toStep(row: StepRow): JobStep {
  return {
    id: row.id,
    idx: row.idx,
    tool: row.tool,
    args: row.args ?? {},
    idempotencyKey: row.idempotency_key,
    status: row.status,
    dependsOn: row.depends_on ?? [],
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    postconditions: row.postconditions ?? [],
  };
}

function toJob(row: JobRow, steps: StepRow[] = []): Job {
  return {
    id: row.id,
    userId: row.user_id,
    goal: row.goal,
    status: row.status,
    steps: steps.map(toStep),
    artifacts: row.artifacts ?? [],
    graphRefs: row.graph_refs ?? [],
    budget: { ...DEFAULT_BUDGET, ...row.budget },
    wakeAt: row.wake_at ? row.wake_at.toISOString() : null,
    pendingQuestion: row.pending_question,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Шаг плана до записи в базу. */
export interface PlanStep {
  title: string;
  tool: string;
  args: Record<string, unknown>;
  dependsOn?: number[];
  postconditions?: string[];
  compensation?: { tool: string; args: Record<string, unknown> };
  maxAttempts?: number;
}

export async function createJob(input: {
  userId: string;
  goal: string;
  plan: readonly PlanStep[];
  status?: JobStatus;
}): Promise<Job> {
  return transaction(async (client) => {
    const jobRes = await client.query<JobRow>(
      `INSERT INTO job (user_id, goal, status, artifacts, graph_refs, budget)
       VALUES ($1, $2, $3, '[]'::jsonb, '[]'::jsonb, $4)
       RETURNING *`,
      [input.userId, input.goal, input.status ?? 'running', JSON.stringify(DEFAULT_BUDGET)]
    );
    const jobRow = jobRes.rows[0];
    if (!jobRow) throw new Error('failed to create job');

    const steps: StepRow[] = [];
    for (const [idx, step] of input.plan.entries()) {
      const res = await client.query<StepRow>(
        `INSERT INTO job_step
           (job_id, idx, title, tool, args, idempotency_key, status, depends_on, postconditions, compensation, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10)
         RETURNING *`,
        [
          jobRow.id,
          idx,
          step.title,
          step.tool,
          JSON.stringify(step.args),
          // Ключ детерминирован по задаче и позиции: ретрай не создаёт
          // второй побочный эффект, потому что ключ тот же.
          `${jobRow.id}:${idx}:${step.tool}`,
          JSON.stringify(step.dependsOn ?? (idx > 0 ? [idx - 1] : [])),
          JSON.stringify(step.postconditions ?? []),
          step.compensation ? JSON.stringify(step.compensation) : null,
          step.maxAttempts ?? 3,
        ]
      );
      const row = res.rows[0];
      if (row) steps.push(row);
    }

    return toJob(jobRow, steps);
  });
}

export async function getJob(jobId: string, userId?: string): Promise<Job | null> {
  const row = userId
    ? await queryOne<JobRow>('SELECT * FROM job WHERE id = $1 AND user_id = $2', [jobId, userId])
    : await queryOne<JobRow>('SELECT * FROM job WHERE id = $1', [jobId]);
  if (!row) return null;
  const steps = await query<StepRow>('SELECT * FROM job_step WHERE job_id = $1 ORDER BY idx', [jobId]);
  return toJob(row, steps);
}

export async function listJobs(userId: string, limit = 30): Promise<Job[]> {
  const rows = await query<JobRow>(
    `SELECT * FROM job WHERE user_id = $1 AND status <> 'cancelled'
      ORDER BY updated_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows.map((r) => toJob(r));
}

export async function setStatus(
  jobId: string,
  status: JobStatus,
  extra?: { pendingQuestion?: string | null; wakeAt?: string | null; lastError?: string | null }
): Promise<void> {
  await query(
    `UPDATE job
        SET status = $2,
            pending_question = $3,
            wake_at = $4,
            last_error = COALESCE($5, last_error),
            updated_at = now()
      WHERE id = $1`,
    [jobId, status, extra?.pendingQuestion ?? null, extra?.wakeAt ?? null, extra?.lastError ?? null]
  );
}

/**
 * Запомнить, чьего ответа ждёт задача.
 *
 * Без этих полей компонент «жду ответа от X» нечем наполнить, а без него
 * ось «чей ход» отвечает только за два состояния из четырёх.
 */
export async function setAwaiting(
  jobId: string,
  awaiting: { who: string; usually?: string | undefined } | null
): Promise<void> {
  await query(
    `UPDATE job
        SET awaiting_who = $2,
            awaiting_usually = $3,
            awaiting_since = CASE WHEN $2::text IS NULL THEN NULL ELSE COALESCE(awaiting_since, now()) END,
            updated_at = now()
      WHERE id = $1`,
    [jobId, awaiting?.who ?? null, awaiting?.usually ?? null]
  );
}

/** Объявленное намерение: что агент собирается сделать и что уйдёт наружу. */
export async function setIntent(
  jobId: string,
  intent: { title: string; after: string; discloses: string } | null
): Promise<void> {
  await query(
    `UPDATE job SET intent = $2::jsonb, updated_at = now() WHERE id = $1`,
    [jobId, intent ? JSON.stringify(intent) : null]
  );
}

export async function addArtifact(
  jobId: string,
  artifact: { kind: 'miniapp' | 'document' | 'draft' | 'report'; id: string; title: string }
): Promise<void> {
  await query(
    `UPDATE job SET artifacts = artifacts || $2::jsonb, updated_at = now() WHERE id = $1`,
    [jobId, JSON.stringify([artifact])]
  );
}

export async function chargeBudget(jobId: string, rub: number): Promise<Job['budget'] | null> {
  const row = await queryOne<{ budget: Job['budget'] }>(
    `UPDATE job
        SET budget = jsonb_set(
              jsonb_set(budget, '{toolCalls}', to_jsonb(COALESCE((budget->>'toolCalls')::int, 0) + 1)),
              '{spentRub}', to_jsonb(COALESCE((budget->>'spentRub')::numeric, 0) + $2::numeric))
      WHERE id = $1
      RETURNING budget`,
    [jobId, rub]
  );
  return row?.budget ?? null;
}

/* ------------------------------------------------------------------ */
/* Шаги                                                                */
/* ------------------------------------------------------------------ */

/**
 * Шаги, готовые к исполнению: все зависимости выполнены и не наступает
 * пауза перед повтором.
 */
export async function runnableSteps(jobId: string): Promise<JobStep[]> {
  const rows = await query<StepRow>(
    `SELECT s.* FROM job_step s
      WHERE s.job_id = $1
        AND s.status = 'pending'
        AND (s.next_retry_at IS NULL OR s.next_retry_at <= now())
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(s.depends_on) AS dep
          JOIN job_step d ON d.job_id = s.job_id AND d.idx = dep::int
          WHERE d.status <> 'done' AND d.status <> 'skipped'
        )
      ORDER BY s.idx`,
    [jobId]
  );
  return rows.map(toStep);
}

export async function stepsOf(jobId: string): Promise<Array<JobStep & { title: string; compensation: StepRow['compensation'] }>> {
  const rows = await query<StepRow>('SELECT * FROM job_step WHERE job_id = $1 ORDER BY idx', [jobId]);
  return rows.map((r) => ({ ...toStep(r), title: r.title, compensation: r.compensation }));
}

/**
 * Взять шаг в работу.
 *
 * Условный UPDATE, а не безусловный: между `runnableSteps` и этим вызовом
 * есть окно, в которое второй исполнитель успевает прочитать тот же шаг
 * как `pending`. Гарантию даёт база — переход `pending → running` выигрывает
 * ровно один, остальные получают `false` и шаг пропускают.
 *
 * Без этого долгий шаг (поиск, планирование) исполнялся дважды, и для
 * инструмента без ключа идемпотентности это второе напоминание.
 */
export async function markStepRunning(stepId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE job_step SET status = 'running', attempts = attempts + 1, started_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [stepId]
  );
  return row !== null;
}

/**
 * Вернуть шаг в очередь, не считая попытку неудачной.
 *
 * Нужен, когда шаг остановлен не ошибкой, а ожиданием решения человека:
 * подтвердит — тот же шаг выполнится, и это не «второй заход».
 */
export async function markStepPending(stepId: string): Promise<void> {
  await query(
    `UPDATE job_step SET status = 'pending', attempts = GREATEST(attempts - 1, 0), started_at = NULL WHERE id = $1`,
    [stepId]
  );
}

export async function markStepDone(stepId: string, result: unknown): Promise<void> {
  await query(
    `UPDATE job_step SET status = 'done', result = $2, error = NULL, finished_at = now() WHERE id = $1`,
    [stepId, JSON.stringify(result ?? null)]
  );
}

/**
 * Провал шага. Пока попытки не исчерпаны — возвращаем в pending с паузой
 * (экспоненциальная выдержка), иначе помечаем failed окончательно.
 */
export async function markStepFailed(
  stepId: string,
  error: string
): Promise<{ willRetry: boolean; attempts: number }> {
  const row = await queryOne<{ attempts: number; max_attempts: number }>(
    'SELECT attempts, max_attempts FROM job_step WHERE id = $1',
    [stepId]
  );
  const attempts = row?.attempts ?? 1;
  const willRetry = attempts < (row?.max_attempts ?? 3);

  if (willRetry) {
    const delaySeconds = Math.min(2 ** attempts, 300);
    await query(
      `UPDATE job_step
          SET status = 'pending', error = $2, next_retry_at = now() + ($3 || ' seconds')::interval
        WHERE id = $1`,
      [stepId, error, String(delaySeconds)]
    );
  } else {
    await query(
      `UPDATE job_step SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [stepId, error]
    );
  }
  return { willRetry, attempts };
}

export async function markStepCompensated(stepId: string): Promise<void> {
  await query(`UPDATE job_step SET status = 'compensated' WHERE id = $1`, [stepId]);
}

/**
 * Уже выполненный шаг с тем же ключом идемпотентности.
 * Защита от повторного побочного эффекта при перезапуске воркера.
 */
export async function completedByKey(key: string): Promise<unknown | undefined> {
  const row = await queryOne<{ result: unknown }>(
    `SELECT result FROM job_step WHERE idempotency_key = $1 AND status = 'done'`,
    [key]
  );
  return row ? row.result : undefined;
}

/* ------------------------------------------------------------------ */
/* Аренда воркером                                                     */
/* ------------------------------------------------------------------ */

const LEASE_MS = 60_000;

/**
 * Взять задачу в работу. `FOR UPDATE SKIP LOCKED` плюс срок аренды —
 * две реплики не возьмут одну задачу, а упавший воркер не заблокирует её
 * навсегда: аренда истечёт и задачу подберут снова.
 */
export async function claimJobs(workerId: string, limit = 5): Promise<Job[]> {
  const rows = await query<JobRow>(
    `UPDATE job SET locked_by = $1, locked_until = now() + ($3 || ' milliseconds')::interval
      WHERE id IN (
        SELECT id FROM job
         WHERE (
                 (status IN ('planning', 'running'))
              OR (status = 'waiting_world' AND wake_at IS NOT NULL AND wake_at <= now())
               )
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY updated_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [workerId, limit, String(LEASE_MS)]
  );
  return rows.map((r) => toJob(r));
}

/**
 * Взять в работу одну конкретную задачу.
 *
 * Нужна потоку SSE: он ведёт задачу синхронно, чтобы отдать пользователю
 * прогресс, и обязан делать это под той же арендой, что и фоновый воркер.
 * Раньше он исполнял шаги вообще без аренды — два драйвера вели одну
 * задачу одновременно.
 */
export async function claimJob(jobId: string, workerId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE job SET locked_by = $2, locked_until = now() + ($3 || ' milliseconds')::interval
      WHERE id = $1 AND (locked_until IS NULL OR locked_until < now())
      RETURNING id`,
    [jobId, workerId, String(LEASE_MS)]
  );
  return row !== null;
}

export async function extendLease(jobId: string, workerId: string): Promise<void> {
  await query(
    `UPDATE job SET locked_until = now() + ($3 || ' milliseconds')::interval
      WHERE id = $1 AND locked_by = $2`,
    [jobId, workerId, String(LEASE_MS)]
  );
}

export async function releaseJob(jobId: string): Promise<void> {
  await query('UPDATE job SET locked_until = NULL, locked_by = NULL WHERE id = $1', [jobId]);
}

export function newWorkerId(): string {
  return `worker-${randomUUID().slice(0, 8)}`;
}
