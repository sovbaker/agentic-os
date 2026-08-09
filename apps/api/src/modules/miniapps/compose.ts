import type { UINode, UISpec } from '@agentic-os/contracts';
import { log } from '../../obs/log';
import type { LlmPort } from '../orchestrator/llm';
import type { JobFamily } from '../orchestrator/llm';
import { KNOWN_TOOLS } from '../tools/index';
import { CATALOG, selectEntry, type CatalogParams } from './catalog';
import { generateWithRepair, validateSpec } from './validate';

/**
 * Компилятор мини-апп.
 *
 * Главное решение архитектуры: мини-аппа — это ПРОГРАММА, которая создаётся
 * один раз и версионируется, а не кадр, который рисуется на каждый рендер.
 * Отсюда латентность в миллисекунды, стабильность экрана между запусками,
 * тестируемость и возможность починить руками.
 *
 * Три источника, в порядке предпочтения:
 *   1. каталог — готовое и проверенное, предельная стоимость нулевая;
 *   2. эвристика — детерминированная сборка под длинный хвост;
 *   3. модель — когда форму задачи нельзя опознать правилами.
 *
 * Порядок именно такой, потому что от него зависит экономика: чем чаще
 * срабатывает каталог, тем дешевле и качественнее продукт.
 */

export type Origin = 'catalog' | 'parameterized' | 'generated';

export interface ComposeResult {
  spec: UISpec;
  data: Record<string, unknown>;
  origin: Origin;
  /** Сколько попыток заняла генерация — метрика для эвалов. */
  attempts: number;
}

export interface ComposeInput extends CatalogParams {
  family: JobFamily;
}

/* ------------------------------------------------------------------ */
/* Форма задачи                                                        */
/* ------------------------------------------------------------------ */

/**
 * Не «о чём задача», а «какой экран ей нужен». Сравнение вариантов,
 * отслеживание во времени и пошаговый план — это три принципиально
 * разных интерфейса, и путать их хуже, чем ошибиться в теме.
 */
export type Shape = 'compare' | 'track' | 'plan' | 'checklist';

const SHAPE_PATTERNS: Array<{ shape: Shape; re: RegExp }> = [
  { shape: 'compare', re: /(?<![а-яёa-z])(выбрать|сравн|какой лучше|что лучше|варианты|подобрать|дешевле|выгодн)/i },
  { shape: 'track', re: /(?<![а-яёa-z])(трекер|отслеж|следить|учёт|учет|привычк|каждый день|прогресс|统)/i },
  { shape: 'plan', re: /(?<![а-яёa-z])(спланир|организов|подготов|этап|план на|расписан|график)/i },
];

export function detectShape(goal: string): Shape {
  return SHAPE_PATTERNS.find((p) => p.re.test(goal))?.shape ?? 'checklist';
}

/* ------------------------------------------------------------------ */
/* Эвристическая сборка                                                */
/* ------------------------------------------------------------------ */

const header = (title: string, subtitle: string): UINode => ({
  type: 'section',
  children: [
    { type: 'heading', props: { text: title, level: 1 } },
    { type: 'text', props: { text: subtitle, tone: 'muted' } },
  ],
});

/** Блок с найденным. Показывается только когда есть что показать. */
const findingsCard = (): UINode => ({
  type: 'card',
  visibleIf: { ref: { source: 'data', path: 'findings' }, op: 'exists' },
  children: [
    { type: 'heading', props: { text: 'Что я нашёл', level: 2 } },
    {
      type: 'stack',
      repeat: { ref: { source: 'data', path: 'findings' }, as: 'finding' },
      children: [
        { type: 'label', bind: { text: { source: 'data', path: 'finding.title' } } },
        {
          type: 'list',
          repeat: { ref: { source: 'data', path: 'finding.keyPoints' }, as: 'point' },
          children: [{ type: 'text', bind: { text: { source: 'data', path: 'point' } }, props: { tone: 'muted' } }],
        },
      ],
    },
  ],
});

const checklistCard = (title: string): UINode => ({
  type: 'card',
  children: [
    { type: 'heading', props: { text: title, level: 2 } },
    {
      type: 'checklist',
      children: [
        {
          type: 'listItem',
          repeat: { ref: { source: 'data', path: 'items' }, as: 'item' },
          bind: {
            title: { source: 'data', path: 'item.name' },
            checked: { source: 'data', path: 'item.done' },
          },
          actions: {
            onPress: {
              kind: 'tool',
              tool: 'task.toggle_item',
              args: { itemId: { source: 'data', path: 'item.id' } },
              optimistic: true,
            },
          },
        },
      ],
    },
  ],
});

function buildRoot(shape: Shape, goal: string): UINode {
  const title = goal.slice(0, 90);

  switch (shape) {
    case 'compare':
      return {
        type: 'screen',
        props: { title: 'Сравнение' },
        children: [
          header(title, 'Собрал варианты и сравнил по тому, что обычно важно'),
          {
            type: 'card',
            children: [
              { type: 'heading', props: { text: 'Варианты', level: 2 } },
              {
                type: 'comparisonTable',
                bind: { items: { source: 'data', path: 'options' } },
                props: { criteria: ['Цена', 'Срок', 'Риск'] },
              },
              {
                type: 'emptyState',
                visibleIf: { ref: { source: 'data', path: 'options' }, op: 'empty' },
                props: { glyph: '⚖️', title: 'Пока сравнивать нечего', text: 'Сейчас соберу варианты' },
              },
            ],
          },
          findingsCard(),
          checklistCard('Что сделать'),
        ],
      };

    case 'track':
      return {
        type: 'screen',
        props: { title: 'Трекер' },
        children: [
          header(title, 'Веду учёт и напоминаю сам'),
          {
            type: 'card',
            children: [
              {
                type: 'row',
                props: { gap: 4 },
                children: [
                  { type: 'stat', bind: { value: { source: 'data', path: 'streak' } }, props: { label: 'Подряд', hint: 'дней' } },
                  { type: 'stat', bind: { value: { source: 'data', path: 'total' } }, props: { label: 'Всего' } },
                ],
              },
              { type: 'progress', bind: { value: { source: 'data', path: 'progress' } }, props: { label: 'Прогресс недели' } },
              { type: 'chart', bind: { series: { source: 'data', path: 'history' } } },
            ],
          },
          checklistCard('Сегодня'),
        ],
      };

    case 'plan':
      return {
        type: 'screen',
        props: { title: 'План' },
        children: [
          header(title, 'Разложил по шагам и держу сроки'),
          {
            type: 'card',
            children: [
              { type: 'heading', props: { text: 'Этапы', level: 2 } },
              { type: 'timeline', bind: { items: { source: 'data', path: 'milestones' } } },
            ],
          },
          checklistCard('Ближайшие дела'),
          findingsCard(),
        ],
      };

    default:
      return {
        type: 'screen',
        props: { title: 'Задача' },
        children: [
          header(title, 'Взял в работу'),
          checklistCard('Что нужно сделать'),
          findingsCard(),
        ],
      };
  }
}

function heuristicData(shape: Shape, goal: string): Record<string, unknown> {
  const base = {
    items: [
      { id: 'clarify', name: 'Уточнить детали', done: false },
      { id: 'research', name: 'Собрать варианты', done: false },
      { id: 'decide', name: 'Выбрать и сделать', done: false },
    ],
    goal,
  };

  switch (shape) {
    case 'compare':
      return { ...base, options: [] };
    case 'track':
      return { ...base, streak: 0, total: 0, progress: 0, history: [] };
    case 'plan':
      return {
        ...base,
        milestones: [
          { title: 'Определиться с рамками', done: false },
          { title: 'Подготовка', done: false },
          { title: 'Исполнение', done: false },
        ],
      };
    default:
      return base;
  }
}

/** Детерминированная сборка: без модели, без сети, воспроизводимо. */
export function heuristicCompose(input: ComposeInput): ComposeResult {
  const shape = detectShape(input.goal);
  const id = `gen-${shape}`;

  const spec: UISpec = {
    schemaVersion: '1.0',
    id,
    version: 1,
    title: input.goal.slice(0, 60),
    dataSources: [{ key: 'items', tool: 'task.checklist', args: {}, deferred: false }],
    meta: { origin: 'generated', graphRefs: [], shareable: false, runtimeKeys: ['findings', 'options', 'milestones', 'streak', 'total', 'progress', 'history'], generatedBy: 'heuristic' },
    root: buildRoot(shape, input.goal),
  };

  return { spec, data: heuristicData(shape, input.goal), origin: 'generated', attempts: 1 };
}

/* ------------------------------------------------------------------ */
/* Сборка моделью                                                      */
/* ------------------------------------------------------------------ */

/**
 * Системный промпт читает реестр инструментов ЛЕНИВО.
 *
 * Компилятор и реестр ссылаются друг на друга: инструмент miniapp.compose
 * зовёт компилятор, а компилятор перечисляет доступные инструменты. Вычисление
 * на этапе загрузки модуля упирается в незавершённый цикл импорта.
 */
function composeSystem(): string {
  return `Ты собираешь экран мини-приложения. Верни СТРОГО JSON UISpec без markdown-обёртки.
Разрешены ТОЛЬКО эти типы компонентов:
screen, scroll, stack, row, grid, section, card, divider, spacer, heading, text, label, badge, markdown,
image, icon, avatar, list, listItem, checklist, table, keyValue, chart, progress, stat, timeline, calendar,
textField, textArea, numberField, select, multiSelect, radioGroup, checkbox, toggle, slider, rating,
datePicker, timePicker, button, buttonGroup, link, alert, emptyState, skeleton, confirmSheet,
comparisonTable, stepper, form.

Формат:
{"schemaVersion":"1.0","id":"<kebab-case>","version":1,"title":"...","dataSources":[{"key":"items","tool":"task.checklist","args":{}}],
 "meta":{"origin":"generated","graphRefs":[],"shareable":false},
 "root":{"type":"screen","children":[...]}}

Правила:
- корень всегда screen;
- данные подставляй через bind: {"свойство":{"source":"data","path":"..."}}, а не хардкодом;
- списки через repeat: {"ref":{"source":"data","path":"items"},"as":"item"};
- экшены только на инструменты из списка: ${[...KNOWN_TOOLS].join(', ')};
- не больше 40 узлов.`;
}

export interface ComposerDeps {
  llm: LlmPort;
}

/**
 * Полный конвейер сборки.
 *
 * Каталог → эвристика → модель. Модель зовём последней не из экономии токенов,
 * а потому что предсказуемый экран лучше оригинального: пользователь строит
 * привычку к интерфейсу, и он не должен меняться от запуска к запуску.
 */
export async function compose(input: ComposeInput, deps?: ComposerDeps): Promise<ComposeResult> {
  const entry = CATALOG.find((e) => e.families.includes(input.family) && e.id !== 'generic-task');

  if (entry) {
    const spec = entry.build(input);
    const validation = validateSpec(spec, { knownTools: KNOWN_TOOLS });
    if (validation.ok) {
      const parameterized = Object.keys(input.params).length > 0;
      return {
        spec,
        data: entry.data(input),
        origin: parameterized ? 'parameterized' : 'catalog',
        attempts: 1,
      };
    }
    // Каталожная запись сломана — это баг у нас, и он должен быть виден.
    log.error('каталожная мини-аппа не проходит валидацию', { id: entry.id, errors: validation.errors });
  }

  if (deps?.llm.plan) {
    const generated = await generateWithRepair(
      async (feedback) => {
        const user = feedback
          ? `Цель: ${input.goal}\n\n${feedback}`
          : `Цель: ${input.goal}\nФорма экрана: ${detectShape(input.goal)}`;
        return deps.llm.plan?.(composeSystem(), user) ?? null;
      },
      { knownTools: KNOWN_TOOLS }
    );

    if (generated.spec) {
      const shape = detectShape(input.goal);
      return {
        spec: { ...generated.spec, meta: { ...generated.spec.meta, generatedBy: 'llm' } },
        data: heuristicData(shape, input.goal),
        origin: 'generated',
        attempts: generated.attempts,
      };
    }
    log.warn('генерация не дала валидной спеки, беру эвристику', { errors: generated.lastErrors.length });
  }

  const heuristic = heuristicCompose(input);
  const validation = validateSpec(heuristic.spec, { knownTools: KNOWN_TOOLS });
  if (validation.ok) return heuristic;

  // Последний рубеж: универсальная запись каталога всегда валидна,
  // потому что проверяется на старте процесса.
  log.error('эвристическая сборка невалидна', { errors: validation.errors });
  const fallback = selectEntry('other');
  return { spec: fallback.build(input), data: fallback.data(input), origin: 'catalog', attempts: 1 };
}
