import { log } from '../../obs/log';
import type { PlanStep } from '../jobs/store';
import { KNOWN_TOOLS, PLANNABLE_TOOLS } from '../tools/index';
import type { JobFamily, LlmPort, RouteResult } from './llm';

/**
 * Планировщик.
 *
 * У него НЕТ инструментов — он только строит план. Это делает его дешёвым
 * в отладке и невосприимчивым к внедрению инструкций через результаты
 * вызовов: он их просто не видит.
 *
 * Шаблоны на правилах — не запасной вариант, а основной путь для известных
 * семейств задач: они предсказуемы, бесплатны и мгновенны. Модель нужна
 * там, где шаблона нет.
 */

/** Ссылка на результат предыдущего шага; разрешается исполнителем перед вызовом. */
export interface StepRef {
  $fromStep: { idx: number; path: string };
}

export const fromStep = (idx: number, path: string): StepRef => ({ $fromStep: { idx, path } });

export interface PlanContext {
  goal: string;
  family: JobFamily;
  params: Record<string, string>;
  locale: string;
}

function searchQuery(ctx: PlanContext): string {
  const country = ctx.params['country'];
  switch (ctx.family) {
    case 'documents': return country ? `документы на визу в ${country} список требований` : `${ctx.goal} какие документы нужны`;
    case 'travel': return country ? `поездка в ${country} что нужно знать` : ctx.goal;
    case 'home': return `${ctx.goal} как выбрать подрядчика на что смотреть`;
    case 'health': return `${ctx.goal} как подготовиться`;
    default: return ctx.goal;
  }
}

/**
 * Базовый план: сначала экран, потом обогащение.
 *
 * Порядок подчинён воспринимаемой задержке — мини-аппа уходит клиенту
 * первым шагом, а поиск и обогащение доезжают следом. Обратный порядок
 * заставил бы человека смотреть на спиннер несколько секунд.
 */
function templatePlan(ctx: PlanContext): PlanStep[] {
  const steps: PlanStep[] = [
    {
      title: 'Собираю экран под задачу',
      tool: 'miniapp.compose',
      args: { family: ctx.family, goal: ctx.goal, params: ctx.params, locale: ctx.locale },
      dependsOn: [],
      postconditions: ['spec_valid'],
    },
  ];

  const needsResearch = ctx.family === 'documents' || ctx.family === 'travel' || ctx.family === 'home';

  if (needsResearch) {
    steps.push({
      title: 'Ищу, что понадобится',
      tool: 'web.search',
      args: { q: searchQuery(ctx), limit: 3 },
      dependsOn: [0],
      postconditions: ['result.ok'],
      // Поиск может лечь: два повтора, дальше задача продолжается без обогащения.
      maxAttempts: 2,
    });
    steps.push({
      title: 'Дополняю экран найденным',
      tool: 'miniapp.enrich',
      args: { findings: fromStep(1, 'findings') },
      dependsOn: [1],
      postconditions: [],
    });
  }

  if (ctx.params['deadline']) {
    steps.push({
      title: 'Ставлю напоминание о сроке',
      tool: 'reminder.schedule',
      args: { afterDays: 2, about: ctx.goal.slice(0, 80) },
      dependsOn: [0],
      postconditions: ['result.ok'],
      compensation: { tool: 'reminder.cancel', args: {} },
    });
  }

  return steps;
}

/* ------------------------------------------------------------------ */

const PLAN_SYSTEM = `Ты — планировщик личного ассистента. Тебе НЕ доступны инструменты: ты только составляешь план.
Верни СТРОГО JSON-массив шагов без markdown-обёртки:
[{"title":"<что происходит, человеческим языком>","tool":"<имя из списка>","args":{},"dependsOn":[<индексы>],"postconditions":["result.ok"]}]
Правила:
- первым шагом всегда miniapp.compose — пользователь должен увидеть экран сразу;
- не более 6 шагов;
- используй только инструменты из списка;
- dependsOn содержит индексы предыдущих шагов.`;

function validatePlan(raw: unknown): PlanStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 6) return null;

  const steps: PlanStep[] = [];
  for (const [idx, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) return null;
    const step = item as Record<string, unknown>;
    const tool = typeof step['tool'] === 'string' ? step['tool'] : null;
    // План, ссылающийся на несуществующий инструмент, отбрасываем целиком:
    // частично исполнимый план хуже предсказуемого шаблона.
    if (!tool || !KNOWN_TOOLS.has(tool)) return null;

    const dependsOn = Array.isArray(step['dependsOn'])
      ? step['dependsOn'].filter((d): d is number => typeof d === 'number' && d >= 0 && d < idx)
      : idx > 0 ? [idx - 1] : [];

    steps.push({
      title: typeof step['title'] === 'string' ? step['title'].slice(0, 120) : `Шаг ${idx + 1}`,
      tool,
      args: (step['args'] as Record<string, unknown>) ?? {},
      dependsOn,
      postconditions: Array.isArray(step['postconditions'])
        ? step['postconditions'].filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  if (steps[0]?.tool !== 'miniapp.compose') return null;
  return steps;
}

export interface PlannerPort {
  readonly name: string;
  plan(ctx: PlanContext): Promise<PlanStep[]>;
}

export class TemplatePlanner implements PlannerPort {
  readonly name = 'template';
  async plan(ctx: PlanContext): Promise<PlanStep[]> {
    return templatePlan(ctx);
  }
}

/**
 * Планировщик на модели. Для известных семейств шаблон надёжнее и быстрее,
 * поэтому модель зовём только на «other» — там, где шаблона нет.
 */
export class LlmPlanner implements PlannerPort {
  readonly name = 'llm';

  constructor(
    private readonly llm: LlmPort,
    private readonly fallback: PlannerPort = new TemplatePlanner()
  ) {}

  async plan(ctx: PlanContext): Promise<PlanStep[]> {
    if (ctx.family !== 'other' || !this.llm.plan) return this.fallback.plan(ctx);

    const catalogue = PLANNABLE_TOOLS.map((t) => `${t.name} — ${t.description}`).join('\n');
    const raw = await this.llm.plan(
      PLAN_SYSTEM,
      `Цель: ${ctx.goal}\n\nДоступные инструменты:\n${catalogue}`
    );

    const validated = validatePlan(raw);
    if (!validated) {
      log.warn('план от модели не прошёл валидацию, беру шаблон', { family: ctx.family });
      return this.fallback.plan(ctx);
    }
    return validated;
  }
}

export function planContextOf(route: RouteResult, locale: string): PlanContext {
  return { goal: route.goal, family: route.family, params: route.params, locale };
}

export { templatePlan, validatePlan };
