import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { UISpec } from '@agentic-os/contracts';
import { generateWithRepair, validateSpec } from './validate';
import { CATALOG } from './catalog';
import { KNOWN_TOOLS } from '../tools/index';

/**
 * Валидатор — предохранитель между генерацией и экраном пользователя.
 * Если он пропускает мусор, пользователь видит сломанный интерфейс;
 * если режет лишнее — теряется весь длинный хвост. Оба направления
 * проверяем явно.
 */

const opts = { knownTools: KNOWN_TOOLS };

const base = (root: unknown): unknown => ({
  schemaVersion: '1.0',
  id: 'test',
  version: 1,
  title: 'Тест',
  dataSources: [{ key: 'items', tool: 'task.checklist', args: {} }],
  meta: { origin: 'generated', graphRefs: [], shareable: false, runtimeKeys: [] },
  root,
});

test('весь каталог валиден — иначе деплой должен падать', () => {
  const sample = { goal: 'проверка', params: { country: 'Италия', deadline: '2026-10-01T00:00:00.000Z' }, locale: 'ru-RU' };
  for (const entry of CATALOG) {
    const result = validateSpec(entry.build(sample), opts);
    assert.equal(result.ok, true, `${entry.id}: ${JSON.stringify(result.errors)}`);
  }
});

test('компонент вне реестра отбрасывается', () => {
  const result = validateSpec(base({ type: 'webview', children: [] }), opts);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('экшен на несуществующий инструмент отбрасывается', () => {
  const result = validateSpec(
    base({
      type: 'screen',
      children: [
        { type: 'button', props: { label: 'Жми' }, actions: { onPress: { kind: 'tool', tool: 'выдуманный.инструмент', args: {} } } },
      ],
    }),
    opts
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes('неизвестный инструмент')));
});

test('вложенный repeat по алиасу родителя — это валидно', () => {
  // `finding` вводится циклом по findings и данными не является.
  // Валидатор, который этого не знает, режет корректные экраны.
  const result = validateSpec(
    {
      schemaVersion: '1.0', id: 'nested', version: 1, title: 'Вложенность',
      dataSources: [],
      meta: { origin: 'generated', graphRefs: [], shareable: false, runtimeKeys: ['findings'] },
      root: {
        type: 'screen',
        children: [
          {
            type: 'stack',
            repeat: { ref: { source: 'data', path: 'findings' }, as: 'finding' },
            children: [
              {
                type: 'list',
                repeat: { ref: { source: 'data', path: 'finding.keyPoints' }, as: 'point' },
                children: [{ type: 'text', bind: { text: { source: 'data', path: 'point' } } }],
              },
            ],
          },
        ],
      },
    },
    opts
  );
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('repeat по необъявленному источнику данных отбрасывается', () => {
  // Самая коварная ошибка генерации: экран рендерится пустым и выглядит
  // как баг рендерера, а не как невалидная спека.
  const result = validateSpec(
    base({
      type: 'screen',
      children: [{ type: 'listItem', repeat: { ref: { source: 'data', path: 'выдуманные' }, as: 'x' } }],
    }),
    opts
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes('dataSources')));
});

test('превышение бюджета сложности ловится отдельно от ошибок схемы', () => {
  const children = Array.from({ length: 250 }, (_, i) => ({ type: 'text', props: { text: `строка ${i}` } }));
  const result = validateSpec(base({ type: 'screen', children }), opts);
  assert.equal(result.ok, false);
  assert.ok(result.budgetExceeded.some((b) => b.startsWith('nodes=')));
});

test('repair loop: вторая попытка с обратной связью проходит', async () => {
  const attempts: Array<string | null> = [];

  const result = await generateWithRepair(async (feedback) => {
    attempts.push(feedback);
    return attempts.length === 1
      ? base({ type: 'выдуманный', children: [] })
      : base({ type: 'screen', children: [{ type: 'text', props: { text: 'ок' } }] });
  }, opts);

  assert.equal(result.attempts, 2);
  assert.ok(result.spec !== null);
  assert.equal((result.spec as UISpec).root.type, 'screen');
  // Модель должна получить конкретные ошибки, а не «попробуй ещё раз».
  assert.equal(attempts[0], null);
  assert.ok(attempts[1]?.includes('не прошёл валидацию'));
});

test('после исчерпания попыток спека не возвращается — сработает fallback', async () => {
  const result = await generateWithRepair(async () => base({ type: 'всё ещё мусор' }), opts);
  assert.equal(result.spec, null);
  assert.equal(result.attempts, 2);
  assert.ok(result.lastErrors.length > 0);
});
