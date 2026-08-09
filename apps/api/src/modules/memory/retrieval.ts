import { RETRIEVAL_WEIGHTS, type EntityType } from '@agentic-os/contracts';
import { query } from '../../db/client';
import { vectorSearchAvailable } from '../../db/migrate';

/**
 * Гибридный retrieval.
 *
 * Четыре сигнала, а не только вектор: «RAG по всему подряд» даёт ассистента,
 * который помнит случайное вместо нужного. Структура и свежесть здесь важнее
 * семантики — жизненные факты запрашиваются по типу и времени куда чаще,
 * чем по смыслу.
 *
 * Семантический слот пока закрыт лексическим совпадением: пайплайн
 * эмбеддингов появится в S2, и заменится ровно одна функция. Если pgvector
 * недоступен, поведение то же самое — деградация, а не отказ.
 */

export interface ScoredFact {
  factId: string;
  entityId: string;
  label: string;
  entityType: EntityType;
  predicate: string;
  value: unknown;
  confidence: number;
  source: string;
  observedAt: string;
  score: number;
}

export interface RetrieveInput {
  userId: string;
  /** Текст запроса — из него берутся слова для лексического совпадения. */
  intent: string;
  entityTypes?: readonly EntityType[];
  predicates?: readonly string[];
  limit?: number;
  minConfidence?: number;
}

/** Период полураспада свежести: месяц. Дальше вес затухает плавно. */
const RECENCY_HALF_LIFE_MS = 30 * 24 * 3600 * 1000;

/** Приоритет источника — он же грубая оценка важности факта. */
const SOURCE_IMPORTANCE: Record<string, number> = {
  user_said: 1,
  user_confirmed: 1,
  calendar: 0.7,
  contacts: 0.65,
  email: 0.6,
  procedure: 0.55,
  inferred: 0.25,
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
}

/** Доля слов запроса, встретившихся в факте. Заменится на векторную близость. */
function lexicalScore(tokens: readonly string[], haystack: string): number {
  if (tokens.length === 0) return 0;
  const lower = haystack.toLowerCase();
  const hits = tokens.filter((t) => lower.includes(t)).length;
  return hits / tokens.length;
}

interface Row {
  fact_id: string;
  entity_id: string;
  label: string;
  entity_type: EntityType;
  predicate: string;
  object_value: unknown;
  confidence: number;
  source: string;
  observed_at: Date;
}

export async function retrieve(input: RetrieveInput): Promise<ScoredFact[]> {
  const limit = input.limit ?? 30;
  const minConfidence = input.minConfidence ?? 0.3;

  // Структурная часть выполняется базой: она отсекает основной объём
  // до того, как что-либо считается в приложении.
  const rows = await query<Row>(
    `SELECT f.id AS fact_id, e.id AS entity_id, e.label, e.type AS entity_type,
            f.predicate, f.object_value, f.confidence, f.source, f.observed_at
       FROM fact f
       JOIN entity e ON e.id = f.subject_id
      WHERE f.user_id = $1
        AND f.valid_to IS NULL
        AND e.archived_at IS NULL
        AND f.confidence >= $2
        AND ($3::text[] IS NULL OR e.type = ANY($3))
        AND ($4::text[] IS NULL OR f.predicate = ANY($4))
      ORDER BY f.observed_at DESC
      LIMIT $5`,
    [
      input.userId,
      minConfidence,
      input.entityTypes && input.entityTypes.length > 0 ? [...input.entityTypes] : null,
      input.predicates && input.predicates.length > 0 ? [...input.predicates] : null,
      limit * 4,
    ]
  );

  const tokens = tokenize(input.intent);
  const now = Date.now();

  const scored = rows.map((r) => {
    const haystack = `${r.label} ${r.predicate} ${typeof r.object_value === 'string' ? r.object_value : ''}`;

    const structural =
      (input.entityTypes?.includes(r.entity_type) ? 0.5 : 0) +
      (input.predicates?.includes(r.predicate) ? 0.5 : 0) ||
      (tokens.length === 0 ? 0.5 : 0);

    const semantic = lexicalScore(tokens, haystack);
    const ageMs = now - r.observed_at.getTime();
    const recency = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
    const importance = (SOURCE_IMPORTANCE[r.source] ?? 0.4) * r.confidence;

    const score =
      RETRIEVAL_WEIGHTS.structural * structural +
      RETRIEVAL_WEIGHTS.semantic * semantic +
      RETRIEVAL_WEIGHTS.recency * recency +
      RETRIEVAL_WEIGHTS.importance * importance;

    return {
      factId: r.fact_id,
      entityId: r.entity_id,
      label: r.label,
      entityType: r.entity_type,
      predicate: r.predicate,
      value: r.object_value,
      confidence: r.confidence,
      source: r.source,
      observedAt: r.observed_at.toISOString(),
      score,
    };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Какой режим семантики сейчас активен — для журнала на старте. */
export async function retrievalMode(): Promise<'vector' | 'lexical'> {
  return (await vectorSearchAvailable()) ? 'vector' : 'lexical';
}

/**
 * Достаёт из графа то, чего не хватает в запросе.
 *
 * Это и есть накопительный эффект в самом простом виде: «оформи визу» без
 * страны работает, если пользователь называл страну раньше. На этом же
 * проверяется гипотеза H3 — доля задач без уточняющих вопросов должна
 * расти по мере наполнения графа.
 */
export async function fillMissingParams(
  userId: string,
  goal: string,
  params: Record<string, string>
): Promise<{ params: Record<string, string>; recalled: string[] }> {
  const recalled: string[] = [];
  const next = { ...params };

  if (!next['country']) {
    const candidates = await retrieve({
      userId,
      intent: goal,
      entityTypes: ['place'],
      predicates: ['plans_to_visit'],
      limit: 1,
      minConfidence: 0.5,
    });
    const best = candidates[0];
    if (best) {
      next['country'] = best.label;
      recalled.push(`страна: ${best.label}`);
    }
  }

  return { params: next, recalled };
}
