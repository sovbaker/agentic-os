import type { Job, JobStatus } from '@agentic-os/contracts';
import { query, queryOne } from '../../db/client';

/**
 * Хранилище задач.
 *
 * Задача — персистентный автомат, а не сообщение в чате: бытовые дела ждут
 * ответа врача, доставку и наступления вторника. Всё состояние в базе,
 * ничего в памяти процесса — иначе деплой тихо теряет задачи.
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
  created_at: Date;
  updated_at: Date;
}

const DEFAULT_BUDGET: Job['budget'] = {
  maxToolCalls: 40,
  maxCostRub: 25,
  maxDurationMs: 7 * 24 * 3600 * 1000,
  spentRub: 0,
  toolCalls: 0,
};

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    userId: row.user_id,
    goal: row.goal,
    status: row.status,
    steps: [],
    artifacts: row.artifacts ?? [],
    graphRefs: row.graph_refs ?? [],
    budget: { ...DEFAULT_BUDGET, ...row.budget },
    wakeAt: row.wake_at ? row.wake_at.toISOString() : null,
    pendingQuestion: row.pending_question,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function createJob(input: {
  userId: string;
  goal: string;
  status?: JobStatus;
  artifacts?: Job['artifacts'];
  graphRefs?: string[];
}): Promise<Job> {
  const row = await queryOne<JobRow>(
    `INSERT INTO job (user_id, goal, status, artifacts, graph_refs, budget)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.userId,
      input.goal,
      input.status ?? 'running',
      JSON.stringify(input.artifacts ?? []),
      JSON.stringify(input.graphRefs ?? []),
      JSON.stringify(DEFAULT_BUDGET),
    ]
  );
  if (!row) throw new Error('failed to create job');
  return toJob(row);
}

export async function getJob(userId: string, jobId: string): Promise<Job | null> {
  const row = await queryOne<JobRow>('SELECT * FROM job WHERE id = $1 AND user_id = $2', [jobId, userId]);
  return row ? toJob(row) : null;
}

export async function listJobs(userId: string, limit = 30): Promise<Job[]> {
  const rows = await query<JobRow>(
    `SELECT * FROM job
      WHERE user_id = $1 AND status <> 'cancelled'
      ORDER BY updated_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows.map(toJob);
}

export async function setStatus(
  userId: string,
  jobId: string,
  status: JobStatus,
  extra?: { pendingQuestion?: string | null; wakeAt?: string | null }
): Promise<void> {
  await query(
    `UPDATE job
        SET status = $3,
            pending_question = COALESCE($4, pending_question),
            wake_at = COALESCE($5, wake_at),
            updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [jobId, userId, status, extra?.pendingQuestion ?? null, extra?.wakeAt ?? null]
  );
}

/**
 * Задачи, которые пора будить. В S0 воркера ещё нет, но контракт уже такой,
 * чтобы S1 добавил цикл исполнения, не трогая схему.
 */
export async function dueJobs(limit = 50): Promise<Job[]> {
  const rows = await query<JobRow>(
    `SELECT * FROM job
      WHERE status = 'waiting_world' AND wake_at IS NOT NULL AND wake_at <= now()
      ORDER BY wake_at
      LIMIT $1`,
    [limit]
  );
  return rows.map(toJob);
}
