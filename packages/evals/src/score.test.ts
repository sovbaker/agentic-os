import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { check, report } from './score';
import { EvalCase, type Observation } from './types';

/**
 * Тесты самой оснастки.
 *
 * Проверять надо не только систему, но и линейку: эвал, который засчитывает
 * провал как успех, хуже отсутствия эвалов — он даёт ложную уверенность
 * ровно там, где мы решили ей доверять.
 */

const kase = (expect: unknown, input = 'Оформи визу'): EvalCase =>
  EvalCase.parse({ id: 't', input, expect, reviewed: true });

const obs = (over: Partial<Observation> = {}): Observation => ({
  intent: 'new_task',
  family: 'documents',
  params: { country: 'Италия', deadline: '2026-10-01T00:00:00.000Z' },
  tools: ['web.search', 'task.checklist'],
  origin: 'parameterized',
  ...over,
});

test('пустое ожидание проходит: «мне тут всё равно» — не «должно быть пусто»', () => {
  const r = check(kase({}), obs());
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 0);
});

test('несовпадение семейства валит случай', () => {
  const r = check(kase({ family: 'travel' }), obs());
  assert.equal(r.ok, false);
  assert.equal(r.checks[0]?.field, 'family');
});

test('дата сравнивается по префиксу', () => {
  // Иначе набор пришлось бы переписывать при каждом изменении разбора сроков.
  assert.equal(check(kase({ params: { deadline: '2026-10' } }), obs()).ok, true);
  assert.equal(check(kase({ params: { deadline: '2026-11' } }), obs()).ok, false);
});

test('отсутствующий параметр не считается совпадением с пустой строкой', () => {
  const r = check(kase({ params: { country: 'Италия' } }), obs({ params: {} }));
  assert.equal(r.ok, false);
  assert.equal(r.checks[0]?.actual, '—');
});

test('порядок инструментов не важен, наличие — важно', () => {
  assert.equal(check(kase({ tools: ['task.checklist', 'web.search'] }), obs()).ok, true);
  assert.equal(check(kase({ tools: ['calendar.create'] }), obs()).ok, false);
});

test('запрещённый инструмент ловится', () => {
  // Лишний веб-поиск — это деньги, задержка и недоверенный контент там,
  // где он не нужен. Такое обязано падать.
  const r = check(kase({ forbiddenTools: ['web.search'] }), obs());
  assert.equal(r.ok, false);
  assert.equal(r.checks[0]?.field, '!tool:web.search');
});

test('пустой набор не выдаётся за сто процентов', () => {
  const r = report([]);
  assert.equal(r.total, 0);
  assert.equal(r.rate, 0, '0/0 — это не успех, это отсутствие проверки');
});

test('отчёт группирует по виду проверки, а не по конкретному инструменту', () => {
  const results = [
    check(kase({ family: 'travel', tools: ['a', 'b'] }), obs()),
    check(kase({ family: 'documents' }), obs()),
  ];
  const r = report(results);

  assert.equal(r.total, 2);
  assert.equal(r.passed, 1);
  assert.equal(r.byField['family']?.checked, 2);
  assert.equal(r.byField['family']?.failed, 1);
  assert.equal(r.byField['tools']?.failed, 2, 'два инструмента — две проверки в одной группе');
});

test('заготовка без разметки не проходит схему как размеченная', () => {
  const raw = EvalCase.parse({ id: 'r', input: 'что-то', expect: {} });
  assert.equal(raw.reviewed, false, 'по умолчанию запись не считается проверенной человеком');
  assert.equal(raw.locale, 'ru-RU');
});
