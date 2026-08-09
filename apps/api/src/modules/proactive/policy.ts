import { query, queryOne } from '../../db/client';

/**
 * Политика уместности.
 *
 * Без проактивности нет привычки; с плохой проактивностью — удаление
 * приложения на третий день. Поэтому решает не «есть ли повод», а
 * «стоит ли беспокоить», и у этого решения есть жёсткий бюджет.
 */

export type EventKind = 'morning_brief' | 'did_for_you' | 'need_decision' | 'deadline' | 'discovery';

/** Не более трёх в день. Ограничение продуктовое, а не техническое. */
export const DAILY_BUDGET = 3;

/**
 * Базовая важность класса. `discovery` — самый рискованный: он единственный
 * приходит без запроса и без обязательства, поэтому и вводится последним,
 * и вытесняется первым.
 */
const BASE_IMPORTANCE: Record<EventKind, number> = {
  need_decision: 0.95,
  deadline: 0.9,
  morning_brief: 0.7,
  did_for_you: 0.6,
  discovery: 0.35,
};

export interface PolicyRow {
  kind: EventKind;
  weight: number;
  muted: boolean;
  sent: number;
  opened: number;
  ignored: number;
}

export async function policyFor(userId: string, kind: EventKind): Promise<PolicyRow> {
  const row = await queryOne<PolicyRow>(
    'SELECT kind, weight, muted, sent, opened, ignored FROM notification_policy WHERE user_id = $1 AND kind = $2',
    [userId, kind]
  );
  return row ?? { kind, weight: 1, muted: false, sent: 0, opened: 0, ignored: 0 };
}

/** Уместность времени: ночью не беспокоим ничем, кроме решения, которого ждут. */
export function timeliness(hour: number, kind: EventKind): number {
  if (hour >= 23 || hour < 7) return kind === 'need_decision' ? 0.4 : 0;
  if (kind === 'morning_brief') return hour >= 7 && hour <= 10 ? 1 : 0.2;
  if (hour >= 10 && hour <= 21) return 1;
  return 0.6;
}

export interface ScoreInput {
  kind: EventKind;
  /** 0..1 — насколько срочно по сути события (близость дедлайна и т.п.). */
  urgency: number;
  hour: number;
  policy: PolicyRow;
}

export function score(input: ScoreInput): number {
  if (input.policy.muted) return 0;
  const base = BASE_IMPORTANCE[input.kind] ?? 0.5;
  return base * (0.3 + 0.7 * input.urgency) * input.policy.weight * timeliness(input.hour, input.kind);
}

/** Сколько уже доставлено сегодня — бюджет считается по факту доставки. */
export async function deliveredToday(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*) FROM proactive_event
      WHERE user_id = $1 AND delivered_at IS NOT NULL AND delivered_at > now() - interval '24 hours'`,
    [userId]
  );
  return Number(row?.count ?? 0);
}

/**
 * Обновление весов по реакции.
 *
 * Открыл — класс становится чуть желаннее, проигнорировал — заметно менее.
 * Асимметрия намеренная: цена лишнего уведомления выше, чем цена
 * пропущенного, потому что первая измеряется удалением приложения.
 */
export async function recordReaction(
  userId: string,
  kind: EventKind,
  reaction: 'opened' | 'ignored' | 'muted_class'
): Promise<void> {
  const delta = reaction === 'opened' ? 0.1 : reaction === 'ignored' ? -0.25 : 0;

  await query(
    `INSERT INTO notification_policy (user_id, kind, weight, sent, opened, ignored, muted)
     VALUES ($1, $2, GREATEST(0.1, LEAST(2.0, 1 + $3::real)), 1, $4::int, $5::int, $6)
     ON CONFLICT (user_id, kind) DO UPDATE SET
       weight  = GREATEST(0.1, LEAST(2.0, notification_policy.weight + $3::real)),
       opened  = notification_policy.opened + $4::int,
       ignored = notification_policy.ignored + $5::int,
       muted   = notification_policy.muted OR $6,
       updated_at = now()`,
    [userId, kind, delta, reaction === 'opened' ? 1 : 0, reaction === 'ignored' ? 1 : 0, reaction === 'muted_class']
  );
}

export async function markSent(userId: string, kind: EventKind): Promise<void> {
  await query(
    `INSERT INTO notification_policy (user_id, kind, sent) VALUES ($1, $2, 1)
     ON CONFLICT (user_id, kind) DO UPDATE SET sent = notification_policy.sent + 1, updated_at = now()`,
    [userId, kind]
  );
}
