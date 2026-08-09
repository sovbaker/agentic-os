import type { Condition, DataRef, UIAction, UINode } from '@agentic-os/contracts';

/**
 * Разрешение привязок данных. Чистые функции без React — чтобы это можно было
 * протестировать без рендера и переиспользовать в вебе.
 */

export interface RenderScope {
  data: Record<string, unknown>;
  state: Record<string, unknown>;
  job: Record<string, unknown>;
  graph: Record<string, unknown>;
  /** Переменные из repeat: `{ item: {...} }`. */
  locals: Record<string, unknown>;
}

export function emptyScope(partial: Partial<RenderScope> = {}): RenderScope {
  return {
    data: partial.data ?? {},
    state: partial.state ?? {},
    job: partial.job ?? {},
    graph: partial.graph ?? {},
    locals: partial.locals ?? {},
  };
}

/** `a.b.0.c` по вложенным объектам и массивам. */
export function getPath(root: unknown, path: string): unknown {
  if (path === '') return root;
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(segment);
      current = Number.isInteger(idx) ? current[idx] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function resolveRef(ref: DataRef, scope: RenderScope): unknown {
  const [head, ...rest] = ref.path.split('.');

  // Переменные repeat живут в том же пространстве имён, что и data,
  // и имеют приоритет: внутри цикла `item` важнее одноимённого поля данных.
  if (ref.source === 'data' && head !== undefined && head in scope.locals) {
    const value = getPath(scope.locals[head], rest.join('.'));
    return value === undefined ? ref.fallback : value;
  }

  const root =
    ref.source === 'data' ? scope.data
    : ref.source === 'state' ? scope.state
    : ref.source === 'job' ? scope.job
    : scope.graph;

  const value = getPath(root, ref.path);
  return value === undefined ? ref.fallback : value;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

export function evalCondition(cond: Condition, scope: RenderScope): boolean {
  const left = resolveRef(cond.ref, scope);
  const right = cond.value;

  switch (cond.op) {
    case 'exists': return left !== undefined && left !== null;
    case 'empty': return isEmpty(left);
    case 'eq': return left === right;
    case 'neq': return left !== right;
    case 'in': return Array.isArray(right) && right.includes(left as never);
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      const a = Number(left);
      const b = Number(right);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return cond.op === 'gt' ? a > b : cond.op === 'lt' ? a < b : cond.op === 'gte' ? a >= b : a <= b;
    }
    default: return true;
  }
}

/** Статические props плюс разрешённые bind. Bind перекрывает статику. */
export function resolveProps(node: UINode, scope: RenderScope): Record<string, unknown> {
  const props: Record<string, unknown> = { ...(node.props ?? {}) };
  for (const [key, ref] of Object.entries(node.bind ?? {})) {
    props[key] = resolveRef(ref, scope);
  }
  return props;
}

/** Значение аргумента экшена может быть DataRef — тогда его нужно разрешить. */
function isDataRef(value: unknown): value is DataRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'source' in value &&
    'path' in value &&
    typeof (value as DataRef).path === 'string'
  );
}

export function resolveActionArgs(
  args: Record<string, unknown>,
  scope: RenderScope
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = isDataRef(value) ? resolveRef(value, scope) : value;
  }
  return out;
}

export function resolveAction(action: UIAction, scope: RenderScope): UIAction {
  if (action.kind === 'tool') {
    return { ...action, args: resolveActionArgs(action.args, scope) };
  }
  return action;
}

export interface RepeatInstance {
  scope: RenderScope;
  key: string;
}

/**
 * Разворачивает `repeat` в набор областей видимости — по одной на элемент.
 * Узел без repeat даёт ровно один экземпляр с исходной областью.
 */
export function expandRepeat(node: UINode, scope: RenderScope): RepeatInstance[] {
  if (!node.repeat) return [{ scope, key: '0' }];

  const collection = resolveRef(node.repeat.ref, scope);
  if (!Array.isArray(collection)) return [];

  return collection.map((item, index) => ({
    key: keyOf(item, index),
    scope: { ...scope, locals: { ...scope.locals, [node.repeat!.as]: item } },
  }));
}

function keyOf(item: unknown, index: number): string {
  if (item && typeof item === 'object' && 'id' in item) {
    const id = (item as { id: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return String(index);
}

export function isVisible(node: UINode, scope: RenderScope): boolean {
  return node.visibleIf ? evalCondition(node.visibleIf, scope) : true;
}
