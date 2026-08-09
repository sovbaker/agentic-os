import { config } from '../config';

/**
 * Структурный лог с редактированием персональных данных НА ВХОДЕ.
 *
 * Redaction на выходе (в агрегаторе) — это уже поздно: данные успели
 * записаться на диск. В приложении про личную жизнь это неприемлемо.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const SENSITIVE_KEYS = /^(token|password|secret|authorization|apiKey|pushToken|email|phone)$/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const PHONE_RE = /\+?\d[\d\s()-]{9,}\d/g;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') {
    return value.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: redact(msg),
    ...(fields ? { ...(redact(fields) as Record<string, unknown>) } : {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

/**
 * Заготовка под трассировку. В S0 — просто замер и лог; точка подключения
 * OpenTelemetry и Langfuse одна, менять вызовы по коду потом не придётся.
 */
export async function traced<T>(
  name: string,
  fn: () => Promise<T>,
  attrs?: Record<string, unknown>
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    log.debug(`span ${name}`, { ...attrs, ms: Math.round(performance.now() - started) });
    return result;
  } catch (err) {
    log.error(`span ${name} failed`, {
      ...attrs,
      ms: Math.round(performance.now() - started),
      error: (err as Error).message,
    });
    throw err;
  }
}
