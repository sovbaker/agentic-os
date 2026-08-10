import { createHash } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { log } from '../obs/log';

/**
 * Ограничение частоты запросов.
 *
 * Считаем в памяти процесса. Это честно ровно до тех пор, пока процесс
 * один — а он один: воркер живёт в том же процессе, что и API (см.
 * `src/index.ts`). Когда инстансов станет несколько, счётчик переезжает
 * в Redis или в таблицу, и меняется только реализация `Window`,
 * а не места вызова.
 *
 * Лимит здесь не про «злоумышленника с ботнетом» — от такого защищает
 * слой выше. Он про три конкретных сценария, каждый из которых
 * реалистичен уже на бете:
 *
 *  - цикл в клиенте, который шлёт ход за ходом и жжёт токены;
 *  - утёкший токен устройства, которым кто-то пользуется;
 *  - скрипт, который регистрирует устройства пачками и засоряет базу.
 */

export interface Budget {
  /** Сколько запросов разрешено в окне. */
  limit: number;
  /** Длина окна, мс. */
  windowMs: number;
}

interface Counter {
  count: number;
  resetAt: number;
}

export class Window {
  private readonly hits = new Map<string, Counter>();

  constructor(private readonly budget: Budget) {}

  /**
   * Отметить запрос. Возвращает, сколько секунд ждать, если лимит выбран,
   * и `null`, если запрос разрешён.
   */
  hit(key: string, now = Date.now()): number | null {
    const existing = this.hits.get(key);

    if (!existing || existing.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.budget.windowMs });
      return null;
    }

    existing.count += 1;
    if (existing.count > this.budget.limit) {
      return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    }
    return null;
  }

  /**
   * Выбросить истёкшие окна. Без этого карта растёт по числу когда-либо
   * виденных ключей — то есть по числу IP, а не по числу пользователей.
   */
  sweep(now = Date.now()): void {
    for (const [key, counter] of this.hits) {
      if (counter.resetAt <= now) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/**
 * Бюджеты по классам ручек. Разные не для красоты: цена запроса разная.
 *
 * `turn` — единственная ручка, которая тратит деньги на модель, поэтому
 * её потолок самый низкий и считается по пятиминутному окну: человек
 * физически не пишет двадцать задач за пять минут, а цикл в клиенте —
 * пишет.
 *
 * `register` защищает не деньги, а базу: пустой аккаунт не стоит ничего,
 * пока с него не пришёл ход, а ход ограничен отдельно. Поэтому потолок
 * здесь щедрый — двадцатка не мешает прогонять `verify:ui` подряд с одной
 * машины и при этом не даёт набивать таблицу тысячами строк.
 */
export const BUDGETS = {
  turn: { limit: 20, windowMs: 5 * 60_000 },
  register: { limit: 20, windowMs: 60 * 60_000 },
  write: { limit: 60, windowMs: 60_000 },
  read: { limit: 240, windowMs: 60_000 },
} satisfies Record<string, Budget>;

export type BudgetName = keyof typeof BUDGETS;

/**
 * Кто именно стучится.
 *
 * Токен важнее адреса: за одним NAT сидит целый дом, и лимитировать их
 * общим счётчиком — значит наказывать соседей. Токен в ключе не хранится,
 * только его хэш: логи и дампы памяти не должны содержать ключей доступа.
 */
export function identify(c: Context): string {
  const header = c.req.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return `t:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  }

  const forwarded = c.req.header('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return `ip:${first}`;

  return `ip:${getConnInfo(c).remote.address ?? 'unknown'}`;
}

const windows = new Map<BudgetName, Window>();
for (const [name, budget] of Object.entries(BUDGETS)) {
  windows.set(name as BudgetName, new Window(budget));
}

/**
 * Уборка. Раз в минуту, `unref` — таймер не должен держать процесс живым
 * при завершении: иначе SIGTERM в контейнере ждал бы его до таймаута.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const w of windows.values()) w.sweep(now);
}, 60_000);
sweeper.unref();

/**
 * Сколько ждать, человеческим языком.
 *
 * Отдельная функция, потому что окна разной длины: у регистрации это час,
 * у хода — минуты. Универсальное «попробуй через минуту» в ответе, где
 * `Retry-After: 3600`, — это просто неправда, сказанная пользователю.
 */
export function waitPhrase(seconds: number): string {
  if (seconds <= 90) return `через ${seconds} с`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `через ${minutes} мин`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? 'через час' : `через ${hours} ч`;
}

export function rateLimit(name: BudgetName): (c: Context, next: Next) => Promise<Response | void> {
  return async (c, next) => {
    const window = windows.get(name);
    const key = identify(c);
    const retryAfter = window?.hit(`${name}:${key}`) ?? null;

    if (retryAfter !== null) {
      // Ключ уже хэширован, писать в лог можно.
      log.warn('лимит частоты', { bucket: name, key, path: c.req.path });
      c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          error: `Слишком много запросов подряд. Попробуй ${waitPhrase(retryAfter)}.`,
          code: 'rate_limited',
          retryAfter,
        },
        429
      );
    }

    await next();
  };
}

/**
 * Потолки на размер тела.
 *
 * `.ics` — единственный законно большой вход: годовой календарь
 * выгружается сотнями килобайт. Остальное — текст, который написал
 * человек, и мегабайтное «сообщение» означает не пользователя,
 * а попытку занять память парсером.
 */
export const BODY_LIMITS = {
  /** Обычный JSON: ход, действие, реакция. */
  json: 64 * 1024,
  /** Письмо с цитатой переписки и заголовками. */
  email: 1024 * 1024,
  /** Выгрузка календаря. */
  ics: 4 * 1024 * 1024,
} as const;

const tooLarge = (c: Context): Response =>
  c.json({ error: 'Слишком большой запрос', code: 'payload_too_large' }, 413);

/**
 * Один ограничитель на все ручки, который сам выбирает потолок по пути.
 *
 * Двумя `app.use` это не собирается: общий обработчик отработал бы первым
 * и зарубил бы законную выгрузку календаря раньше, чем до неё дошёл
 * её собственный, больший потолок.
 */
export function bodyGuard(): (c: Context, next: Next) => Promise<Response | void> {
  const byPath = new Map<string, ReturnType<typeof bodyLimit>>([
    ['/v1/import/ics', bodyLimit({ maxSize: BODY_LIMITS.ics, onError: tooLarge })],
    ['/v1/inbound/email', bodyLimit({ maxSize: BODY_LIMITS.email, onError: tooLarge })],
  ]);
  const fallback = bodyLimit({ maxSize: BODY_LIMITS.json, onError: tooLarge });

  return async (c, next) => (byPath.get(c.req.path) ?? fallback)(c, next);
}
