import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RuleLlm } from './llm';

/**
 * Тесты на детерминированный адаптер.
 *
 * Их ценность не в покрытии, а в конкретном классе ошибок: правила на русском
 * языке ломаются молча — маршрут просто уезжает в «other», и внешне всё
 * выглядит работающим. Так и был потерян `\b`, который в JavaScript
 * определён только по ASCII и с кириллицей не срабатывает.
 */

const AUGUST_2026 = new Date('2026-08-09T12:00:00Z');
const llm = new RuleLlm(() => AUGUST_2026);

test('фраза про визу уезжает в documents, а не в other', async () => {
  const route = await llm.route('Надо оформить визу в Италию к октябрю, и я вечно про это забываю');
  assert.equal(route.family, 'documents');
  assert.equal(route.intent, 'new_task');
});

test('страна извлекается и приводится к именительному падежу', async () => {
  const route = await llm.route('Надо оформить визу в Италию к октябрю');
  assert.equal(route.params['country'], 'Италия');
});

test('срок берётся из «к октябрю», а не из первого предлога во фразе', async () => {
  // «в Италию» стоит раньше «к октябрю»: остановка на первом совпадении
  // потеряла бы срок целиком.
  const route = await llm.route('Надо оформить визу в Италию к октябрю');
  assert.equal(route.params['deadline'], '2026-10-01T00:00:00.000Z');
});

test('прошедший месяц переносится на следующий год', async () => {
  const route = await llm.route('Продлить страховку к марту');
  assert.equal(route.params['deadline'], '2027-03-01T00:00:00.000Z');
});

test('падежи ключевых слов покрыты — «визой» не должно уезжать в other', async () => {
  // Русский флективный: одна непокрытая форма молча ломает маршрутизацию,
  // и внешне это выглядит как «иногда не понимает».
  for (const text of ['оформить визу', 'заняться визой', 'что с визой', 'нужна виза', 'по визе вопрос']) {
    assert.equal((await llm.route(text)).family, 'documents', `«${text}» уехало не туда`);
  }
});

test('семейства различаются по ключевым словам', async () => {
  const cases: Array<[string, string]> = [
    ['Хочу спланировать поездку в Грузию весной', 'travel'],
    ['Нужно найти мастера по натяжным потолкам на кухню', 'home'],
    ['Записаться к стоматологу', 'health'],
    ['Напоминай каждый месяц платить за интернет', 'routine'],
    ['Придумать подарок другу', 'other'],
  ];
  for (const [text, expected] of cases) {
    const route = await llm.route(text);
    assert.equal(route.family, expected, `«${text}» → ожидали ${expected}, получили ${route.family}`);
  }
});

test('приветствие не создаёт задачу', async () => {
  assert.equal((await llm.route('Привет')).intent, 'chitchat');
});

test('из одной фразы извлекаются место, срок и самонаблюдение', async () => {
  const facts = await llm.extractFacts('Надо оформить визу в Италию к октябрю, и я вечно про это забываю');
  const predicates = facts.map((f) => f.predicate);

  assert.ok(predicates.includes('plans_to_visit'), 'место не извлеклось');
  assert.ok(predicates.includes('due_on'), 'срок не извлёкся');
  assert.ok(predicates.includes('self_reported_pattern'), 'самонаблюдение не извлеклось');

  // Провенанс без уверенности бесполезен: значение обязано быть осмысленным.
  assert.ok(facts.every((f) => f.confidence > 0 && f.confidence <= 1));
});

test('из нейтральной фразы фактов не выдумывается', async () => {
  assert.deepEqual(await llm.extractFacts('Спасибо'), []);
});
