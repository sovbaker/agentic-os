import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compose, detectShape, heuristicCompose } from './compose';
import { validateSpec } from './validate';
import { KNOWN_TOOLS } from '../tools/index';
import { CATALOG } from './catalog';

/**
 * Компилятор мини-апп.
 *
 * Проверяем не «сгенерировалось ли что-нибудь», а два свойства, от которых
 * зависит продукт: любая сборка валидна (пользователь не видит сломанный
 * экран), и форма экрана соответствует форме задачи — сравнение, отслеживание
 * и план это разные интерфейсы, и путать их хуже, чем ошибиться в теме.
 */

const opts = { knownTools: KNOWN_TOOLS };
const base = { params: {}, locale: 'ru-RU' as const };

test('форма задачи распознаётся по формулировке, а не по теме', () => {
  assert.equal(detectShape('Выбрать подрядчика на кухню, что дешевле'), 'compare');
  assert.equal(detectShape('Хочу трекер тренировок каждый день'), 'track');
  assert.equal(detectShape('Спланировать переезд по этапам'), 'plan');
  assert.equal(detectShape('Купить корм коту'), 'checklist');
});

test('каждая форма даёт структурно РАЗНЫЙ экран', () => {
  const kinds = (goal: string): string[] => {
    const { spec } = heuristicCompose({ ...base, family: 'other', goal });
    const seen: string[] = [];
    const walk = (n: { type: string; children?: unknown[] }): void => {
      seen.push(n.type);
      (n.children as Array<{ type: string; children?: unknown[] }> | undefined)?.forEach(walk);
    };
    walk(spec.root);
    return seen;
  };

  assert.ok(kinds('сравнить варианты').includes('comparisonTable'));
  assert.ok(kinds('трекер привычки').includes('chart'));
  assert.ok(kinds('спланировать этапы').includes('timeline'));
  // Простая задача не должна тащить графики и таймлайны — это шум.
  const plain = kinds('купить корм коту');
  assert.ok(!plain.includes('chart') && !plain.includes('timeline'));
});

test('любая эвристическая сборка проходит валидацию', () => {
  const goals = [
    'Выбрать страховку подешевле',
    'Трекер воды каждый день',
    'Спланировать день рождения по этапам',
    'Купить корм коту',
    'Разобраться с чем-то очень странным и длинным '.repeat(4),
  ];
  for (const goal of goals) {
    const { spec } = heuristicCompose({ ...base, family: 'other', goal });
    const result = validateSpec(spec, opts);
    assert.equal(result.ok, true, `${goal}: ${JSON.stringify(result.errors)}`);
  }
});

test('каталог перекрывает все пять семейств клина', () => {
  const families = ['documents', 'travel', 'home', 'health', 'routine'] as const;
  for (const family of families) {
    assert.ok(
      CATALOG.some((e) => e.families.includes(family)),
      `семейство ${family} не покрыто каталогом`
    );
  }
});

test('известное семейство идёт из каталога, а не в генерацию', async () => {
  const result = await compose({ ...base, family: 'home', goal: 'Найти мастера по потолкам' });
  assert.equal(result.spec.id, 'home-contractors');
  assert.equal(result.origin, 'catalog');
});

test('параметры из графа отмечают аппу как параметризованную', async () => {
  const result = await compose({
    family: 'documents',
    goal: 'Оформить визу',
    params: { country: 'Италия' },
    locale: 'ru-RU',
  });
  assert.equal(result.origin, 'parameterized');
  assert.ok(result.spec.title.includes('Италия'));
});

test('длинный хвост уходит в генерацию и всё равно валиден', async () => {
  const result = await compose({ ...base, family: 'other', goal: 'Сравнить тарифы мобильной связи' });
  assert.equal(result.origin, 'generated');
  assert.equal(validateSpec(result.spec, opts).ok, true);
});

test('данные экрана согласованы с тем, что он биндит', () => {
  // Экран, который биндит несуществующий ключ, рендерится пустым —
  // и это выглядит как баг рендерера, а не как ошибка сборки.
  const { spec, data } = heuristicCompose({ ...base, family: 'other', goal: 'трекер сна' });
  const json = JSON.stringify(spec.root);

  for (const key of ['streak', 'total', 'progress', 'history', 'items']) {
    if (json.includes(`"path":"${key}"`)) {
      assert.ok(key in data, `экран биндит "${key}", но данных для него нет`);
    }
  }
});
