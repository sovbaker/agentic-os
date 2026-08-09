import { z } from 'zod';
import { UISpec } from './ui-spec';
import { Job } from './job';

/**
 * Протокол между клиентом и сервером.
 *
 * Один источник правды для обеих сторон — расхождение контрактов между
 * клиентом и сервером самая частая причина боли в SDUI-системах.
 */

/* ---------------------------------------------------------------- */
/* Регистрация устройства                                            */
/* ---------------------------------------------------------------- */

export const RegisterDeviceRequest = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  deviceName: z.string().max(120).optional(),
  locale: z.string().default('ru-RU'),
  timezone: z.string().default('Europe/Moscow'),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequest>;

export const RegisterDeviceResponse = z.object({
  token: z.string(),
  userId: z.string().uuid(),
  deviceId: z.string().uuid(),
});
export type RegisterDeviceResponse = z.infer<typeof RegisterDeviceResponse>;

/* ---------------------------------------------------------------- */
/* Ход разговора                                                     */
/* ---------------------------------------------------------------- */

export const TurnRequest = z.object({
  /** Текст или распознанная речь. */
  text: z.string().min(1).max(4000),
  source: z.enum(['text', 'voice']).default('text'),
  /** Продолжение существующей задачи, если это ответ на вопрос агента. */
  jobId: z.string().uuid().optional(),
});
export type TurnRequest = z.infer<typeof TurnRequest>;

/**
 * События SSE. Клиент обязан игнорировать неизвестные типы событий,
 * а не падать: сервер выкатывается чаще, чем приложение проходит ревью.
 */
export const TurnEvent = z.discriminatedUnion('type', [
  /** Видимый прогресс: без него ожидание в 8 секунд ощущается как зависание. */
  z.object({ type: z.literal('status'), phase: z.string(), text: z.string() }),
  z.object({ type: z.literal('job'), job: Job }),
  z.object({ type: z.literal('spec'), spec: UISpec }),
  /** Данные для dataSources мини-аппы, приходят отдельно от структуры. */
  z.object({ type: z.literal('data'), key: z.string(), value: z.unknown() }),
  z.object({ type: z.literal('message'), text: z.string() }),
  z.object({ type: z.literal('error'), code: z.string(), text: z.string() }),
  z.object({ type: z.literal('done'), jobId: z.string().uuid().nullable() }),
]);
export type TurnEvent = z.infer<typeof TurnEvent>;

/* ---------------------------------------------------------------- */
/* Действия из интерфейса                                            */
/* ---------------------------------------------------------------- */

/**
 * Клиент не знает, что делает кнопка: он присылает намерение.
 * Разрешение проверяется на сервере по манифесту инструмента, а не по тому,
 * что прислал клиент — иначе подменённый запрос обошёл бы все ограничения.
 */
export const ActionRequest = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  jobId: z.string().uuid().optional(),
  specId: z.string().optional(),
  /** Подтверждение пользователя для инструментов класса `confirm`. */
  confirmed: z.boolean().default(false),
});
export type ActionRequest = z.infer<typeof ActionRequest>;

export const ActionResponse = z.object({
  ok: z.boolean(),
  /** Требуется подтверждение — клиент показывает лист подтверждения. */
  needsConfirmation: z.boolean().default(false),
  confirmationText: z.string().optional(),
  /** Точечное обновление данных экрана вместо перезагрузки всей мини-аппы. */
  dataPatch: z.record(z.string(), z.unknown()).optional(),
  message: z.string().optional(),
  auditId: z.string().uuid().optional(),
});
export type ActionResponse = z.infer<typeof ActionResponse>;

/* ---------------------------------------------------------------- */
/* Мини-аппы                                                         */
/* ---------------------------------------------------------------- */

export const MiniAppResponse = z.object({
  spec: UISpec,
  data: z.record(z.string(), z.unknown()).default({}),
});
export type MiniAppResponse = z.infer<typeof MiniAppResponse>;

export const ApiError = z.object({
  error: z.string(),
  code: z.string(),
  requestId: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
