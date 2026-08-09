import { query, queryOne } from '../../db/client';
import { log } from '../../obs/log';
import { calendar } from '../tools/calendar';
import { DAILY_BUDGET, deliveredToday, markSent, policyFor, score, type EventKind } from './policy';
import { sendPush } from './push';

/**
 * Движок проактивности.
 *
 * Сканер поводов → оценка уместности → бюджет → доставка. Разделение важно:
 * поводов всегда больше, чем уместных уведомлений, и решение «не беспокоить»
 * должно приниматься в одном месте, а не размазываться по генераторам.
 */

export interface Candidate {
  kind: EventKind;
  title: string;
  body: string;
  urgency: number;
  jobId?: string | null;
  /** Ключ дедупликации: один и тот же дедлайн не должен звонить каждый прогон. */
  dedupKey: string;
}

/* ------------------------------------------------------------------ */
/* Поводы                                                              */
/* ------------------------------------------------------------------ */

/** Задачи, которые ждут ответа человека, — самый сильный повод написать. */
async function waitingOnUser(userId: string): Promise<Candidate[]> {
  const rows = await query<{ id: string; goal: string; pending_question: string | null }>(
    `SELECT id, goal, pending_question FROM job
      WHERE user_id = $1 AND status = 'waiting_user'
      ORDER BY updated_at DESC LIMIT 3`,
    [userId]
  );
  return rows.map((r) => ({
    kind: 'need_decision' as const,
    title: r.goal.slice(0, 60),
    body: r.pending_question ?? 'Нужно твоё решение, чтобы двигаться дальше',
    urgency: 0.9,
    jobId: r.id,
    dedupKey: `need_decision:${r.id}`,
  }));
}

/** Сроки из графа: то, ради чего человек и заводит такого ассистента. */
async function upcomingDeadlines(userId: string, now: Date): Promise<Candidate[]> {
  const rows = await query<{ label: string; object_value: unknown }>(
    `SELECT e.label, f.object_value
       FROM fact f JOIN entity e ON e.id = f.subject_id
      WHERE f.user_id = $1 AND f.valid_to IS NULL AND f.predicate = 'due_on'
      LIMIT 20`,
    [userId]
  );

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const raw = typeof row.object_value === 'string' ? row.object_value : null;
    if (!raw) continue;
    const due = new Date(raw);
    if (Number.isNaN(due.getTime())) continue;

    const days = Math.ceil((due.getTime() - now.getTime()) / 86_400_000);
    // Напоминаем на подлёте, а не в день события: поздний срок бесполезен.
    if (days < 0 || days > 30) continue;

    candidates.push({
      kind: 'deadline',
      title: row.label.slice(0, 60),
      body: days === 0 ? 'Срок сегодня' : `Осталось ${days} дн.`,
      urgency: Math.max(0.3, 1 - days / 30),
      dedupKey: `deadline:${row.label.slice(0, 40)}:${due.toISOString().slice(0, 10)}`,
    });
  }
  return candidates;
}

/** Что агент сделал сам, пока человек не смотрел. */
async function doneForUser(userId: string): Promise<Candidate[]> {
  const rows = await query<{ id: string; goal: string }>(
    `SELECT id, goal FROM job
      WHERE user_id = $1 AND status = 'done' AND updated_at > now() - interval '12 hours'
      ORDER BY updated_at DESC LIMIT 2`,
    [userId]
  );
  return rows.map((r) => ({
    kind: 'did_for_you' as const,
    title: 'Готово',
    body: r.goal.slice(0, 90),
    urgency: 0.4,
    jobId: r.id,
    dedupKey: `did_for_you:${r.id}`,
  }));
}

/* ------------------------------------------------------------------ */
/* Утренний бриф                                                       */
/* ------------------------------------------------------------------ */

export async function morningBrief(userId: string, now: Date): Promise<Candidate | null> {
  const [events, jobs, deadlines] = await Promise.all([
    calendar.listEvents(userId, now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString()),
    query<{ count: string }>(
      `SELECT count(*) FROM job WHERE user_id = $1 AND status IN ('running','waiting_user','waiting_world')`,
      [userId]
    ),
    upcomingDeadlines(userId, now),
  ]);

  const active = Number(jobs[0]?.count ?? 0);
  const soon = deadlines.filter((d) => d.urgency > 0.7).length;

  // Бриф без содержания хуже отсутствия брифа: он приучает игнорировать пуши.
  if (events.length === 0 && active === 0 && soon === 0) return null;

  const parts: string[] = [];
  if (events.length > 0) parts.push(`${events.length} событ. в календаре`);
  if (active > 0) parts.push(`${active} задач в работе`);
  if (soon > 0) parts.push(`${soon} срок(а) на подходе`);

  return {
    kind: 'morning_brief',
    title: 'Что сегодня',
    body: parts.join(' · '),
    urgency: soon > 0 ? 0.8 : 0.5,
    dedupKey: `morning_brief:${now.toISOString().slice(0, 10)}`,
  };
}

/* ------------------------------------------------------------------ */
/* Сканирование и доставка                                             */
/* ------------------------------------------------------------------ */

export async function collectCandidates(userId: string, now: Date): Promise<Candidate[]> {
  const [decisions, deadlines, done, brief] = await Promise.all([
    waitingOnUser(userId),
    upcomingDeadlines(userId, now),
    doneForUser(userId),
    now.getUTCHours() >= 4 && now.getUTCHours() <= 8 ? morningBrief(userId, now) : Promise.resolve(null),
  ]);

  return [...decisions, ...deadlines, ...done, ...(brief ? [brief] : [])];
}

export interface ScoredCandidate extends Candidate {
  score: number;
}

/**
 * Полный проход для одного пользователя.
 *
 * Возвращает то, что реально отправлено. Всё остальное отбрасывается
 * молча — накапливать «недоставленные» уведомления значит однажды
 * вывалить их пачкой.
 */
export async function runFor(userId: string, now = new Date()): Promise<ScoredCandidate[]> {
  const candidates = await collectCandidates(userId, now);
  if (candidates.length === 0) return [];

  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    const policy = await policyFor(userId, candidate.kind);
    scored.push({
      ...candidate,
      score: score({ kind: candidate.kind, urgency: candidate.urgency, hour: now.getHours(), policy }),
    });
  }

  const remaining = Math.max(0, DAILY_BUDGET - (await deliveredToday(userId)));
  const chosen = scored
    .filter((c) => c.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, remaining);

  const delivered: ScoredCandidate[] = [];

  for (const candidate of chosen) {
    // Дедупликация на уровне базы: гонка двух воркеров не даст дубль.
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO proactive_event (user_id, kind, title, body, job_id, score, scheduled_for, dedup_key, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now())
       ON CONFLICT (user_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [userId, candidate.kind, candidate.title, candidate.body, candidate.jobId ?? null, candidate.score, candidate.dedupKey]
    );
    if (!inserted) continue;

    await markSent(userId, candidate.kind);
    await sendPush(userId, { title: candidate.title, body: candidate.body, eventId: inserted.id });
    delivered.push(candidate);
  }

  if (delivered.length > 0) {
    log.info('проактивные уведомления доставлены', { userId, count: delivered.length });
  }
  return delivered;
}

/** Лента «Сегодня»: то же содержимое, но без ограничений бюджета уведомлений. */
export async function feed(userId: string, now = new Date()): Promise<{
  greeting: string;
  cards: Array<{ id: string | null; kind: EventKind; title: string; body: string; jobId: string | null }>;
}> {
  const candidates = await collectCandidates(userId, now);
  const hour = now.getHours();
  const greeting = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  return {
    greeting,
    cards: candidates
      .sort((a, b) => b.urgency - a.urgency)
      .map((c) => ({ id: null, kind: c.kind, title: c.title, body: c.body, jobId: c.jobId ?? null })),
  };
}
