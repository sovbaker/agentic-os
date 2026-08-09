import { z } from 'zod';

/**
 * Формат golden set.
 *
 * Замысел: с AI-агентом объём кода перестал быть узким местом, а узким стала
 * **проверка правильности**. Эвалы — то, чем заменяется код-ревью: не «код
 * выглядит разумно», а «на 40 реальных фразах решения не поехали».
 *
 * Поэтому набор случаев здесь пустой и должен таким остаться до личного
 * тестирования. Синтетические примеры, придуманные тем же, кто писал
 * правила, проверяют совпадение автора с самим собой.
 */

export const JOB_FAMILY = ['travel', 'documents', 'home', 'health', 'routine', 'other'] as const;

/**
 * Ожидание намеренно частичное: размечать всю структуру плана вручную
 * дорого и хрупко. Пустое поле означает «здесь мне всё равно», а не
 * «здесь должно быть пусто» — разница принципиальная.
 */
export const Expectation = z.object({
  intent: z.enum(['new_task', 'followup', 'chitchat']).optional(),
  family: z.enum(JOB_FAMILY).optional(),
  /** Параметры, которые обязаны быть распознаны: ключ → значение или префикс ISO-даты. */
  params: z.record(z.string(), z.string()).optional(),
  /** Инструменты, которые обязаны попасть в план (порядок не важен). */
  tools: z.array(z.string()).optional(),
  /** Инструменты, которых в плане быть не должно. */
  forbiddenTools: z.array(z.string()).optional(),
  /** Ожидаемый источник мини-аппы — по нему считается гейт G2. */
  origin: z.enum(['catalog', 'parameterized', 'generated']).optional(),
});

export type Expectation = z.infer<typeof Expectation>;

export const EvalCase = z.object({
  id: z.string(),
  /** Что сказал пользователь. Ровно так, как сказал. */
  input: z.string(),
  locale: z.string().default('ru-RU'),
  expect: Expectation,
  /** Зачем этот случай в наборе. Через месяц это единственное, что спасает. */
  note: z.string().optional(),
  /** Заготовка из записи ещё не размечена человеком и в прогон не идёт. */
  reviewed: z.boolean().default(false),
  recordedAt: z.string().optional(),
});

export type EvalCase = z.infer<typeof EvalCase>;

/** Наблюдение: что система на самом деле сделала. */
export interface Observation {
  intent: string;
  family: string;
  params: Record<string, string>;
  tools: string[];
  origin?: string | undefined;
}

export interface CheckResult {
  field: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface CaseResult {
  id: string;
  input: string;
  ok: boolean;
  checks: CheckResult[];
  error?: string;
}

export interface Report {
  total: number;
  passed: number;
  /** Доля пройденных случаев — то, по чему считается гейт G1. */
  rate: number;
  /** Разбивка по полям: важно не «сколько упало», а «что именно ломается». */
  byField: Record<string, { checked: number; failed: number }>;
  failures: CaseResult[];
}
