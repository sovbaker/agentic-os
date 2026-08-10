import type { UISpec, UINode } from '@agentic-os/contracts';
import type { JobFamily } from '../orchestrator/llm';

/**
 * Каталог мини-апп.
 *
 * Каталог — основной путь, генерация — длинный хвост. Так сходится экономика:
 * сотый пользователь получает готовую проверенную аппу, а не свежесгенерированную,
 * и предельная стоимость стремится к нулю, пока качество растёт.
 *
 * В S0 три записи — этого достаточно, чтобы контур работал end-to-end.
 * Остальные добавляются в S2 без изменения кода вокруг.
 */

export interface CatalogParams {
  goal: string;
  params: Record<string, string>;
  locale: string;
}

export interface CatalogEntry {
  id: string;
  title: (p: CatalogParams) => string;
  families: JobFamily[];
  build: (p: CatalogParams) => UISpec;
  data: (p: CatalogParams) => Record<string, unknown>;
}

const node = (n: UINode): UINode => n;

function formatMonth(iso: string | undefined, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}


/**
 * Блок «что происходит по делу».
 *
 * То, чего в продукте не было вовсе: ход агента, объявленное намерение и
 * ожидание третьей стороны. Без этих трёх строк экран описывает задачу,
 * а не работу над ней, и отличить продукт от списка дел нечем.
 *
 * Данные приходят в рантайме от шагов задачи (`runtimeKeys`), поэтому блок
 * целиком скрывается, когда ходов ещё нет: пустой раздел «что я сделал»
 * хуже его отсутствия.
 */
function movesBlock(): UINode {
  return node({
    type: 'card',
    visibleIf: { ref: { source: 'data', path: 'hasMoves' }, op: 'eq', value: true },
    children: [
      { type: 'heading', props: { text: 'Что происходит', level: 2 } },
      {
        type: 'stack',
        props: { gap: 3 },
        repeat: { ref: { source: 'data', path: 'awaitingMoves' }, as: 'm' },
        children: [
          {
            type: 'awaiting',
            bind: {
              who: { source: 'data', path: 'm.who' },
              since: { source: 'data', path: 'm.since' },
              usually: { source: 'data', path: 'm.usually' },
            },
          },
        ],
      },
      {
        type: 'stack',
        props: { gap: 3 },
        repeat: { ref: { source: 'data', path: 'intentMoves' }, as: 'm' },
        children: [
          {
            type: 'agentIntent',
            bind: {
              title: { source: 'data', path: 'm.title' },
              before: { source: 'data', path: 'm.before' },
              after: { source: 'data', path: 'm.after' },
              discloses: { source: 'data', path: 'm.discloses' },
            },
            actions: {
              onConfirm: {
                kind: 'tool',
                tool: 'task.confirm_move',
                args: { moveId: { source: 'data', path: 'm.id' } },
              },
            },
          },
        ],
      },
      {
        type: 'stack',
        props: { gap: 3 },
        repeat: { ref: { source: 'data', path: 'didMoves' }, as: 'm' },
        children: [
          {
            type: 'agentDid',
            bind: {
              title: { source: 'data', path: 'm.title' },
              at: { source: 'data', path: 'm.at' },
              undoUntil: { source: 'data', path: 'm.undoUntil' },
            },
            actions: {
              onUndo: {
                kind: 'tool',
                tool: 'task.undo_move',
                args: { moveId: { source: 'data', path: 'm.id' } },
              },
            },
          },
        ],
      },
    ],
  });
}

/** Ключи, которые блок ходов ждёт от задачи в рантайме. */
const MOVE_KEYS = ['hasMoves', 'didMoves', 'intentMoves', 'awaitingMoves', 'reminderState', 'reminderDone'] as const;

/* ------------------------------------------------------------------ */
/* Документы и дедлайны                                                */
/* ------------------------------------------------------------------ */

const docsDeadline: CatalogEntry = {
  id: 'docs-deadline',
  families: ['documents'],
  title: (p) => (p.params['country'] ? `Виза: ${p.params['country']}` : 'Документы и дедлайны'),

  data: (p) => {
    const country = p.params['country'];
    const items = country
      ? [
          { id: 'passport', name: 'Загранпаспорт — срок действия ≥ 3 мес после поездки', done: false },
          { id: 'photos', name: 'Фото 35×45 мм, 2 шт', done: false },
          { id: 'insurance', name: 'Страховка на весь срок поездки', done: false },
          { id: 'booking', name: 'Подтверждение проживания', done: false },
          { id: 'finances', name: 'Выписка со счёта за 3 месяца', done: false },
          { id: 'form', name: 'Заполненная анкета', done: false },
        ]
      : [
          { id: 'list', name: 'Уточнить список документов', done: false },
          { id: 'deadline', name: 'Поставить напоминание о сроке', done: false },
        ];
    return { items, deadline: p.params['deadline'] ?? null };
  },

  build: (p) => {
    const country = p.params['country'];
    const deadlineText = formatMonth(p.params['deadline'], p.locale);

    return {
      schemaVersion: '1.0',
      id: 'docs-deadline',
      version: 1,
      title: country ? `Виза: ${country}` : 'Документы и дедлайны',
      dataSources: [{ key: 'items', tool: 'docs.checklist', args: {}, deferred: false }],
      meta: { origin: 'catalog', graphRefs: [], shareable: false, runtimeKeys: [...MOVE_KEYS] },
      root: node({
        type: 'screen',
        props: { title: country ? `Виза: ${country}` : 'Документы и дедлайны' },
        children: [
          {
            type: 'section',
            children: [
              { type: 'heading', props: { text: country ? `Виза: ${country}` : 'Документы и дедлайны', level: 1 } },
              deadlineText
                ? { type: 'badge', props: { text: `Успеть к: ${deadlineText}`, tone: 'warning' } }
                : { type: 'text', props: { text: 'Срок не указан — уточню позже', tone: 'muted' } },
            ],
          },
          {
            type: 'card',
            children: [
              { type: 'heading', props: { text: 'Что нужно собрать', level: 2 } },
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
          },
          {
            type: 'card',
            children: [
              { type: 'heading', props: { text: 'Первый шаг сегодня', level: 2 } },
              {
                type: 'text',
                props: {
                  text: country
                    ? `Проверь срок действия загранпаспорта — от этого зависит, успеваешь ли ты вообще.`
                    : 'Скажи, о каких документах речь, и я соберу точный список.',
                },
              },
              {
                /*
                 * Состояние приходит от сервера: иначе кнопка остаётся
                 * активной после срабатывания и приглашает второе нажатие,
                 * а закрытие дела выглядит строкой системного лога.
                 */
                type: 'button',
                props: { label: 'Напомнить через 2 дня', variant: 'primary' },
                bind: { state: { source: 'data', path: 'reminderState' }, doneLabel: { source: 'data', path: 'reminderDone' } },
                actions: {
                  onPress: {
                    kind: 'tool',
                    tool: 'reminder.schedule',
                    args: { afterDays: 2, about: 'Проверить документы' },
                  },
                },
              },
            ],
          },
          movesBlock(),
        ],
      }),
    };
  },
};

/* ------------------------------------------------------------------ */
/* Поездка                                                             */
/* ------------------------------------------------------------------ */

const trip: CatalogEntry = {
  id: 'trip',
  families: ['travel'],
  title: (p) => (p.params['country'] ? `Поездка: ${p.params['country']}` : 'Поездка'),

  data: (p) => ({
    items: [
      { id: 'dates', name: 'Определить даты', done: false },
      { id: 'tickets', name: 'Билеты', done: false },
      { id: 'stay', name: 'Проживание', done: false },
      { id: 'docs', name: 'Документы и страховка', done: false },
      { id: 'pack', name: 'Собрать чемодан', done: false },
    ],
    destination: p.params['country'] ?? null,
  }),

  build: (p) => {
    const dest = p.params['country'];
    return {
      schemaVersion: '1.0',
      id: 'trip',
      version: 1,
      title: dest ? `Поездка: ${dest}` : 'Поездка',
      dataSources: [{ key: 'items', tool: 'trip.checklist', args: {}, deferred: false }],
      meta: { origin: 'catalog', graphRefs: [], shareable: false, runtimeKeys: [...MOVE_KEYS] },
      root: node({
        type: 'screen',
        props: { title: dest ? `Поездка: ${dest}` : 'Поездка' },
        children: [
          {
            type: 'section',
            children: [
              { type: 'heading', props: { text: dest ? `Поездка: ${dest}` : 'Новая поездка', level: 1 } },
              { type: 'text', props: { text: 'Веду весь план и напоминаю сам', tone: 'muted' } },
            ],
          },
          {
            type: 'card',
            children: [
              { type: 'heading', props: { text: 'План', level: 2 } },
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
          },
          movesBlock(),
        ],
      }),
    };
  },
};

/* ------------------------------------------------------------------ */
/* Универсальная задача — длинный хвост до появления генерации          */
/* ------------------------------------------------------------------ */

const genericTask: CatalogEntry = {
  id: 'generic-task',
  families: ['other', 'home', 'health', 'routine'],
  title: (p) => p.goal.slice(0, 60),

  data: (p) => ({
    items: [
      { id: 'clarify', name: 'Уточнить детали', done: false },
      { id: 'research', name: 'Собрать варианты', done: false },
      { id: 'decide', name: 'Выбрать и сделать', done: false },
    ],
    goal: p.goal,
  }),

  build: (p) => ({
    schemaVersion: '1.0',
    id: 'generic-task',
    version: 1,
    title: p.goal.slice(0, 60),
    dataSources: [{ key: 'items', tool: 'task.checklist', args: {}, deferred: false }],
    meta: { origin: 'catalog', graphRefs: [], shareable: false, runtimeKeys: [...MOVE_KEYS] },
    root: node({
      type: 'screen',
      props: { title: 'Задача' },
      children: [
        {
          type: 'section',
          children: [
            { type: 'heading', props: { text: p.goal.slice(0, 90), level: 1 } },
            { type: 'badge', props: { text: 'Взял в работу', tone: 'success' } },
          ],
        },
        {
          type: 'card',
          children: [
            { type: 'heading', props: { text: 'Как я это закрою', level: 2 } },
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
        },
        {
          type: 'card',
          children: [
            { type: 'heading', props: { text: 'Нужно от тебя', level: 2 } },
            { type: 'text', props: { text: 'Один уточняющий вопрос — не больше. Что здесь важнее: срок или бюджет?' } },
            {
              type: 'textField',
              props: { label: 'Ответ', placeholder: 'Напиши пару слов' },
              actions: {
                /*
                 * Раньше ответ уходил в клиентский мешок состояния, которого
                 * никто не читал, а следующий ход его стирал: ассистент
                 * задавал свой единственный уточняющий вопрос и выбрасывал
                 * ответ. Теперь ответ продолжает задачу.
                 */
                onSubmit: { kind: 'tool', tool: 'task.answer', args: {} },
              },
            },
          ],
        },
        movesBlock(),
      ],
    }),
  }),
};

/* ------------------------------------------------------------------ */
/* Дом, ремонт, подрядчики                                             */
/* ------------------------------------------------------------------ */

const homeContractors: CatalogEntry = {
  id: 'home-contractors',
  families: ['home'],
  title: () => 'Подрядчики',

  data: () => ({
    items: [
      { id: 'scope', name: 'Описать объём работ', done: false },
      { id: 'find', name: 'Найти 3 кандидатов', done: false },
      { id: 'quotes', name: 'Собрать сметы письменно', done: false },
      { id: 'contract', name: 'Зафиксировать сроки в договоре', done: false },
    ],
    // Пустой список — нормальное состояние: варианты приедут после поиска.
    options: [],
  }),

  build: (p) => ({
    schemaVersion: '1.0',
    id: 'home-contractors',
    version: 1,
    title: 'Подрядчики',
    dataSources: [{ key: 'items', tool: 'task.checklist', args: {}, deferred: false }],
    meta: { origin: 'catalog', graphRefs: [], shareable: false, runtimeKeys: [...MOVE_KEYS] },
    root: {
      type: 'screen',
      props: { title: 'Подрядчики' },
      children: [
        {
          type: 'section',
          children: [
            { type: 'heading', props: { text: p.goal.slice(0, 80), level: 1 } },
            { type: 'text', props: { text: 'Веду отбор и контролирую этапы', tone: 'muted' } },
          ],
        },
        {
          // Единственное, что реально защищает деньги в ремонте.
          type: 'alert',
          props: {
            tone: 'warning',
            title: 'Правило',
            text: 'Смета письменно, сроки этапов в договоре, аванс не больше 30%.',
          },
        },
        {
          type: 'card',
          children: [
            { type: 'heading', props: { text: 'Кандидаты', level: 2 } },
            {
              type: 'comparisonTable',
              bind: { items: { source: 'data', path: 'options' } },
              props: { criteria: ['Цена', 'Срок', 'Отзывы'] },
            },
            {
              type: 'emptyState',
              visibleIf: { ref: { source: 'data', path: 'options' }, op: 'empty' },
              props: { glyph: '🔨', title: 'Кандидатов пока нет', text: 'Соберу и покажу сравнение' },
            },
          ],
        },
        {
          type: 'card',
          children: [
            { type: 'heading', props: { text: 'Порядок действий', level: 2 } },
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
        },
        movesBlock(),
      ],
    },
  }),
};

/* ------------------------------------------------------------------ */
/* Здоровье и записи                                                   */
/* ------------------------------------------------------------------ */

const healthAppointments: CatalogEntry = {
  id: 'health-appointments',
  families: ['health'],
  title: () => 'Здоровье',

  data: () => ({
    items: [
      { id: 'choose', name: 'Выбрать врача или клинику', done: false },
      { id: 'book', name: 'Записаться', done: false },
      { id: 'prepare', name: 'Подготовиться к приёму', done: false },
      { id: 'results', name: 'Забрать результаты', done: false },
    ],
    events: [],
  }),

  build: (p) => ({
    schemaVersion: '1.0',
    id: 'health-appointments',
    version: 1,
    title: 'Здоровье',
    dataSources: [
      { key: 'items', tool: 'task.checklist', args: {}, deferred: false },
      { key: 'events', tool: 'calendar.list_events', args: { fromDays: 0, toDays: 60 }, deferred: true },
    ],
    meta: { origin: 'catalog', graphRefs: [], shareable: false, runtimeKeys: [...MOVE_KEYS] },
    root: {
      type: 'screen',
      props: { title: 'Здоровье' },
      children: [
        {
          type: 'section',
          children: [
            { type: 'heading', props: { text: p.goal.slice(0, 80), level: 1 } },
            { type: 'text', props: { text: 'Держу сроки и напоминаю', tone: 'muted' } },
          ],
        },
        {
          type: 'card',
          children: [
            { type: 'heading', props: { text: 'Ближайшее', level: 2 } },
            { type: 'calendar', bind: { events: { source: 'data', path: 'events' } } },
          ],
        },
        {
          type: 'card',
          children: [
            { type: 'heading', props: { text: 'Шаги', level: 2 } },
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
        },
        movesBlock(),
      ],
    },
  }),
};

/* ------------------------------------------------------------------ */

export const CATALOG: readonly CatalogEntry[] = [
  docsDeadline,
  trip,
  homeContractors,
  healthAppointments,
  genericTask,
];

export function selectEntry(family: JobFamily): CatalogEntry {
  const match = CATALOG.find((e) => e.families.includes(family));
  // genericTask всегда последний и покрывает всё — каталог не может не ответить.
  return match ?? genericTask;
}
