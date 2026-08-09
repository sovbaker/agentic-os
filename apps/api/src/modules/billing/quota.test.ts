import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { close, query, queryOne } from '../../db/client';
import { deleteUser, exportUser, privacySummary } from '../privacy/index';
import { recordCall } from './cost';
import { PLANS, checkQuota, getPlan } from './quota';

/**
 * Интеграционные тесты лимитов и приватности.
 *
 * Обе темы проверяются только на живой базе: лимит — это агрегат по
 * нескольким таблицам, а удаление — каскад по внешним ключам. Проверять их
 * на моках значит проверять моки.
 *
 * Требуется DATABASE_URL; без него тесты пропускаются, а не падают.
 */

const hasDb = Boolean(process.env['DATABASE_URL']);
const users: string[] = [];

async function newUser(plan = 'free'): Promise<string> {
  const row = await queryOne<{ id: string }>(
    "INSERT INTO app_user (locale, timezone, plan) VALUES ('ru-RU', 'Europe/Moscow', $1) RETURNING id",
    [plan]
  );
  const id = row?.id ?? '';
  users.push(id);
  return id;
}

before(async () => {
  if (!hasDb) return;
});

after(async () => {
  if (hasDb) {
    for (const id of users) await query('DELETE FROM app_user WHERE id = $1', [id]);
    await query('DELETE FROM privacy_request WHERE user_id IS NULL');
  }
  await close();
});

test('тариф по умолчанию — free', { skip: !hasDb }, async () => {
  assert.equal(await getPlan(await newUser()), 'free');
});

test('бесплатный тариф упирается в число задач', { skip: !hasDb }, async () => {
  const userId = await newUser();
  const limit = PLANS.free.tasksPerMonth ?? 0;

  for (let i = 0; i < limit; i += 1) {
    const verdict = await checkQuota(userId, 'task');
    assert.equal(verdict.allowed, true, `задача ${i + 1} из ${limit} должна проходить`);
    await query("INSERT INTO job (user_id, goal, status) VALUES ($1, $2, 'done')", [userId, `задача ${i}`]);
  }

  const over = await checkQuota(userId, 'task');
  assert.equal(over.allowed, false);
  assert.match(over.reason ?? '', /бесплатном тарифе/i);
  assert.equal(over.used, limit);
});

test('на Pro число задач не ограничено, а предохранитель по деньгам работает', { skip: !hasDb }, async () => {
  const userId = await newUser('pro');

  for (let i = 0; i < 10; i += 1) {
    await query("INSERT INTO job (user_id, goal, status) VALUES ($1, 'задача', 'done')", [userId]);
  }
  assert.equal((await checkQuota(userId, 'task')).allowed, true, 'десять задач на Pro — норма');

  // Предохранитель не про тариф, а про отрицательную маржу на хвосте.
  await query(
    `INSERT INTO llm_call (user_id, role, model, cost_rub) VALUES ($1, 'planner', 'claude-opus-5', $2)`,
    [userId, PLANS.pro.monthlyCostRub + 1]
  );

  const verdict = await checkQuota(userId, 'task');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason ?? '', /потолок расхода/i);
});

test('генерация мини-апп закрыта на free и открыта на pro', { skip: !hasDb }, async () => {
  assert.equal((await checkQuota(await newUser('free'), 'generation')).allowed, false);
  assert.equal((await checkQuota(await newUser('pro'), 'generation')).allowed, true);
});

test('расход пишется с разбивкой и попадает в лимит', { skip: !hasDb }, async () => {
  const userId = await newUser();

  const cost = await recordCall({
    userId,
    role: 'router',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 1_000_000 },
  });
  assert.equal(cost.usd, 1.1, 'миллион входа плюс миллион из кэша на Haiku');

  const row = await queryOne<{ cache_read_tokens: number; cost_rub: string }>(
    'SELECT cache_read_tokens, cost_rub FROM llm_call WHERE user_id = $1',
    [userId]
  );
  assert.equal(row?.cache_read_tokens, 1_000_000, 'кэш должен считаться отдельным счётчиком');
  assert.ok(Number(row?.cost_rub) > 0);
});

test('выгрузка содержит всё своё и ничего чужого', { skip: !hasDb }, async () => {
  const userId = await newUser();
  await query("INSERT INTO job (user_id, goal, status) VALUES ($1, 'виза', 'done')", [userId]);
  await query("INSERT INTO episode (user_id, kind, payload) VALUES ($1, 'turn', '{}'::jsonb)", [userId]);
  await query(
    `INSERT INTO quarantined_content (user_id, tool, raw) VALUES ($1, 'email', 'секрет третьих лиц')`,
    [userId]
  );

  const bundle = await exportUser(userId);

  assert.equal(bundle.summary['jobs'], 1);
  assert.equal(bundle.summary['episodes'], 1);
  assert.ok(!('quarantine' in bundle.data), 'сырой недоверенный текст — данные третьих лиц, не пользователя');
  assert.ok(!JSON.stringify(bundle).includes('секрет третьих лиц'));

  const logged = await queryOne<{ kind: string }>(
    "SELECT kind FROM privacy_request WHERE user_id = $1 AND kind = 'export'",
    [userId]
  );
  assert.equal(logged?.kind, 'export', 'обращение должно оставлять след');
});

test('удаление уносит всё, но след о нём остаётся', { skip: !hasDb }, async () => {
  const userId = await newUser();
  await query("INSERT INTO job (user_id, goal, status) VALUES ($1, 'виза', 'done')", [userId]);
  await query(`INSERT INTO quarantined_content (user_id, tool, raw) VALUES ($1, 'email', 'текст')`, [userId]);

  assert.equal((await deleteUser(userId)).deleted, true);

  for (const table of ['job', 'episode', 'fact', 'entity', 'quarantined_content', 'llm_call']) {
    const rows = await query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [userId]);
    assert.equal(rows.length, 0, `${table}: данные пережили удаление`);
  }

  const trace = await query("SELECT kind FROM privacy_request WHERE kind = 'delete' AND user_id IS NULL");
  assert.ok(trace.length > 0, 'запись об удалении должна пережить удалённого — иначе доказательства нет');

  assert.equal((await deleteUser(userId)).deleted, false, 'повторное удаление — не ошибка');
});

test('сводка приватности показывает карантин отдельно', { skip: !hasDb }, async () => {
  const userId = await newUser();
  await query(`INSERT INTO quarantined_content (user_id, tool, raw) VALUES ($1, 'email', 'текст')`, [userId]);

  const summary = await privacySummary(userId);
  assert.equal(summary.quarantined, 1, 'пользователь должен видеть, что недоверенное лежит отдельно');
  assert.equal(summary.facts, 0);
});
