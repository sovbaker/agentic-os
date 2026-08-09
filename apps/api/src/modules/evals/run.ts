import { check, formatReport, loadCases, report, type CaseResult, type EvalCase, type Observation } from '@agentic-os/evals';
import { config } from '../../config';
import { compose } from '../miniapps/compose';
import { createLlm } from '../orchestrator/llm';
import { LlmPlanner, planContextOf } from '../orchestrator/planner';

/**
 * Прогон golden set.
 *
 * Это замена код-ревью, а не дополнение к тестам. Юнит-тест проверяет, что
 * код делает написанное; эвал проверяет, что система понимает живого
 * человека. Второе ломается от смены промпта, модели и содержимого графа —
 * то есть от всего, что в юнит-тест не помещается.
 *
 * Прогон **без побочных эффектов**: маршрутизация, планирование и сборка
 * экрана не трогают внешний мир — задача не создаётся, инструменты не
 * вызываются. Иначе один прогон набора отправил бы сорок писем.
 *
 *   npm run evals                      — на детерминированном адаптере
 *   ANTHROPIC_API_KEY=… npm run evals  — на модели
 */

/** Порог гейта G1 из дорожной карты. */
const GATE = Number(process.env['EVALS_GATE'] ?? '0.8');

const llm = createLlm();
const planner = new LlmPlanner(llm);

async function observe(kase: EvalCase): Promise<Observation> {
  const route = await llm.route(kase.input);
  const plan = await planner.plan(planContextOf(route, kase.locale));
  const screen = await compose(
    { goal: route.goal, family: route.family, params: route.params, locale: kase.locale },
    { llm }
  );

  return {
    intent: route.intent,
    family: route.family,
    params: route.params,
    tools: plan.map((s) => s.tool),
    origin: screen.origin,
  };
}

export async function runEvals(dir = config.evalsDir): Promise<{ ok: boolean; text: string }> {
  const loaded = await loadCases(dir);
  const lines: string[] = [];

  for (const b of loaded.broken) lines.push(`✗ ${b.file}:${b.line} — ${b.error}`);
  if (loaded.unreviewed > 0) {
    lines.push(`${loaded.unreviewed} заготовок ждут разметки (reviewed: true) и в прогон не идут.`, '');
  }

  if (loaded.cases.length === 0) {
    lines.push(formatReport(report([])));
    // Пустой набор — не провал: он ещё не собран. Провалом было бы
    // выдать 0/0 за сто процентов.
    return { ok: loaded.broken.length === 0, text: lines.join('\n') };
  }

  const results: CaseResult[] = [];
  for (const kase of loaded.cases) {
    try {
      results.push(check(kase, await observe(kase)));
    } catch (err) {
      results.push({ id: kase.id, input: kase.input, ok: false, checks: [], error: (err as Error).message });
    }
  }

  const r = report(results);
  lines.push(formatReport(r));
  lines.push('', `Гейт G1: ${(GATE * 100).toFixed(0)}% — ${r.rate >= GATE ? 'пройден' : 'НЕ пройден'}`);
  return { ok: r.rate >= GATE && loaded.broken.length === 0, text: lines.join('\n') };
}
