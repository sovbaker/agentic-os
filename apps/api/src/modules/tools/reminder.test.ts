import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { close, query, queryOne } from '../../db/client';
import { execTool } from './index';

/**
 * Тесты дедупликации напоминаний.
 *
 * Одно и то же напоминание приходит из двух мест по замыслу: шаг плана
 * ставит его сам, и кнопка в мини-аппе предлагает поставить. Для продукта,
 * который продаёт «я держу твои дела», два одинаковых напоминания — прямой
 * удар по доверию, поэтому вторую вставку обязана отсекать база.
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

test('одно и то же напоминание не ставится дважды', { skip: !hasDb }, async () => {
  const userId = await newUser();
  const ctx = { userId, confirmed: false };
  const args = { afterDays: 2, about: 'Проверить документы' };

  const first = await execTool('reminder.schedule', ctx, args);
  const second = await execTool('reminder.schedule', ctx, args);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true, 'повтор — не ошибка, а «уже стоит»');

  const rows = await query('SELECT id FROM proactive_event WHERE user_id = $1', [userId]);
  assert.equal(rows.length, 1, 'в базе должно остаться одно напоминание');

  // Кнопка обязана узнать о состоянии из данных, а не из баннера.
  assert.equal((second.dataPatch as { reminderState?: string })?.reminderState, 'done');
});

test('поставленное напоминание можно снять тем, чем записано', { skip: !hasDb }, async () => {
  const userId = await newUser();
  const ctx = { userId, confirmed: false };

  await execTool('reminder.schedule', ctx, { afterDays: 3, about: 'Продлить страховку' });

  const row = await queryOne<{ compensation: { tool: string; args: { eventId: string } } | null }>(
    `SELECT compensation FROM audit_log WHERE user_id = $1 AND action = 'reminder.schedule'`,
    [userId]
  );
  assert.ok(row?.compensation, '«обратимо» без компенсации — просто отметка в журнале');
  assert.equal(row.compensation.tool, 'reminder.cancel');

  const undone = await execTool(row.compensation.tool, ctx, row.compensation.args);
  assert.equal(undone.ok, true, 'компенсация должна быть зарегистрированным инструментом');

  const left = await query('SELECT id FROM proactive_event WHERE user_id = $1', [userId]);
  assert.equal(left.length, 0);
});
