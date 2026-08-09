import { z } from 'zod';

/**
 * Life Graph — система записи о жизни пользователя.
 *
 * Два свойства, которые почти всегда забывают и без которых ассистент
 * становится опаснее, чем полезнее:
 *
 *  1. ПРОВЕНАНС — на любой факт можно ответить «откуда ты это взял».
 *  2. БИТЕМПОРАЛЬНОСТЬ — когда факт был истинным ≠ когда мы о нём узнали.
 *     Жизненные факты меняются, и ассистент, уверенно помнящий устаревшее,
 *     хуже ассистента без памяти: он ошибается авторитетно.
 */

export const EntityType = z.enum([
  'person',      // люди: семья, коллеги, врачи, подрядчики
  'place',       // дом, работа, школа, города
  'org',         // компании, клиники, банки, сервисы
  'thing',       // машина, квартира, техника
  'document',    // паспорт, страховка, виза, договор
  'account',     // подписки, счета, тарифы
  'recurring',   // повторяющиеся события и обязательства
  'goal',        // намерения и проекты
  'constraint',  // «никогда не делай X», аллергии, ограничения
]);
export type EntityType = z.infer<typeof EntityType>;

export const Entity = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  type: EntityType,
  label: z.string(),
  attrs: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable().default(null),
});
export type Entity = z.infer<typeof Entity>;

/** Откуда пришёл факт. Порядок в разрешении конфликтов задаётся именно этим полем. */
export const FactSource = z.enum([
  'user_said',   // прямое утверждение — бьёт всё остальное
  'user_confirmed',
  'calendar',
  'email',
  'contacts',
  'procedure',   // получено в ходе выполнения задачи
  'inferred',    // вывод модели или priors по архетипу — самая низкая уверенность
]);
export type FactSource = z.infer<typeof FactSource>;

export const Fact = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),

  subjectId: z.string().uuid(),
  predicate: z.string(),                              // works_at | lives_in | owns | prefers | due_on | child_of ...
  objectId: z.string().uuid().nullable().default(null),
  objectValue: z.unknown().optional(),                // литерал, если объект — не сущность

  // провенанс
  source: FactSource,
  sourceRef: z.string().optional(),                   // id письма, события, шага задачи
  confidence: z.number().min(0).max(1).default(0.7),
  observedAt: z.string().datetime(),                  // когда МЫ узнали

  // битемпоральность
  validFrom: z.string().datetime().nullable().default(null),  // когда факт стал истинным
  validTo: z.string().datetime().nullable().default(null),    // null = актуален

  supersededBy: z.string().uuid().nullable().default(null),
});
export type Fact = z.infer<typeof Fact>;

/**
 * Политика разрешения конфликтов. Порядок применения — сверху вниз.
 * Физически ничего не удаляем: supersededBy сохраняет историю,
 * чтобы ассистент мог сказать «раньше ты говорил иначе».
 */
export const CONFLICT_POLICY = [
  'user_said бьёт любой вывод',
  'более свежее observedAt бьёт старое при равном источнике',
  'при высокой уверенности с обеих сторон — старый факт закрывается (validTo), вопрос ставится в очередь',
  'вопрос задаётся в подходящий момент, а не немедленно',
] as const;

/** Скорость затухания уверенности: разные предикаты живут по-разному. */
export const DECAY_HALF_LIFE_DAYS: Record<string, number> = {
  lives_in: 730,
  works_at: 545,
  owns: 365,
  prefers: 180,
  goal: 90,
  currently: 30,
  _default: 365,
};

/**
 * Гибридный retrieval: четыре сигнала, а не только вектор.
 * «RAG по всему подряд» даёт ассистента, который помнит случайное вместо нужного.
 */
export const RetrievalQuery = z.object({
  userId: z.string().uuid(),
  intent: z.string(),
  entityTypes: z.array(EntityType).optional(),
  predicates: z.array(z.string()).optional(),
  timeRange: z.object({ from: z.string().datetime(), to: z.string().datetime() }).optional(),
  limit: z.number().int().positive().default(30),
  minConfidence: z.number().min(0).max(1).default(0.3),
});
export type RetrievalQuery = z.infer<typeof RetrievalQuery>;

export const RETRIEVAL_WEIGHTS = {
  structural: 0.4,   // соответствие типов, предикатов, связь с задачей
  semantic: 0.3,     // векторная близость
  recency: 0.2,      // экспоненциальное затухание
  importance: 0.1,   // частота обращений, ручное закрепление
} as const;

/**
 * Дыра в графе — то, чего мы не знаем и что стоит спросить.
 * Приоритет = сколько задач блокирует × частота обращений × дешевизна вопроса.
 * Спрашиваем не больше одного вопроса в день и в подходящий момент —
 * лучше всего сразу после успешно закрытой задачи, когда доверие на пике.
 */
export const KnowledgeGap = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  question: z.string(),
  predicate: z.string(),
  blocksJobs: z.number().int().default(0),
  askCost: z.enum(['cheap', 'medium', 'sensitive']),
  priority: z.number(),
  askedAt: z.string().datetime().nullable().default(null),
});
export type KnowledgeGap = z.infer<typeof KnowledgeGap>;
