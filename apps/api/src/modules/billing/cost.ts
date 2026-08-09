import { config } from '../../config';
import { query, queryOne } from '../../db/client';
import { log } from '../../obs/log';

/**
 * Учёт расхода на модели.
 *
 * «Стоимость закрытой задачи ≤ 25 ₽» из спеки — это метрика только если её
 * кто-то считает. Пока расход не пишется в базу с разбивкой по токенам,
 * это пожелание, а обнаруживается расхождение на счёте за месяц.
 *
 * Считаем в долларах (прайс задан так) и храним в рублях (бюджеты продукта
 * заданы так). Оба числа нужны: доллары — чтобы сверяться с консолью,
 * рубли — чтобы сверяться с ценой подписки.
 */

/** Цена за миллион токенов, в долларах. */
interface Price {
  input: number;
  output: number;
  /** Вводная цена действует до указанной даты, потом сама перестаёт применяться. */
  introInput?: number;
  introOutput?: number;
  introUntil?: string;
}

/**
 * Прайс-лист. Сопоставление по префиксу: `claude-haiku-4-5-20251001`
 * и `claude-haiku-4-5` — одна и та же цена, и код не должен об этом знать.
 * Порядок важен — берём самое длинное совпадение.
 */
const PRICING: ReadonlyArray<readonly [prefix: string, price: Price]> = [
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4', { input: 5, output: 25 }],
  // Вводная цена Sonnet 5 действует до 31 августа 2026 включительно.
  ['claude-sonnet-5', { input: 3, output: 15, introInput: 2, introOutput: 10, introUntil: '2026-09-01' }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
  ['claude-haiku-4', { input: 1, output: 5 }],
];

/**
 * Множители кэша относительно цены входа.
 *
 * Чтение вдесятеро дешевле входа, запись — дороже. Это и есть причина
 * считать их отдельными счётчиками: если сложить всё в `input_tokens`,
 * эффект кэша станет невидимым ровно тогда, когда он появится.
 */
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;

/** То, что возвращает SDK в `usage`. Все поля необязательны — их набор растёт. */
export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

export type LlmRole = 'router' | 'planner' | 'executor' | 'extractor' | 'composer';

function priceOf(model: string): Price | null {
  let best: Price | null = null;
  let bestLen = -1;
  for (const [prefix, price] of PRICING) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Цена на конкретный момент: вводные тарифы истекают сами, без правки кода. */
function effectivePrice(price: Price, at: Date): { input: number; output: number } {
  if (price.introUntil && price.introInput !== undefined && price.introOutput !== undefined) {
    if (at < new Date(price.introUntil)) {
      return { input: price.introInput, output: price.introOutput };
    }
  }
  return { input: price.input, output: price.output };
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Разбор записи кэша. Новый SDK отдаёт разбивку по TTL, старый — одно число.
 * Без разбивки считаем по 5-минутному тарифу: занижать счёт хуже, чем
 * завышать, поэтому берём меньший множитель только когда он точно известен.
 */
function cacheWrite(usage: Usage): { tokens: number; usdPerMTokFactor: number } {
  const m5 = n(usage.cache_creation?.ephemeral_5m_input_tokens);
  const m1h = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  if (m5 + m1h > 0) {
    const tokens = m5 + m1h;
    const weighted = (m5 * CACHE_WRITE_5M + m1h * CACHE_WRITE_1H) / tokens;
    return { tokens, usdPerMTokFactor: weighted };
  }
  return { tokens: n(usage.cache_creation_input_tokens), usdPerMTokFactor: CACHE_WRITE_5M };
}

export interface CostBreakdown {
  usd: number;
  rub: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Неизвестная модель — считаем в ноль, но это должно быть видно, а не молча. */
  unknownModel: boolean;
}

export function computeCost(model: string, usage: Usage, at: Date = new Date()): CostBreakdown {
  const inputTokens = n(usage.input_tokens);
  const outputTokens = n(usage.output_tokens);
  const cacheReadTokens = n(usage.cache_read_input_tokens);
  const write = cacheWrite(usage);

  const found = priceOf(model);
  if (!found) {
    return {
      usd: 0, rub: 0,
      inputTokens, outputTokens,
      cacheReadTokens, cacheWriteTokens: write.tokens,
      unknownModel: true,
    };
  }

  const price = effectivePrice(found, at);
  const usd =
    (inputTokens * price.input +
      outputTokens * price.output +
      cacheReadTokens * price.input * CACHE_READ +
      write.tokens * price.input * write.usdPerMTokFactor) /
    1_000_000;

  return {
    usd,
    rub: usd * config.usdRub,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: write.tokens,
    unknownModel: false,
  };
}

export interface CallRecord {
  userId: string | null;
  jobId?: string | null;
  role: LlmRole;
  model: string;
  usage: Usage;
  latencyMs?: number;
}

/**
 * Запись вызова. Никогда не бросает: учёт не имеет права ломать ответ
 * пользователю. Потерянная строка расхода — неприятность, упавший запрос
 * из-за учёта — дефект.
 */
export async function recordCall(rec: CallRecord): Promise<CostBreakdown> {
  const cost = computeCost(rec.model, rec.usage);
  if (cost.unknownModel) {
    log.warn('нет цены для модели — расход не учтён', { model: rec.model });
  }
  try {
    await query(
      `INSERT INTO llm_call
         (user_id, job_id, role, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_rub, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        rec.userId, rec.jobId ?? null, rec.role, rec.model,
        cost.inputTokens, cost.outputTokens,
        cost.cacheReadTokens, cost.cacheWriteTokens,
        cost.rub.toFixed(4), rec.latencyMs ?? null,
      ]
    );
  } catch (err) {
    log.warn('не удалось записать расход', { error: (err as Error).message });
  }
  return cost;
}

/** Расход пользователя с начала текущего календарного месяца, в рублях. */
export async function monthSpendRub(userId: string): Promise<number> {
  const row = await queryOne<{ sum: string | null }>(
    `SELECT COALESCE(SUM(cost_rub), 0)::text AS sum
       FROM llm_call
      WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
    [userId]
  );
  return Number(row?.sum ?? 0);
}

/** Расход конкретной задачи — то, что сравнивается с бюджетом в 25 ₽. */
export async function jobSpendRub(jobId: string): Promise<number> {
  const row = await queryOne<{ sum: string | null }>(
    `SELECT COALESCE(SUM(cost_rub), 0)::text AS sum FROM llm_call WHERE job_id = $1`,
    [jobId]
  );
  return Number(row?.sum ?? 0);
}
