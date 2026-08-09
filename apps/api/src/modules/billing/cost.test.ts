import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { config } from '../../config';
import { computeCost } from './cost';

/**
 * Тесты прайса — чистая арифметика без базы.
 *
 * Ошибка здесь не падает, а тихо искажает отчёт: продукт будет считать себя
 * прибыльным или убыточным по неверной цифре, и обнаружится это на счёте.
 */

const M = 1_000_000;
const usd = (rub: number) => rub / config.usdRub;

test('снапшот и алиас модели стоят одинаково', () => {
  const a = computeCost('claude-haiku-4-5', { input_tokens: M });
  const b = computeCost('claude-haiku-4-5-20251001', { input_tokens: M });
  assert.equal(a.usd, b.usd);
  assert.equal(a.usd, 1);
});

test('цена входа и выхода берётся по модели', () => {
  assert.equal(computeCost('claude-opus-5', { input_tokens: M }).usd, 5);
  assert.equal(computeCost('claude-opus-5', { output_tokens: M }).usd, 25);
  assert.equal(computeCost('claude-fable-5', { output_tokens: M }).usd, 50);
});

test('чтение кэша дешевле входа вдесятеро', () => {
  const cold = computeCost('claude-opus-5', { input_tokens: M });
  const warm = computeCost('claude-opus-5', { cache_read_input_tokens: M });
  assert.equal(warm.usd, cold.usd * 0.1);
});

test('запись кэша считается по TTL, а не одним множителем', () => {
  // Часовой TTL дороже пятиминутного: 2.0 против 1.25 от цены входа.
  const short = computeCost('claude-opus-5', {
    cache_creation: { ephemeral_5m_input_tokens: M },
  });
  const long = computeCost('claude-opus-5', {
    cache_creation: { ephemeral_1h_input_tokens: M },
  });
  assert.equal(short.usd, 5 * 1.25);
  assert.equal(long.usd, 5 * 2);

  // Смешанная запись — взвешенно, а не по худшему тарифу.
  const mixed = computeCost('claude-opus-5', {
    cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M },
  });
  assert.equal(mixed.usd, 5 * 1.25 + 5 * 2);
  assert.equal(mixed.cacheWriteTokens, 2 * M);
});

test('без разбивки по TTL запись считается по пятиминутному тарифу', () => {
  const flat = computeCost('claude-opus-5', { cache_creation_input_tokens: M });
  assert.equal(flat.usd, 5 * 1.25);
});

test('вводная цена истекает сама, без правки кода', () => {
  const during = computeCost('claude-sonnet-5', { input_tokens: M }, new Date('2026-08-09T00:00:00Z'));
  const after = computeCost('claude-sonnet-5', { input_tokens: M }, new Date('2026-09-01T00:00:00Z'));
  assert.equal(during.usd, 2, 'до 31 августа 2026 действует вводная цена');
  assert.equal(after.usd, 3, 'после — обычная');
});

test('неизвестная модель не молчит', () => {
  const res = computeCost('gpt-нечто', { input_tokens: M });
  assert.equal(res.usd, 0);
  assert.equal(res.unknownModel, true, 'иначе расход просто исчезнет из отчёта');
});

test('рубли пересчитываются по курсу из конфигурации', () => {
  const res = computeCost('claude-opus-5', { input_tokens: M });
  assert.equal(res.rub, res.usd * config.usdRub);
  assert.ok(usd(res.rub) === res.usd);
});

test('реалистичный ход дешевле рубля', () => {
  // Роутинг короткой фразы на Haiku: ~600 токенов входа, ~150 выхода.
  const route = computeCost('claude-haiku-4-5', { input_tokens: 600, output_tokens: 150 });
  assert.ok(route.rub < 1, `ход роутера стоит ${route.rub.toFixed(4)} ₽`);
});

test('отсутствующие поля usage не ломают счёт', () => {
  const res = computeCost('claude-opus-5', {
    input_tokens: null, output_tokens: undefined, cache_read_input_tokens: null,
  });
  assert.equal(res.usd, 0);
  assert.equal(res.unknownModel, false);
});
