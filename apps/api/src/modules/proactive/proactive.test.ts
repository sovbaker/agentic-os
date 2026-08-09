import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { close, query, queryOne } from '../../db/client';
import { DAILY_BUDGET, recordReaction, score, timeliness } from './policy';
import { runFor } from './index';
import { createJob } from '../jobs/store';
import { addFact, upsertEntity } from '../memory/graph';
import { parseIcs, parseInboxAddress } from '../connectors/inbound';

/**
 * Проактивность — единственное, что создаёт привычку, и единственное,
 * что удаляет приложение при неправильной настройке. Поэтому проверяем
 * ровно две вещи: бюджет соблюдается, и игнор реально снижает частоту.
 */

const hasDb = Boolean(process.env['DATABASE_URL']);
let userId = '';

before(async () => {
  if (!hasDb) return;
  const row = await queryOne<{ id: string }>(
    "INSERT INTO app_user (locale, timezone) VALUES ('ru-RU', 'Europe/Moscow') RETURNING id"
  );
  userId = row?.id ?? '';
});

after(async () => {
  if (hasDb && userId) await query('DELETE FROM app_user WHERE id = $1', [userId]);
  await close();
});

test('ночью не беспокоим ничем, кроме ожидаемого решения', () => {
  assert.equal(timeliness(3, 'discovery'), 0);
  assert.equal(timeliness(3, 'deadline'), 0);
  assert.ok(timeliness(3, 'need_decision') > 0);
  assert.equal(timeliness(14, 'deadline'), 1);
});

test('утренний бриф уместен утром и почти не уместен вечером', () => {
  assert.ok(timeliness(8, 'morning_brief') > timeliness(20, 'morning_brief'));
});

test('заглушённый класс не набирает баллов ни при какой срочности', () => {
  const muted = { kind: 'deadline' as const, weight: 1, muted: true, sent: 0, opened: 0, ignored: 0 };
  assert.equal(score({ kind: 'deadline', urgency: 1, hour: 12, policy: muted }), 0);
});

test('срочность и вес класса влияют на балл в правильную сторону', () => {
  const policy = { kind: 'deadline' as const, weight: 1, muted: false, sent: 0, opened: 0, ignored: 0 };
  const urgent = score({ kind: 'deadline', urgency: 1, hour: 12, policy });
  const distant = score({ kind: 'deadline', urgency: 0.1, hour: 12, policy });
  assert.ok(urgent > distant);

  const discovery = score({ kind: 'discovery', urgency: 1, hour: 12, policy: { ...policy, kind: 'discovery' } });
  // «Нашёл кое-что полезное» — самый рискованный класс, он и должен
  // проигрывать дедлайну при равной срочности.
  assert.ok(urgent > discovery);
});

test('игнор снижает вес класса сильнее, чем открытие поднимает', { skip: !hasDb }, async () => {
  await recordReaction(userId, 'discovery', 'opened');
  const afterOpen = await queryOne<{ weight: number }>(
    'SELECT weight FROM notification_policy WHERE user_id = $1 AND kind = $2',
    [userId, 'discovery']
  );

  await recordReaction(userId, 'discovery', 'ignored');
  const afterIgnore = await queryOne<{ weight: number }>(
    'SELECT weight FROM notification_policy WHERE user_id = $1 AND kind = $2',
    [userId, 'discovery']
  );

  assert.ok((afterIgnore?.weight ?? 1) < (afterOpen?.weight ?? 1));
  // Асимметрия намеренная: цена лишнего уведомления измеряется удалением.
  assert.ok((afterOpen?.weight ?? 0) - (afterIgnore?.weight ?? 0) > 0.2);
});

test('дневной бюджет уведомлений соблюдается', { skip: !hasDb }, async () => {
  // Заводим заведомо больше поводов, чем бюджет.
  for (let i = 0; i < DAILY_BUDGET + 3; i++) {
    await createJob({
      userId,
      goal: `Задача ${i}`,
      status: 'waiting_user',
      plan: [{ title: 'Экран', tool: 'miniapp.compose', args: { family: 'other', goal: 'x' } }],
    });
  }

  const delivered = await runFor(userId, new Date('2026-08-09T12:00:00'));
  assert.ok(delivered.length <= DAILY_BUDGET, `доставлено ${delivered.length}, бюджет ${DAILY_BUDGET}`);

  // Повторный прогон в тот же день не должен пробить бюджет.
  const again = await runFor(userId, new Date('2026-08-09T13:00:00'));
  const total = await queryOne<{ count: string }>(
    `SELECT count(*) FROM proactive_event WHERE user_id = $1 AND delivered_at > now() - interval '24 hours'`,
    [userId]
  );
  assert.ok(Number(total?.count ?? 0) <= DAILY_BUDGET, 'бюджет пробит вторым прогоном');
  assert.equal(again.length, 0);
});

test('один и тот же срок не звонит дважды', { skip: !hasDb }, async () => {
  const goal = await upsertEntity(userId, 'goal', 'Продлить страховку');
  await addFact({
    userId,
    subjectId: goal,
    predicate: 'due_on',
    value: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    source: 'user_said',
    confidence: 0.9,
  });

  await query('DELETE FROM proactive_event WHERE user_id = $1', [userId]);
  await runFor(userId, new Date('2026-08-09T12:00:00'));
  await runFor(userId, new Date('2026-08-09T12:05:00'));

  const rows = await query<{ dedup_key: string }>(
    `SELECT dedup_key FROM proactive_event WHERE user_id = $1 AND kind = 'deadline'`,
    [userId]
  );
  const unique = new Set(rows.map((r) => r.dedup_key));
  assert.equal(rows.length, unique.size, 'дедупликация не сработала');
});

/* ------------------------------------------------------------------ */
/* Коннекторы без верификации                                          */
/* ------------------------------------------------------------------ */

test('адрес для пересылки разбирается из разных форматов заголовка', () => {
  assert.equal(parseInboxAddress('u+abc123@in.example.ru'), 'abc123');
  assert.equal(parseInboxAddress('Ассистент <u+xyz789@in.example.ru>'), 'xyz789');
  assert.equal(parseInboxAddress('someone@example.com'), null);
});

test('разбор .ics берёт то, что нужно ассистенту', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:evt-1@example.org',
    'SUMMARY:Приём у врача',
    'DTSTART:20260920T103000Z',
    'DTEND:20260920T113000Z',
    'LOCATION:Пресненская наб., 10',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:evt-2@example.org',
    'SUMMARY:День рождения',
    'DTSTART;VALUE=DATE:20261012',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const events = parseIcs(ics);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.title, 'Приём у врача');
  assert.equal(events[0]?.startsAt, '2026-09-20T10:30:00.000Z');
  assert.equal(events[0]?.location, 'Пресненская наб., 10');
  // Событие на весь день — тоже валидное событие, а не повод упасть.
  assert.equal(events[1]?.startsAt, '2026-10-12T00:00:00.000Z');
});

test('перенос длинных строк в .ics не ломает разбор', () => {
  // Строки в ICS переносятся с отступом — их обязательно склеивать.
  const ics = 'BEGIN:VEVENT\r\nSUMMARY:Очень длинное название\r\n  события\r\nDTSTART:20260101T090000Z\r\nEND:VEVENT';
  const events = parseIcs(ics);
  assert.equal(events[0]?.title, 'Очень длинное название события');
});
