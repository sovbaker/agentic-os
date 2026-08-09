/**
 * Конфигурация. Всё читается один раз при старте и валидируется:
 * упасть на старте с внятным сообщением лучше, чем на первом запросе пользователя.
 */

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: Number(env('PORT', '8787')),
  nodeEnv: env('NODE_ENV', 'development'),

  databaseUrl: env('DATABASE_URL', 'postgres://postgres@localhost:5432/agentic_os'),

  /**
   * Ключ Anthropic необязателен: без него оркестратор работает на
   * детерминированном адаптере. Это позволяет запускать и тестировать
   * весь контур офлайн — в CI и без расходов на токены.
   */
  anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? null,

  /**
   * Роутинг моделей — первый рычаг экономики. Роль определяет модель, а не
   * наоборот: маршрутизация и извлечение фактов идут на самой дешёвой,
   * планирование — на самой сильной. Алиасы вместо снапшотов, чтобы не
   * тащить дату релиза через весь код.
   */
  models: {
    router: 'claude-haiku-4-5',
    executor: 'claude-sonnet-5',
    planner: 'claude-opus-5',
  },

  /**
   * Курс для перевода счёта в рубли. Отдельная величина, а не константа
   * в коде: бюджеты продукта заданы в рублях, прайс модели — в долларах,
   * и путать эти две системы координат в отчётах нельзя.
   */
  usdRub: Number(env('USD_RUB', '90')),

  /**
   * Запись примеров для golden set. Выключено по умолчанию: писать реальные
   * фразы пользователя на диск можно только по явному включению.
   */
  recordEvals: process.env['RECORD_EVALS'] === '1',
  evalsDir: env('EVALS_DIR', 'packages/evals/cases'),

  /** Рынок РФ первым (решение D1), но нигде не зашито в код — только здесь. */
  defaultLocale: env('DEFAULT_LOCALE', 'ru-RU'),
  defaultTimezone: env('DEFAULT_TIMEZONE', 'Europe/Moscow'),

  logLevel: env('LOG_LEVEL', 'info') as 'debug' | 'info' | 'warn' | 'error',
} as const;

export type Config = typeof config;
