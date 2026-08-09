import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { close, query, queryOne } from '../../db/client';
import { addFact, upsertEntity } from './graph';

/**
 * Интеграционные тесты политики разрешения конфликтов.
 *
 * Именно здесь ассистент становится опасным при ошибке: факт, который молча
 * подменился или молча не подменился, приводит к уверенным ответам про
 * устаревшую жизнь пользователя. Проверять это на живой базе обязательно —
 * логика размазана по SQL и транзакции.
 *
 * Требуется DATABASE_URL; без него тесты пропускаются, а не падают.
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

test('новый факт из того же источника закрывает старый и ссылается на себя', { skip: !hasDb }, async () => {
  const subject = await upsertEntity(userId, 'place', 'Город проживания');

  const first = await addFact({
    userId, subjectId: subject, predicate: 'lives_in',
    value: 'Москва', source: 'user_said', confidence: 0.9,
  });
  const second = await addFact({
    userId, subjectId: subject, predicate: 'lives_in',
    value: 'Тбилиси', source: 'user_said', confidence: 0.9,
  });

  const old = await queryOne<{ valid_to: Date | null; superseded_by: string | null }>(
    'SELECT valid_to, superseded_by FROM fact WHERE id = $1', [first.id]
  );
  const current = await queryOne<{ valid_to: Date | null }>(
    'SELECT valid_to FROM fact WHERE id = $1', [second.id]
  );

  assert.notEqual(old?.valid_to, null, 'старый факт должен быть закрыт по времени');
  assert.equal(old?.superseded_by, second.id, 'старый факт должен ссылаться на заменивший');
  assert.equal(current?.valid_to, null, 'новый факт должен остаться актуальным');

  // Ничего не удаляем физически: ассистент должен уметь сказать
  // «раньше ты говорил иначе».
  const all = await query('SELECT id FROM fact WHERE subject_id = $1', [subject]);
  assert.equal(all.length, 2);
});

test('слабый источник не перебивает прямое утверждение пользователя', { skip: !hasDb }, async () => {
  const subject = await upsertEntity(userId, 'org', 'Работа');

  const stated = await addFact({
    userId, subjectId: subject, predicate: 'works_at',
    value: 'Контур', source: 'user_said', confidence: 0.9,
  });
  const guessed = await addFact({
    userId, subjectId: subject, predicate: 'works_at',
    value: 'Яндекс', source: 'inferred', confidence: 0.95,
  });

  const statedRow = await queryOne<{ valid_to: Date | null }>(
    'SELECT valid_to FROM fact WHERE id = $1', [stated.id]
  );
  const guessedRow = await queryOne<{ valid_to: Date | null }>(
    'SELECT valid_to FROM fact WHERE id = $1', [guessed.id]
  );

  assert.equal(statedRow?.valid_to, null, 'утверждение пользователя должно остаться актуальным');
  assert.notEqual(guessedRow?.valid_to, null, 'вывод модели не должен становиться текущей правдой');
});

test('повтор того же значения не плодит подмену', { skip: !hasDb }, async () => {
  const subject = await upsertEntity(userId, 'thing', 'Машина');

  const first = await addFact({
    userId, subjectId: subject, predicate: 'owns',
    value: 'Skoda', source: 'calendar', confidence: 0.6,
  });
  const repeat = await addFact({
    userId, subjectId: subject, predicate: 'owns',
    value: 'Skoda', source: 'calendar', confidence: 0.6,
  });

  assert.equal(repeat.superseded, null, 'одинаковое значение не должно закрывать предыдущий факт');
  const rows = await query<{ valid_to: Date | null }>(
    'SELECT valid_to FROM fact WHERE id = ANY($1)', [[first.id, repeat.id]]
  );
  assert.equal(rows.filter((r) => r.valid_to === null).length, 2, 'оба факта остаются актуальными');
});
