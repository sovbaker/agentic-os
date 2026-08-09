import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { TemplatePlanner, validatePlan } from './planner';

const planner = new TemplatePlanner();

test('экран собирается первым шагом — иначе человек смотрит на спиннер', async () => {
  const plan = await planner.plan({
    goal: 'Оформить визу в Италию',
    family: 'documents',
    params: { country: 'Италия' },
    locale: 'ru-RU',
  });
  assert.equal(plan[0]?.tool, 'miniapp.compose');
});

test('исследование добавляется там, где оно осмысленно, и не добавляется где нет', async () => {
  const withResearch = await planner.plan({ goal: 'виза', family: 'documents', params: {}, locale: 'ru-RU' });
  const withoutResearch = await planner.plan({ goal: 'записаться', family: 'health', params: {}, locale: 'ru-RU' });

  assert.ok(withResearch.some((s) => s.tool === 'web.search'));
  assert.ok(!withoutResearch.some((s) => s.tool === 'web.search'));
});

test('обогащение зависит от поиска и берёт его результат по ссылке', async () => {
  const plan = await planner.plan({ goal: 'виза', family: 'documents', params: {}, locale: 'ru-RU' });
  const enrich = plan.find((s) => s.tool === 'miniapp.enrich');

  assert.ok(enrich, 'шаг обогащения должен быть в плане');
  assert.deepEqual(enrich?.dependsOn, [1]);
  // Аргумент — ссылка на результат шага, а не подставленное значение:
  // на момент планирования результата ещё не существует.
  assert.deepEqual(enrich?.args['findings'], { $fromStep: { idx: 1, path: 'findings' } });
});

test('напоминание появляется только при известном сроке', async () => {
  const withDeadline = await planner.plan({
    goal: 'виза', family: 'documents',
    params: { deadline: '2026-10-01T00:00:00.000Z' }, locale: 'ru-RU',
  });
  const without = await planner.plan({ goal: 'виза', family: 'documents', params: {}, locale: 'ru-RU' });

  assert.ok(withDeadline.some((s) => s.tool === 'reminder.schedule'));
  assert.ok(!without.some((s) => s.tool === 'reminder.schedule'));
});

test('план от модели с несуществующим инструментом отбрасывается целиком', () => {
  // Частично исполнимый план хуже предсказуемого шаблона: он падает
  // на середине, оставляя задачу в непонятном состоянии.
  const bad = validatePlan([
    { title: 'Экран', tool: 'miniapp.compose', args: {} },
    { title: 'Магия', tool: 'магия.сделай_хорошо', args: {} },
  ]);
  assert.equal(bad, null);
});

test('план, не начинающийся с экрана, отбрасывается', () => {
  assert.equal(validatePlan([{ title: 'Поиск', tool: 'web.search', args: {} }]), null);
});

test('слишком длинный план отбрасывается', () => {
  const long = Array.from({ length: 7 }, () => ({ title: 'Шаг', tool: 'miniapp.compose', args: {} }));
  assert.equal(validatePlan(long), null);
});

test('валидный план от модели нормализуется, а не принимается как есть', () => {
  const plan = validatePlan([
    { title: 'Экран', tool: 'miniapp.compose', args: {} },
    // dependsOn ссылается вперёд — такая ссылка не может быть выполнена.
    { title: 'Поиск', tool: 'web.search', args: { q: 'что-то' }, dependsOn: [5] },
  ]);

  assert.ok(plan);
  assert.deepEqual(plan?.[1]?.dependsOn, []);
});
