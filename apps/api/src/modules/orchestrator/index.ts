import type { TurnEvent } from '@agentic-os/contracts';
import { log, traced } from '../../obs/log';
import { createJob, getJob, setStatus } from '../jobs/store';
import { runJobToCompletion } from '../jobs/runner';
import { stream } from '../jobs/bus';
import { ingestFacts, recordEpisode } from '../memory/graph';
import { fillMissingParams } from '../memory/retrieval';
import { createLlm, type LlmPort } from './llm';
import { LlmPlanner, planContextOf, type PlannerPort } from './planner';

/**
 * Оркестратор хода разговора.
 *
 * Роли разделены: роутер определяет намерение, планировщик строит план
 * (без инструментов), исполнитель выполняет шаги (узкий набор инструментов
 * на шаг), критик проверяет постусловия. Здесь они только связываются.
 *
 * Порядок подчинён воспринимаемой задержке: экран уходит клиенту первым
 * шагом плана, а обогащение доезжает следом.
 */

const llm: LlmPort = createLlm();
const planner: PlannerPort = new LlmPlanner(llm);

/**
 * Сколько держим SSE открытым. Дальше задача продолжается в фоне —
 * пользователь узнает о результате из пуша (S3) или увидит в списке задач.
 */
const STREAM_BUDGET_MS = 25_000;

export interface TurnInput {
  userId: string;
  text: string;
  source: 'text' | 'voice';
  locale: string;
  /** Ответ на вопрос агента по существующей задаче. */
  jobId?: string | undefined;
}

export async function* handleTurn(input: TurnInput): AsyncGenerator<TurnEvent> {
  const { userId, text, locale } = input;

  yield { type: 'status', phase: 'routing', text: 'Понимаю запрос…' };

  const route = await traced('orchestrator.route', () => llm.route(text), { llm: llm.name });
  log.info('routed', { family: route.family, intent: route.intent, confidence: route.confidence });

  if (route.intent === 'chitchat') {
    yield { type: 'message', text: 'На связи. Скажи, что нужно сделать — возьму на себя.' };
    yield { type: 'done', jobId: null };
    return;
  }

  // Ответ на вопрос агента продолжает существующую задачу, а не плодит новую.
  if (input.jobId) {
    const existing = await getJob(input.jobId, userId);
    if (existing && existing.status === 'waiting_user') {
      await setStatus(existing.id, 'running', { pendingQuestion: null });
      await recordEpisode(userId, 'answer', { text, jobId: existing.id }, existing.id);
      yield { type: 'status', phase: 'resuming', text: 'Продолжаю задачу…' };
      yield* runAndStream(existing.id);
      return;
    }
  }

  yield { type: 'status', phase: 'planning', text: 'Собираю план…' };

  /**
   * Достаём из графа то, чего не хватает в запросе. «Оформи визу» без страны
   * работает, если пользователь называл её раньше — это и есть накопительный
   * эффект, ради которого нужна память.
   */
  const { params, recalled } = await fillMissingParams(userId, route.goal, route.params);
  if (recalled.length > 0) {
    yield { type: 'status', phase: 'memory', text: `Помню по прошлым разговорам — ${recalled.join(', ')}` };
  }

  const context = planContextOf({ ...route, params }, locale);
  const plan = await traced('orchestrator.plan', () => planner.plan(context), {
    planner: planner.name,
  });

  const job = await createJob({ userId, goal: route.goal, plan, status: 'running' });
  log.info('job created', { jobId: job.id, steps: plan.length });
  yield { type: 'job', job };

  /**
   * Память наполняется параллельно исполнению и не блокирует выдачу:
   * граф — побочный продукт использования, а не предусловие для него.
   */
  void (async () => {
    try {
      const facts = await llm.extractFacts(text);
      const written = await ingestFacts(userId, facts, 'user_said', `job:${job.id}`);
      await recordEpisode(userId, 'turn', { text, family: route.family, facts: written }, job.id);
    } catch (err) {
      // Сбой памяти не должен ломать выданный результат.
      log.error('fact ingestion failed', { error: (err as Error).message });
    }
  })();

  yield* runAndStream(job.id);
}

/**
 * Запускает задачу и отдаёт её события клиенту.
 *
 * Исполнение живёт своей жизнью: если пользователь закроет экран, задача
 * продолжится. Поток — способ подсмотреть, а не условие работы.
 */
async function* runAndStream(jobId: string): AsyncGenerator<TurnEvent> {
  const signal = { done: false };

  const execution = runJobToCompletion(jobId)
    .catch((err: unknown) => {
      log.error('исполнение задачи упало', { jobId, error: (err as Error).message });
      return null;
    })
    .finally(() => {
      signal.done = true;
    });

  const deadline = setTimeout(() => {
    signal.done = true;
  }, STREAM_BUDGET_MS);

  try {
    for await (const event of stream(jobId, signal, STREAM_BUDGET_MS)) {
      yield event;
      if (event.type === 'done') return;
    }

    // Бюджет потока исчерпан, а задача ещё идёт — честно говорим об этом.
    const job = await getJob(jobId);
    if (job && (job.status === 'running' || job.status === 'waiting_world')) {
      yield { type: 'message', text: 'Продолжаю в фоне — вернусь с результатом.' };
    }
    yield { type: 'done', jobId };
  } finally {
    clearTimeout(deadline);
    void execution;
  }
}
