import { query, queryOne } from '../../db/client';

/**
 * Продуктовые метрики.
 *
 * Главная — TCFY: задач, полностью закрытых **за** пользователя, в неделю.
 * Она намеренно ломается, если продукт создаёт работу вместо того, чтобы её
 * забирать: задача, доведённая до «спроси у пользователя» и там оставленная,
 * в счёт не идёт, сколько бы шагов ни выполнилось.
 *
 * Всё считается в базе одним запросом на метрику. Считать это в приложении
 * значит выгрузить журнал целиком ради одного числа.
 */

export interface Tcfy {
  /** По неделям, от свежей к старой. */
  weeks: Array<{ weekStart: string; closed: number }>;
  median: number;
  /** Гейт G3: медиана ≥ 3. */
  gatePassed: boolean;
}

const TCFY_GATE = 3;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * «Закрыта за пользователя» = задача дошла до `done` **и** по ней есть хотя
 * бы одно действие в журнале. Второе условие отсеивает то, что выглядит
 * успехом в статусах, но ничего не сделало в мире, — худший режим отказа,
 * при котором метрики зелёные, а пользы нет.
 */
export async function tcfy(userId: string | null, weeks = 12): Promise<Tcfy> {
  const rows = await query<{ week: Date; closed: string }>(
    `SELECT date_trunc('week', j.updated_at) AS week, count(*)::text AS closed
       FROM job j
      WHERE j.status = 'done'
        AND ($1::uuid IS NULL OR j.user_id = $1)
        AND j.updated_at >= now() - ($2::int * interval '1 week')
        AND EXISTS (SELECT 1 FROM audit_log a WHERE a.job_id = j.id)
      GROUP BY 1
      ORDER BY 1 DESC`,
    [userId, weeks]
  );

  const list = rows.map((r) => ({ weekStart: r.week.toISOString().slice(0, 10), closed: Number(r.closed) }));
  const m = median(list.map((w) => w.closed));

  return { weeks: list, median: m, gatePassed: m >= TCFY_GATE };
}

export interface FunnelMetrics {
  users: number;
  /** Дошли до первой закрытой задачи. */
  activated: number;
  activationRate: number;
  /** Медианное время от регистрации до первой закрытой задачи, в минутах. */
  medianTimeToValueMin: number | null;
}

export async function funnel(): Promise<FunnelMetrics> {
  const row = await queryOne<{ users: string; activated: string; ttv: string | null }>(
    `WITH first_close AS (
       SELECT j.user_id, min(j.updated_at) AS at
         FROM job j
        WHERE j.status = 'done' AND EXISTS (SELECT 1 FROM audit_log a WHERE a.job_id = j.id)
        GROUP BY j.user_id
     )
     SELECT (SELECT count(*) FROM app_user)::text                            AS users,
            (SELECT count(*) FROM first_close)::text                         AS activated,
            (SELECT percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (f.at - u.created_at)) / 60)
               FROM first_close f JOIN app_user u ON u.id = f.user_id)::text  AS ttv`
  );

  const users = Number(row?.users ?? 0);
  const activated = Number(row?.activated ?? 0);
  return {
    users,
    activated,
    activationRate: users === 0 ? 0 : activated / users,
    medianTimeToValueMin: row?.ttv === null || row?.ttv === undefined ? null : Number(row.ttv),
  };
}

export interface QualityMetrics {
  /** Доля задач, дошедших до `done`, среди завершившихся хоть как-то. */
  successRate: number;
  /** Доля задач, потребовавших вопроса пользователю: продукт создаёт работу. */
  askedUserRate: number;
  /** Доля отменённых действий: сделали не то. */
  reversedRate: number;
}

export async function quality(days = 30): Promise<QualityMetrics> {
  const row = await queryOne<{
    done: string; finished: string; asked: string; total: string; reversed: string; actions: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'done')::text                          AS done,
       count(*) FILTER (WHERE status IN ('done','failed','cancelled'))::text  AS finished,
       count(*) FILTER (WHERE pending_question IS NOT NULL)::text             AS asked,
       count(*)::text                                                          AS total,
       (SELECT count(*) FROM audit_log WHERE reversed_at IS NOT NULL
          AND at >= now() - ($1::int * interval '1 day'))::text                AS reversed,
       (SELECT count(*) FROM audit_log
          WHERE at >= now() - ($1::int * interval '1 day'))::text              AS actions
     FROM job WHERE created_at >= now() - ($1::int * interval '1 day')`,
    [days]
  );

  const finished = Number(row?.finished ?? 0);
  const total = Number(row?.total ?? 0);
  const actions = Number(row?.actions ?? 0);

  return {
    successRate: finished === 0 ? 0 : Number(row?.done ?? 0) / finished,
    askedUserRate: total === 0 ? 0 : Number(row?.asked ?? 0) / total,
    reversedRate: actions === 0 ? 0 : Number(row?.reversed ?? 0) / actions,
  };
}

export interface EconomyMetrics {
  /** Медианная стоимость закрытой задачи. Цель из спеки — ≤ 25 ₽. */
  medianCostPerClosedRub: number;
  /** Худший процентиль важнее среднего: экономику ломает хвост. */
  p90CostPerClosedRub: number;
  /** Доля входных токенов, пришедшая из кэша. Прямой эффект оптимизации. */
  cacheHitRate: number;
  /** Разбивка расхода по ролям: куда именно уходят деньги. */
  byRole: Array<{ role: string; rub: number; calls: number }>;
}

export async function economy(days = 30): Promise<EconomyMetrics> {
  const cost = await queryOne<{ p50: string | null; p90: string | null }>(
    `WITH per_job AS (
       SELECT j.id, SUM(c.cost_rub) AS rub
         FROM job j JOIN llm_call c ON c.job_id = j.id
        WHERE j.status = 'done' AND j.updated_at >= now() - ($1::int * interval '1 day')
        GROUP BY j.id
     )
     SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY rub)::text AS p50,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY rub)::text AS p90
       FROM per_job`,
    [days]
  );

  const cache = await queryOne<{ cached: string; fresh: string }>(
    `SELECT COALESCE(SUM(cache_read_tokens), 0)::text AS cached,
            COALESCE(SUM(input_tokens + cache_write_tokens), 0)::text AS fresh
       FROM llm_call WHERE created_at >= now() - ($1::int * interval '1 day')`,
    [days]
  );

  const roles = await query<{ role: string; rub: string; calls: string }>(
    `SELECT role, COALESCE(SUM(cost_rub), 0)::text AS rub, count(*)::text AS calls
       FROM llm_call WHERE created_at >= now() - ($1::int * interval '1 day')
      GROUP BY role ORDER BY SUM(cost_rub) DESC`,
    [days]
  );

  const cached = Number(cache?.cached ?? 0);
  const fresh = Number(cache?.fresh ?? 0);

  return {
    medianCostPerClosedRub: Number(cost?.p50 ?? 0),
    p90CostPerClosedRub: Number(cost?.p90 ?? 0),
    cacheHitRate: cached + fresh === 0 ? 0 : cached / (cached + fresh),
    byRole: roles.map((r) => ({ role: r.role, rub: Number(r.rub), calls: Number(r.calls) })),
  };
}

export interface MiniappMetrics {
  /** Гейт G2: каталог против генерации. */
  byOrigin: Array<{ origin: string; count: number }>;
  catalogShare: number;
}

export async function miniapps(days = 30): Promise<MiniappMetrics> {
  const rows = await query<{ origin: string; c: string }>(
    `SELECT origin, count(*)::text AS c FROM miniapp
      WHERE created_at >= now() - ($1::int * interval '1 day')
      GROUP BY origin ORDER BY 2 DESC`,
    [days]
  );

  const byOrigin = rows.map((r) => ({ origin: r.origin, count: Number(r.c) }));
  const total = byOrigin.reduce((s, r) => s + r.count, 0);
  const catalog = byOrigin
    .filter((r) => r.origin === 'catalog' || r.origin === 'parameterized')
    .reduce((s, r) => s + r.count, 0);

  return { byOrigin, catalogShare: total === 0 ? 0 : catalog / total };
}

export interface Snapshot {
  tcfy: Tcfy;
  funnel: FunnelMetrics;
  quality: QualityMetrics;
  economy: EconomyMetrics;
  miniapps: MiniappMetrics;
}

/** Всё сразу — то, на что смотрят раз в неделю перед интервью с бетой. */
export async function snapshot(): Promise<Snapshot> {
  const [t, f, q, e, m] = await Promise.all([tcfy(null), funnel(), quality(), economy(), miniapps()]);
  return { tcfy: t, funnel: f, quality: q, economy: e, miniapps: m };
}
