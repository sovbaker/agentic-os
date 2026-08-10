import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { close, query, queryOne } from '../../db/client';
import { claimJob, createJob, markStepRunning, releaseJob, runnableSteps } from './store';

/**
 * Тесты на двойное исполнение.
 *
 * Задачу ведут два драйвера: поток SSE — чтобы человек видел прогресс, и
 * фоновый воркер — чтобы задача пережила закрытый экран. Пока они не делили
 * аренду, шаг длиннее одного тика воркера исполнялся дважды, и для
 * инструмента без ключа идемпотентности это второе письмо или второе
 * напоминание.
 *
 * Проверяется только на живой базе: гарантию даёт условный UPDATE, а не код.
 */

const hasDb = Boolean(process.env['DATABASE_URL']);
const users: string[] = [];

async function newUser(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    "INSERT INTO app_user (locale, timezone) VALUES ('ru-RU', 'Europe/Moscow') RETURNING id"
  );
  const id = row?.id ?? '';
  users.push(id);
  return id;
}

after(async () => {
  if (hasDb) for (const id of users) await query('DELETE FROM app_user WHERE id = $1', [id]);
  await close();
});

test('аренду задачи получает ровно один исполнитель', { skip: !hasDb }, async () => {
  const userId = await newUser();
  const job = await createJob({
    userId,
    goal: 'проверка аренды',
    plan: [{ title: 'шаг', tool: 'time.now', args: {}, dependsOn: [] }],
  });

  const [first, second] = await Promise.all([
    claimJob(job.id, 'worker-a'),
    claimJob(job.id, 'worker-b'),
  ]);

  assert.equal(first !== second, true, 'аренду обязан получить ровно один');
  assert.equal(first || second, true, 'кто-то должен её получить');

  // После освобождения задача снова доступна — иначе упавший воркер
  // заблокировал бы её навсегда.
  await releaseJob(job.id);
  assert.equal(await claimJob(job.id, 'worker-c'), true);
});

test('шаг переходит в работу ровно один раз', { skip: !hasDb }, async () => {
  const userId = await newUser();
  const job = await createJob({
    userId,
    goal: 'проверка шага',
    plan: [{ title: 'шаг', tool: 'time.now', args: {}, dependsOn: [] }],
  });

  const [step] = await runnableSteps(job.id);
  assert.ok(step, 'шаг должен быть готов к исполнению');

  // Оба драйвера прочитали шаг как pending — так и бывает, окно реально.
  const results = await Promise.all([markStepRunning(step.id), markStepRunning(step.id)]);

  assert.equal(results.filter(Boolean).length, 1, 'выиграть должен ровно один');

  const row = await queryOne<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM job_step WHERE id = $1',
    [step.id]
  );
  assert.equal(row?.status, 'running');
  assert.equal(row?.attempts, 1, 'проигравший не должен считаться попыткой');
});
