import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { judge } from './critic';

/**
 * Критик — то, что отличает «сделано» от «вызвано без ошибки».
 * Без него агент рапортует об успехе при нулевом результате, и это
 * худший режим отказа: метрики зелёные, пользы нет.
 */

const base = { attempts: 1, maxAttempts: 3 };

test('успешный результат с выполненными условиями принимается', () => {
  const { verdict } = judge({
    ...base,
    result: { ok: true, dataPatch: { items: [{ id: 'a' }] } },
    postconditions: ['result.ok', 'min_items:1'],
  });
  assert.equal(verdict.kind, 'accept');
});

test('инструмент вернул ok, но результат пуст — это не успех', () => {
  const { verdict } = judge({
    ...base,
    result: { ok: true, dataPatch: { items: [] } },
    postconditions: ['min_items:1'],
  });
  assert.equal(verdict.kind, 'retry');
});

test('пока попытки остались — повтор, когда исчерпаны — эскалация', () => {
  const failing = { result: { ok: false, message: 'сеть' }, postconditions: ['result.ok'] };

  assert.equal(judge({ ...failing, attempts: 1, maxAttempts: 3 }).verdict.kind, 'retry');
  assert.equal(judge({ ...failing, attempts: 3, maxAttempts: 3 }).verdict.kind, 'escalate');
});

test('условие has:<key> различает пустое и заполненное', () => {
  const withFindings = judge({
    ...base,
    result: { ok: true, dataPatch: { findings: [{ title: 'x', keyPoints: [] }] } },
    postconditions: ['has:findings'],
  });
  const withoutFindings = judge({
    ...base,
    result: { ok: true, dataPatch: { findings: [] } },
    postconditions: ['has:findings'],
  });

  assert.equal(withFindings.verdict.kind, 'accept');
  assert.equal(withoutFindings.verdict.kind, 'retry');
});

test('spec_valid требует именно мини-аппу, а не просто успех', () => {
  assert.equal(
    judge({ ...base, result: { ok: true }, postconditions: ['spec_valid'] }).verdict.kind,
    'retry'
  );
});

test('неизвестное условие не валит шаг, но возвращается наверх', () => {
  // План может прийти от модели и содержать выдуманное условие.
  // Считать его невыполненным — значит ронять исправную работу;
  // молча игнорировать — значит никогда об этом не узнать.
  const { verdict, unknownConditions } = judge({
    ...base,
    result: { ok: true },
    postconditions: ['result.ok', 'выдуманное_условие'],
  });

  assert.equal(verdict.kind, 'accept');
  assert.deepEqual(unknownConditions, ['выдуманное_условие']);
});

test('причина отказа содержит конкретику, а не «что-то пошло не так»', () => {
  const { verdict } = judge({
    ...base,
    attempts: 3,
    result: { ok: false, message: 'таймаут поиска' },
    postconditions: ['result.ok', 'has:findings'],
  });

  assert.equal(verdict.kind, 'escalate');
  if (verdict.kind === 'escalate') {
    assert.ok(verdict.reason.includes('таймаут поиска'));
    assert.ok(verdict.reason.includes('has:findings'));
  }
});
