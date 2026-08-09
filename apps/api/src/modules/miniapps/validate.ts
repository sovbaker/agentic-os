import { COMPLEXITY_BUDGET, UISpec, ValidationResult, type UINode } from '@agentic-os/contracts';

/**
 * Валидатор мини-аппы. Пропускает наружу только то, что клиент точно отрендерит.
 *
 * Проверяет три вещи, а не одну:
 *  1. соответствие схеме,
 *  2. бюджет сложности — иначе однажды приедет таблица на 5000 строк,
 *  3. связность: экшены ссылаются на существующие инструменты,
 *     а `repeat` — на объявленный источник данных.
 */

export interface ValidateOptions {
  knownTools: ReadonlySet<string>;
}

interface Stats {
  nodes: number;
  depth: number;
  bindings: number;
  actions: number;
}

function walk(
  node: UINode,
  depth: number,
  stats: Stats,
  errors: ValidationResult['errors'],
  opts: ValidateOptions,
  dataKeys: ReadonlySet<string>,
  path: string
): void {
  stats.nodes += 1;
  stats.depth = Math.max(stats.depth, depth);
  stats.bindings += Object.keys(node.bind ?? {}).length;
  stats.actions += Object.keys(node.actions ?? {}).length;

  for (const [name, action] of Object.entries(node.actions ?? {})) {
    if (action.kind === 'tool' || action.kind === 'submit') {
      if (!opts.knownTools.has(action.tool)) {
        errors.push({
          path: `${path}.actions.${name}`,
          message: `неизвестный инструмент "${action.tool}"`,
          hint: `используй один из: ${[...opts.knownTools].join(', ')}`,
        });
      }
    }
    if (action.kind === 'tool' && !action.confirm && /send|delete|pay|book/i.test(action.tool)) {
      errors.push({
        path: `${path}.actions.${name}`,
        message: `действие "${action.tool}" выглядит необратимым и требует поля confirm`,
        hint: 'добавь confirm с текстом подтверждения',
      });
    }
  }

  // repeat по источнику, которого нет, — самая частая ошибка генерации:
  // экран рендерится пустым, и это выглядит как баг рендерера.
  if (node.repeat) {
    const root = node.repeat.ref.path.split('.')[0];
    if (node.repeat.ref.source === 'data' && root && !dataKeys.has(root)) {
      errors.push({
        path: `${path}.repeat`,
        message: `repeat ссылается на "${root}", которого нет в dataSources`,
        hint: `доступные ключи: ${[...dataKeys].join(', ') || '(нет)'}`,
      });
    }
  }

  node.children?.forEach((child, i) =>
    walk(child, depth + 1, stats, errors, opts, dataKeys, `${path}.children[${i}]`)
  );
}

export function validateSpec(input: unknown, opts: ValidateOptions): ValidationResult {
  const parsed = UISpec.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        hint: 'сверься со схемой UISpec: допустимы только компоненты из реестра',
      })),
      budgetExceeded: [],
    };
  }

  const spec = parsed.data;
  const errors: ValidationResult['errors'] = [];
  const stats: Stats = { nodes: 0, depth: 0, bindings: 0, actions: 0 };
  const dataKeys = new Set(spec.dataSources.map((d) => d.key));

  walk(spec.root, 1, stats, errors, opts, dataKeys, 'root');

  const budgetExceeded: string[] = [];
  if (stats.nodes > COMPLEXITY_BUDGET.maxNodes) budgetExceeded.push(`nodes=${stats.nodes}`);
  if (stats.depth > COMPLEXITY_BUDGET.maxDepth) budgetExceeded.push(`depth=${stats.depth}`);
  if (stats.bindings > COMPLEXITY_BUDGET.maxBindingsPerScreen) budgetExceeded.push(`bindings=${stats.bindings}`);
  if (stats.actions > COMPLEXITY_BUDGET.maxActionsPerScreen) budgetExceeded.push(`actions=${stats.actions}`);

  return { ok: errors.length === 0 && budgetExceeded.length === 0, errors, budgetExceeded };
}

/**
 * Repair loop: невалидную генерацию возвращаем модели с описанием ошибок.
 * Максимум две попытки — дальше статический fallback. Пользователь никогда
 * не видит сломанный экран, это жёсткое правило.
 */
export async function generateWithRepair(
  generate: (feedback: string | null) => Promise<unknown>,
  opts: ValidateOptions,
  maxAttempts = 2
): Promise<{ spec: UISpec | null; attempts: number; lastErrors: ValidationResult['errors'] }> {
  let feedback: string | null = null;
  let lastErrors: ValidationResult['errors'] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = await generate(feedback);
    const result = validateSpec(candidate, opts);
    if (result.ok) {
      return { spec: UISpec.parse(candidate), attempts: attempt, lastErrors: [] };
    }
    lastErrors = result.errors;
    feedback = [
      'Предыдущий вариант не прошёл валидацию. Исправь ровно эти ошибки:',
      ...result.errors.map((e) => `- ${e.path}: ${e.message}${e.hint ? ` (${e.hint})` : ''}`),
      ...result.budgetExceeded.map((b) => `- превышен бюджет сложности: ${b}`),
    ].join('\n');
  }

  return { spec: null, attempts: maxAttempts, lastErrors };
}
