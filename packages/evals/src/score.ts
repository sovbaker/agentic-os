import type { CaseResult, CheckResult, EvalCase, Observation, Report } from './types';

/**
 * Сравнение ожидания с наблюдением.
 *
 * Чистая функция без ввода-вывода: прогон эвалов должен падать из-за
 * поведения системы, а не из-за файлов и сети. Здесь же — единственное
 * место, где решается, что считать совпадением.
 */

/**
 * Даты сравниваем по префиксу: ожидание «2026-10» должно совпасть с
 * «2026-10-01T00:00:00.000Z». Требовать точную строку значит переписывать
 * набор при каждом изменении разбора сроков.
 */
function matchesValue(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  return actual.startsWith(expected);
}

export function check(kase: EvalCase, obs: Observation): CaseResult {
  const checks: CheckResult[] = [];
  const e = kase.expect;

  if (e.intent !== undefined) {
    checks.push({ field: 'intent', ok: obs.intent === e.intent, expected: e.intent, actual: obs.intent });
  }
  if (e.family !== undefined) {
    checks.push({ field: 'family', ok: obs.family === e.family, expected: e.family, actual: obs.family });
  }

  for (const [key, expected] of Object.entries(e.params ?? {})) {
    const actual = obs.params[key] ?? '';
    checks.push({
      field: `params.${key}`,
      ok: matchesValue(expected, actual),
      expected,
      actual: actual || '—',
    });
  }

  for (const tool of e.tools ?? []) {
    checks.push({
      field: `tool:${tool}`,
      ok: obs.tools.includes(tool),
      expected: 'в плане',
      actual: obs.tools.join(', ') || '—',
    });
  }

  // Запрещённый инструмент — не придирка: «поищи в сети» в плане на
  // «напомни завтра» это лишняя секунда, лишние деньги и лишний риск
  // недоверенного контента там, где он не нужен.
  for (const tool of e.forbiddenTools ?? []) {
    checks.push({
      field: `!tool:${tool}`,
      ok: !obs.tools.includes(tool),
      expected: 'нет в плане',
      actual: obs.tools.includes(tool) ? 'есть' : 'нет',
    });
  }

  if (e.origin !== undefined) {
    checks.push({
      field: 'origin',
      ok: obs.origin === e.origin,
      expected: e.origin,
      actual: obs.origin ?? '—',
    });
  }

  return {
    id: kase.id,
    input: kase.input,
    ok: checks.every((c) => c.ok),
    checks,
  };
}

export function report(results: readonly CaseResult[]): Report {
  const byField: Record<string, { checked: number; failed: number }> = {};

  for (const r of results) {
    for (const c of r.checks) {
      // Группируем по виду проверки, а не по конкретному инструменту:
      // «tool:web.search упал» — шум, «инструменты плана» — сигнал.
      const kind = c.field.startsWith('tool:') ? 'tools'
        : c.field.startsWith('!tool:') ? 'tools.forbidden'
        : c.field.startsWith('params.') ? 'params'
        : c.field;
      const bucket = byField[kind] ?? { checked: 0, failed: 0 };
      bucket.checked += 1;
      if (!c.ok) bucket.failed += 1;
      byField[kind] = bucket;
    }
  }

  const passed = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    passed,
    rate: results.length === 0 ? 0 : passed / results.length,
    byField,
    failures: results.filter((r) => !r.ok),
  };
}

/** Человекочитаемый отчёт: набор смотрят глазами чаще, чем графиками. */
export function formatReport(r: Report): string {
  if (r.total === 0) {
    return 'Golden set пуст. Случаи собираются при личном тестировании: см. packages/evals/cases/README.md';
  }

  const lines = [
    `Golden set: ${r.passed}/${r.total} (${(r.rate * 100).toFixed(0)}%)`,
    '',
    'По видам проверок:',
  ];
  for (const [field, s] of Object.entries(r.byField).sort()) {
    const rate = s.checked === 0 ? 1 : (s.checked - s.failed) / s.checked;
    lines.push(`  ${field.padEnd(18)} ${s.checked - s.failed}/${s.checked} (${(rate * 100).toFixed(0)}%)`);
  }

  if (r.failures.length > 0) {
    lines.push('', 'Упавшие случаи:');
    for (const f of r.failures) {
      lines.push(`  ✗ ${f.id}: «${f.input}»`);
      for (const c of f.checks.filter((c) => !c.ok)) {
        lines.push(`      ${c.field}: ждали «${c.expected}», получили «${c.actual}»`);
      }
    }
  }

  return lines.join('\n');
}
