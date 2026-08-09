import { query, queryOne, transaction } from '../../db/client';
import { log } from '../../obs/log';

/**
 * Экспорт и удаление данных.
 *
 * В продукте про личную жизнь это не строчка в требованиях, а часть оффера:
 * «отдам всё и удалю по первому слову» — единственный честный ответ на
 * «а вы там всё моё читаете?». Поэтому экспорт полный, а удаление настоящее.
 */

/** Что именно уезжает в выгрузку. Порядок — как человеку читать. */
const EXPORT_QUERIES: ReadonlyArray<readonly [key: string, sql: string]> = [
  ['profile', 'SELECT id, locale, timezone, plan, created_at FROM app_user WHERE id = $1'],
  [
    'entities',
    `SELECT id, type, label, attrs, created_at, archived_at
       FROM entity WHERE user_id = $1 ORDER BY created_at`,
  ],
  [
    'facts',
    `SELECT f.id, e.label AS subject, f.predicate, f.object_value, f.confidence,
            f.source, f.source_ref, f.observed_at, f.valid_from, f.valid_to
       FROM fact f JOIN entity e ON e.id = f.subject_id
      WHERE f.user_id = $1 ORDER BY f.observed_at`,
  ],
  ['episodes', 'SELECT id, kind, payload, job_id, created_at FROM episode WHERE user_id = $1 ORDER BY created_at'],
  ['jobs', 'SELECT id, goal, status, artifacts, created_at, updated_at FROM job WHERE user_id = $1 ORDER BY created_at'],
  [
    'job_steps',
    `SELECT s.id, s.job_id, s.idx, s.tool, s.args, s.status, s.result, s.error
       FROM job_step s JOIN job j ON j.id = s.job_id
      WHERE j.user_id = $1 ORDER BY s.job_id, s.idx`,
  ],
  ['miniapps', 'SELECT id, version, title, origin, spec, created_at FROM miniapp WHERE user_id = $1'],
  ['miniapp_state', 'SELECT spec_id, data, updated_at FROM miniapp_state WHERE user_id = $1'],
  [
    'audit',
    `SELECT at, action, human_readable, reason, permission, confirmed_by_user, reversible, reversed_at
       FROM audit_log WHERE user_id = $1 ORDER BY at`,
  ],
  [
    'notifications',
    `SELECT kind, title, body, score, scheduled_for, delivered_at, reaction
       FROM proactive_event WHERE user_id = $1 ORDER BY created_at`,
  ],
  ['procedures', 'SELECT id, name, steps, success_rate, runs, status, created_at FROM procedure WHERE user_id = $1'],
  [
    'llm_calls',
    `SELECT created_at, role, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_rub
       FROM llm_call WHERE user_id = $1 ORDER BY created_at`,
  ],
];

export interface ExportBundle {
  exportedAt: string;
  /** Ответ на «а что вы вообще про меня знаете» — до чтения самих данных. */
  summary: Record<string, number>;
  data: Record<string, unknown[]>;
}

export async function exportUser(userId: string): Promise<ExportBundle> {
  const data: Record<string, unknown[]> = {};
  const summary: Record<string, number> = {};

  for (const [key, sql] of EXPORT_QUERIES) {
    const rows = await query(sql, [userId]);
    data[key] = rows;
    summary[key] = rows.length;
  }

  /**
   * Карантина в выгрузке нет намеренно. Там лежит сырой недоверенный текст
   * писем и страниц — то есть данные третьих лиц, попавшие к нам как
   * вложение. Отдавать их в «твои данные» неверно и по смыслу, и по закону.
   */
  await query(`INSERT INTO privacy_request (user_id, kind, completed_at) VALUES ($1, 'export', now())`, [userId]);

  return { exportedAt: new Date().toISOString(), summary, data };
}

/**
 * Удаление.
 *
 * Настоящее, каскадом по внешним ключам, а не флаг `deleted`. Отметка
 * `deleted_at` ставится только на строку пользователя и живёт до конца
 * транзакции — она нужна, чтобы запрос остался в журнале обращений.
 *
 * Единственное, что переживает удаление, — обезличенные общие процедуры
 * (`user_id IS NULL`) и каталог: в них нет ничего личного по построению.
 */
export async function deleteUser(userId: string): Promise<{ deleted: boolean }> {
  return transaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM app_user WHERE id = $1', [userId]);
    if (exists.rowCount === 0) return { deleted: false };

    await client.query(
      `INSERT INTO privacy_request (user_id, kind, completed_at) VALUES ($1, 'delete', now())`,
      [userId]
    );
    // Карантин уходит каскадом, но удаляем явно и первым: это самое
    // чувствительное, что у нас лежит, и оно не должно зависеть от того,
    // не потеряется ли `ON DELETE CASCADE` при следующей миграции.
    await client.query('DELETE FROM quarantined_content WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM app_user WHERE id = $1', [userId]);

    log.info('пользователь удалён по запросу', { userId });
    return { deleted: true };
  });
}

/** Короткая сводка для экрана приватности: что храним и сколько это стоило. */
export async function privacySummary(userId: string): Promise<{
  facts: number;
  episodes: number;
  jobs: number;
  quarantined: number;
  actions: number;
  spendRubMonth: number;
}> {
  const row = await queryOne<{
    facts: string; episodes: string; jobs: string; quarantined: string; actions: string; spend: string;
  }>(
    `SELECT
       (SELECT count(*) FROM fact WHERE user_id = $1 AND valid_to IS NULL)::text AS facts,
       (SELECT count(*) FROM episode WHERE user_id = $1)::text                   AS episodes,
       (SELECT count(*) FROM job WHERE user_id = $1)::text                       AS jobs,
       (SELECT count(*) FROM quarantined_content WHERE user_id = $1)::text       AS quarantined,
       (SELECT count(*) FROM audit_log WHERE user_id = $1)::text                 AS actions,
       (SELECT COALESCE(SUM(cost_rub), 0) FROM llm_call
         WHERE user_id = $1 AND created_at >= date_trunc('month', now()))::text  AS spend`,
    [userId]
  );

  return {
    facts: Number(row?.facts ?? 0),
    episodes: Number(row?.episodes ?? 0),
    jobs: Number(row?.jobs ?? 0),
    quarantined: Number(row?.quarantined ?? 0),
    actions: Number(row?.actions ?? 0),
    spendRubMonth: Number(row?.spend ?? 0),
  };
}
