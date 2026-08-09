import { query } from '../../db/client';
import { log } from '../../obs/log';
import type { ExtractedFact, LlmPort } from './llm';

/**
 * Карантин недоверенного контента.
 *
 * Продукт по конструкции совмещает приватные данные, недоверенный контент
 * и возможность внешней коммуникации — ту самую конфигурацию, которую
 * эксплуатируют. У модели нет надёжного способа отличить инструкцию от
 * данных: и то и другое приходит одним потоком токенов.
 *
 * Поэтому защита архитектурная, а не «попросим модель не поддаваться»:
 *
 *   ИНВАРИАНТ: текст из недоверенного источника НИКОГДА не попадает
 *   в контекст, у которого есть инструменты.
 *
 * Он проходит здесь, превращается в структуру и дальше живёт только как
 * данные: рендерится пользователю и оседает в графе. Обратного пути в
 * промпт планировщика или исполнителя у него нет.
 */

export interface Finding {
  title: string;
  url?: string;
  keyPoints: string[];
}

export interface QuarantineResult {
  findings: Finding[];
  facts: ExtractedFact[];
  injectionSuspected: boolean;
  /** Строки, отброшенные как попытка внедрения инструкций. */
  dropped: string[];
}

/**
 * Признаки внедрения инструкций. Список заведомо неполон — он не единственная
 * и не главная защита, а сигнал для журнала и для пользователя. Настоящая
 * защита в том, что этот текст в принципе не доходит до контекста с
 * инструментами.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior)/i,
  /you\s+are\s+now\s+(a|an|the)?/i,
  /system\s*prompt/i,
  /(^|\n)\s*#{0,3}\s*(instruction|system)\s*:/i,
  /(?<![а-яёa-z])(забудь|игнорируй)\s+(все\s+)?(предыдущие|прошлые|прежние)/i,
  /(?<![а-яёa-z])(ассистент|агент|бот)\s*,\s*(отправь|перешли|удали|выполни|сделай)/i,
  /(?<![а-яёa-z])выполни\s+(команду|инструкцию|следующее)/i,
  /(?<![а-яёa-z])(перешли|отправь)\s+.{0,40}(на\s+(адрес|почт|email)|содержимое)/i,
];

/** Похоже ли на попытку скомандовать ассистенту. */
export function detectInjection(text: string): { suspected: boolean; matched: string[] } {
  const matched = INJECTION_PATTERNS.filter((p) => p.test(text)).map((p) => p.source.slice(0, 40));
  return { suspected: matched.length > 0, matched };
}

const MAX_POINTS = 6;
const MAX_POINT_LENGTH = 220;

function toKeyPoints(text: string): { points: string[]; dropped: string[] } {
  const points: string[] = [];
  const dropped: string[] = [];

  const lines = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 12);

  for (const line of lines) {
    if (points.length >= MAX_POINTS) break;
    if (detectInjection(line).suspected) {
      dropped.push(line.slice(0, MAX_POINT_LENGTH));
      continue;
    }
    points.push(line.slice(0, MAX_POINT_LENGTH));
  }
  return { points, dropped };
}

export interface QuarantineInput {
  userId: string;
  jobId: string | null;
  tool: string;
  /** Сырой недоверенный текст. Наружу из этой функции он не выходит. */
  raw: string;
  sources?: Array<{ title: string; url?: string; snippet: string }>;
  llm: LlmPort;
}

export async function quarantine(input: QuarantineInput): Promise<QuarantineResult> {
  const detection = detectInjection(input.raw);

  const findings: Finding[] = [];
  const dropped: string[] = [];

  for (const source of input.sources ?? []) {
    const { points, dropped: lost } = toKeyPoints(source.snippet);
    dropped.push(...lost);
    findings.push({
      title: source.title.slice(0, 160),
      ...(source.url ? { url: source.url } : {}),
      keyPoints: points,
    });
  }

  if (findings.length === 0) {
    const { points, dropped: lost } = toKeyPoints(input.raw);
    dropped.push(...lost);
    if (points.length > 0) findings.push({ title: 'Результаты поиска', keyPoints: points });
  }

  /**
   * Извлечение фактов идёт через модель БЕЗ инструментов — единственный
   * вызов, которому позволено видеть этот текст. Даже если модель поддастся
   * инструкции внутри, максимум, что она может — вернуть мусорный факт.
   * Выполнить действие ей нечем.
   */
  let facts: ExtractedFact[] = [];
  try {
    facts = await input.llm.extractFacts(input.raw.slice(0, 4000));
  } catch (err) {
    log.warn('quarantine extraction failed', { error: (err as Error).message });
  }

  if (detection.suspected) {
    log.warn('обнаружена попытка внедрения инструкций', {
      tool: input.tool,
      jobId: input.jobId,
      patterns: detection.matched,
    });
  }

  await query(
    `INSERT INTO quarantined_content (user_id, job_id, tool, raw, extracted, injection_suspected)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.userId,
      input.jobId,
      input.tool,
      input.raw.slice(0, 20_000),
      JSON.stringify({ findings, facts }),
      detection.suspected,
    ]
  );

  return { findings, facts, injectionSuspected: detection.suspected, dropped };
}
