import { z } from 'zod';

/**
 * Job — единица работы. НЕ сообщение в чате, а персистентный автомат.
 *
 * Бытовые задачи живут часами и днями: ждём ответа врача, ждём доставку,
 * ждём наступления вторника. In-memory ReAct-луп теряет всё это при деплое,
 * и это худший вид отказа для ассистента — тихий.
 */

export const JobStatus = z.enum([
  'planning',
  'running',
  'waiting_user',    // нужно подтверждение или ответ человека
  'waiting_world',   // ждём внешнего события или наступления времени
  'done',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatus>;

/** Класс прав. Атрибут манифеста инструмента — не решение модели в рантайме. */
export const PermissionClass = z.enum([
  'auto',     // чтение, расчёты, черновики — без подтверждения
  'confirm',  // отправка людям, запись на приём, создание событий у других
  'never',    // деньги, удаление, юридически значимое — вне автоматизации в MVP
]);
export type PermissionClass = z.infer<typeof PermissionClass>;

export const ToolManifest = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  permission: PermissionClass,
  /** Как откатить эффект. Обязательно для всего, что не `auto`. */
  compensation: z.string().optional(),
  /** Правда ли инструмент возвращает недоверенный контент (веб, письма, OCR). */
  returnsUntrusted: z.boolean().default(false),
  costHint: z.enum(['free', 'cheap', 'expensive']).default('cheap'),
  timeoutMs: z.number().int().default(30_000),
  source: z.enum(['builtin', 'mcp']).default('builtin'),
});
export type ToolManifest = z.infer<typeof ToolManifest>;

export const JobStep = z.object({
  id: z.string().uuid(),
  idx: z.number().int().nonnegative(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  /** Защита от двойного выполнения при ретраях. Без неё ретрай = второе письмо. */
  idempotencyKey: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped', 'compensated']),
  dependsOn: z.array(z.number().int()).default([]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  attempts: z.number().int().default(0),
  maxAttempts: z.number().int().default(3),
  /** Проверяются критиком: без них агент уверенно рапортует об успехе впустую. */
  postconditions: z.array(z.string()).default([]),
});
export type JobStep = z.infer<typeof JobStep>;

export const Job = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),

  goal: z.string(),
  status: JobStatus,
  steps: z.array(JobStep).default([]),

  artifacts: z.array(z.object({
    kind: z.enum(['miniapp', 'document', 'draft', 'report']),
    id: z.string(),
    title: z.string(),
  })).default([]),

  graphRefs: z.array(z.string().uuid()).default([]),

  budget: z.object({
    maxToolCalls: z.number().int().default(40),
    maxCostRub: z.number().default(25),
    maxDurationMs: z.number().int().default(7 * 24 * 3600 * 1000),
    spentRub: z.number().default(0),
    toolCalls: z.number().int().default(0),
  }),

  /** Для waiting_world: когда разбудить задачу. */
  wakeAt: z.string().datetime().nullable().default(null),
  /** Для waiting_user: что именно мы спросили. */
  pendingQuestion: z.string().nullable().default(null),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Job = z.infer<typeof Job>;

/** Аудит: пользователь всегда может спросить «что ты сделал и почему» и отменить. */
export const AuditEntry = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  jobId: z.string().uuid().nullable(),
  at: z.string().datetime(),
  action: z.string(),
  humanReadable: z.string(),   // человеческим языком, не JSON
  reason: z.string(),          // почему агент решил, что это нужно
  permission: PermissionClass,
  confirmedByUser: z.boolean(),
  reversible: z.boolean(),
  reversedAt: z.string().datetime().nullable().default(null),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/**
 * Процедура — процедурная память, то есть главный кандидат в ров.
 * Единица — параметризованная и верифицируемая процедура, а НЕ транскрипт диалога:
 * транскрипт нельзя проверить, переиспользовать и починить.
 *
 * userId = null означает обезличенный общий скелет, пригодный к переиспользованию
 * между пользователями. Разделение скелета и параметров заложено сразу —
 * иначе потом невозможно распутать личные данные.
 */
export const Procedure = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  name: z.string(),
  triggerSpec: z.record(z.string(), z.unknown()),
  paramsSchema: z.record(z.string(), z.unknown()),
  steps: z.array(JobStep.partial({ id: true, status: true })),
  postconditions: z.array(z.string()),
  compensation: z.array(z.string()).default([]),
  successRate: z.number().min(0).max(1).nullable().default(null),
  runs: z.number().int().default(0),
  status: z.enum(['draft', 'verified', 'quarantined']).default('draft'),
});
export type Procedure = z.infer<typeof Procedure>;

/**
 * Классификация проактивных событий. Бюджет — не более 3 в день,
 * с приоритетным вытеснением. Игнор пользователя — сильный отрицательный
 * сигнал, обязан снижать частоту этого класса.
 */
export const ProactiveEvent = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(['morning_brief', 'did_for_you', 'need_decision', 'deadline', 'discovery']),
  title: z.string(),
  body: z.string(),
  jobId: z.string().uuid().nullable().default(null),
  score: z.number(),           // важность × срочность × P(полезно) × уместность времени
  scheduledFor: z.string().datetime(),
  deliveredAt: z.string().datetime().nullable().default(null),
  reaction: z.enum(['opened', 'ignored', 'muted_class']).nullable().default(null),
});
export type ProactiveEvent = z.infer<typeof ProactiveEvent>;
