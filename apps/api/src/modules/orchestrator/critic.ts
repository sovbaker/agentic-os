import type { ToolResult } from '../tools/index';

/**
 * Критик: проверяет постусловия шага и решает, что делать дальше.
 *
 * Без него агент уверенно рапортует об успехе там, где ничего не сделал:
 * инструмент вернул ok, но результат пуст, а задача считается закрытой.
 * Именно так ассистенты набирают «выполнено» при нулевой пользе.
 *
 * Условия — маленький явный язык, а не выражения на исполнение. Строку из
 * плана, пришедшего от модели, нельзя отдавать интерпретатору: это прямой
 * путь к исполнению того, что модель напишет под влиянием чужого текста.
 */

export type Verdict =
  | { kind: 'accept' }
  | { kind: 'retry'; reason: string }
  | { kind: 'escalate'; reason: string };

const CONDITIONS: Record<string, (r: ToolResult) => boolean> = {
  'result.ok': (r) => r.ok === true,
  spec_valid: (r) => r.spec !== undefined,
  has_data: (r) => r.dataPatch !== undefined && Object.keys(r.dataPatch).length > 0,
  has_facts: (r) => (r.facts?.length ?? 0) > 0,
};

/** `has:<key>` и `min_items:<n>` — параметрические условия. */
function evaluate(condition: string, result: ToolResult): boolean | null {
  const fixed = CONDITIONS[condition];
  if (fixed) return fixed(result);

  const has = /^has:(.+)$/.exec(condition);
  if (has?.[1]) {
    const value = result.dataPatch?.[has[1]];
    return value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0);
  }

  const min = /^min_items:(\d+)$/.exec(condition);
  if (min?.[1]) {
    const items = result.dataPatch?.['items'];
    return Array.isArray(items) && items.length >= Number(min[1]);
  }

  // Неизвестное условие — не повод завалить шаг, но повод узнать о нём.
  return null;
}

export interface CriticInput {
  result: ToolResult;
  postconditions: readonly string[];
  attempts: number;
  maxAttempts: number;
  /** Провал этого шага не должен ронять задачу целиком. */
  optional?: boolean;
}

export function judge(input: CriticInput): { verdict: Verdict; unknownConditions: string[] } {
  const unknown: string[] = [];
  const failed: string[] = [];

  if (!input.result.ok) failed.push('инструмент вернул ошибку');

  for (const condition of input.postconditions) {
    const outcome = evaluate(condition, input.result);
    if (outcome === null) unknown.push(condition);
    else if (!outcome) failed.push(condition);
  }

  if (failed.length === 0) return { verdict: { kind: 'accept' }, unknownConditions: unknown };

  const reason = `${input.result.message ?? 'не выполнены условия'}: ${failed.join(', ')}`;

  if (input.attempts < input.maxAttempts) {
    return { verdict: { kind: 'retry', reason }, unknownConditions: unknown };
  }
  return { verdict: { kind: 'escalate', reason }, unknownConditions: unknown };
}
