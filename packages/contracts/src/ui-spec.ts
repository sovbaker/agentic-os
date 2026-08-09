import { z } from 'zod';

/**
 * UISpec — контракт server-driven UI.
 *
 * Ключевой принцип: сервер присылает ДАННЫЕ И КОМПОЗИЦИЮ, но никогда — код.
 * Это одновременно требование App Store (2.5.2 / 3.3.2), требование безопасности
 * и условие того, чтобы рендер был быстрым и детерминированным.
 *
 * Мини-аппа генерируется ОДИН РАЗ и версионируется. Рендер после этого —
 * обычная детерминированная функция, а не обращение к модели.
 */

/* ------------------------------------------------------------------ */
/* Реестр компонентов                                                  */
/* ------------------------------------------------------------------ */

/**
 * Закрытый список. Модель может использовать только эти типы —
 * всё остальное отсекается валидатором до того, как дойдёт до клиента.
 */
export const ComponentType = z.enum([
  // раскладка
  'screen', 'stack', 'row', 'grid', 'section', 'card', 'divider', 'spacer', 'scroll',
  // текст
  'heading', 'text', 'label', 'badge', 'markdown',
  // медиа
  'image', 'icon', 'avatar',
  // данные
  'list', 'listItem', 'table', 'keyValue', 'chart', 'progress', 'stat', 'timeline', 'calendar', 'map',
  // ввод
  'textField', 'textArea', 'numberField', 'select', 'multiSelect',
  'datePicker', 'timePicker', 'toggle', 'slider', 'checkbox', 'radioGroup', 'rating', 'fileUpload',
  // действия
  'button', 'buttonGroup', 'link',
  // обратная связь
  'alert', 'emptyState', 'skeleton', 'confirmSheet',
  // составные
  'checklist', 'comparisonTable', 'stepper', 'form',
]);
export type ComponentType = z.infer<typeof ComponentType>;

/* ------------------------------------------------------------------ */
/* Привязка данных                                                     */
/* ------------------------------------------------------------------ */

/** Откуда компонент берёт значение. Данные приходят отдельно от структуры. */
export const DataRef = z.object({
  source: z.enum([
    'data',   // из полезной нагрузки экрана
    'state',  // локальное состояние формы на клиенте
    'graph',  // факт из life graph (резолвится сервером)
    'job',    // поле текущей задачи
  ]),
  path: z.string().min(1),
  fallback: z.unknown().optional(),
});
export type DataRef = z.infer<typeof DataRef>;

export const Condition = z.object({
  ref: DataRef,
  op: z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'exists', 'empty', 'in']),
  value: z.unknown().optional(),
});
export type Condition = z.infer<typeof Condition>;

/* ------------------------------------------------------------------ */
/* Действия                                                            */
/* ------------------------------------------------------------------ */

/**
 * Клиент НЕ ЗНАЕТ, что делает кнопка. Он отправляет намерение, вся логика — на сервере.
 * Поэтому поведение можно менять без релиза приложения, и поэтому клиент
 * невозможно заставить выполнить произвольное действие подменой спеки.
 */
export const UIAction = z.discriminatedUnion('kind', [
  /** Вызов серверного инструмента. Класс прав определяется манифестом инструмента, не моделью. */
  z.object({
    kind: z.literal('tool'),
    tool: z.string(),
    args: z.record(z.string(), z.union([z.unknown(), DataRef])).default({}),
    /** Текст подтверждения. Обязателен для инструментов класса `confirm`. */
    confirm: z.string().optional(),
    /** Отсутствие = обычное поведение; необязательно, чтобы спеки было легко писать руками. */
    optimistic: z.boolean().optional(),
  }),
  /** Навигация внутри приложения. */
  z.object({
    kind: z.literal('navigate'),
    target: z.enum(['miniapp', 'job', 'feed', 'settings']),
    id: z.string().optional(),
  }),
  /** Изменение локального состояния формы — без похода на сервер. */
  z.object({
    kind: z.literal('setState'),
    path: z.string(),
    value: z.unknown(),
  }),
  /** Отправка формы целиком. */
  z.object({
    kind: z.literal('submit'),
    formId: z.string(),
    tool: z.string(),
  }),
  /**
   * Ассистированная передача: агент подготовил всё, последний шаг делает человек.
   * Замена эмулятора для транзакционных сценариев.
   */
  z.object({
    kind: z.literal('handoff'),
    url: z.string(),                          // deep link с предзаполненным состоянием
    fallbackUrl: z.string().optional(),       // если приложение не установлено
    label: z.string(),
  }),
]);
export type UIAction = z.infer<typeof UIAction>;

/* ------------------------------------------------------------------ */
/* Дерево                                                              */
/* ------------------------------------------------------------------ */

export type UINode = {
  type: ComponentType;
  id?: string;
  props?: Record<string, unknown>;
  bind?: Record<string, DataRef>;
  actions?: Record<string, UIAction>;
  visibleIf?: Condition;
  /** Повтор узла по коллекции: аналог map, но декларативный. */
  repeat?: { ref: DataRef; as: string };
  children?: UINode[];
};

export const UINode: z.ZodType<UINode> = z.lazy(() =>
  z.object({
    type: ComponentType,
    id: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    bind: z.record(z.string(), DataRef).optional(),
    actions: z.record(z.string(), UIAction).optional(),
    visibleIf: Condition.optional(),
    repeat: z.object({ ref: DataRef, as: z.string() }).optional(),
    children: z.array(UINode).optional(),
  })
);

/* ------------------------------------------------------------------ */
/* Мини-аппа                                                           */
/* ------------------------------------------------------------------ */

/**
 * Бюджет сложности. Без него модель однажды нарисует таблицу на 5000 строк
 * и положит телефон. Проверяется валидатором, а не надеждой.
 */
export const COMPLEXITY_BUDGET = {
  maxNodes: 200,
  maxDepth: 12,
  maxBindingsPerScreen: 40,
  maxActionsPerScreen: 30,
} as const;

export const UISpec = z.object({
  /** Версия схемы. Старый клиент обязан деградировать, а не падать. */
  schemaVersion: z.literal('1.0'),

  id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  icon: z.string().optional(),

  /** Что нужно подгрузить перед рендером. */
  dataSources: z.array(z.object({
    key: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
    /** Показывать скелетон, а не блокировать экран. */
    deferred: z.boolean().default(false),
  })).default([]),

  root: UINode,

  meta: z.object({
    origin: z.enum(['catalog', 'parameterized', 'generated']),
    /** Сущности life graph, к которым привязана аппа. */
    graphRefs: z.array(z.string()).default([]),
    shareable: z.boolean().default(false),
    generatedBy: z.string().optional(),
    parentId: z.string().optional(),
  }),
});
export type UISpec = z.infer<typeof UISpec>;

/* ------------------------------------------------------------------ */
/* Результат валидации                                                 */
/* ------------------------------------------------------------------ */

/**
 * Результат прогона через валидатор. Ошибки возвращаются модели в repair loop
 * (не более 2 попыток), после чего показывается статический fallback.
 * Пользователь никогда не видит сломанный экран.
 */
export const ValidationResult = z.object({
  ok: z.boolean(),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
    hint: z.string().optional(),   // подсказка для модели, а не для человека
  })).default([]),
  budgetExceeded: z.array(z.string()).default([]),
});
export type ValidationResult = z.infer<typeof ValidationResult>;
