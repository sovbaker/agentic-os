import type { Job, JobStep } from '@agentic-os/contracts';
import { log, traced } from '../../obs/log';
import { judge } from '../orchestrator/critic';
import { quarantine } from '../orchestrator/quarantine';
import { createLlm, type LlmPort } from '../orchestrator/llm';
import { ingestFacts } from '../memory/graph';
import { execTool, manifestOf, type ToolResult } from '../tools/index';
import { publish } from './bus';
import {
  addArtifact,
  chargeBudget,
  claimJobs,
  completedByKey,
  extendLease,
  getJob,
  markStepDone,
  markStepFailed,
  markStepRunning,
  newWorkerId,
  releaseJob,
  runnableSteps,
  setStatus,
  stepsOf,
} from './store';

/**
 * Исполнитель шагов и воркер задач.
 *
 * Три свойства, ради которых он существует:
 *
 *  1. Задача переживает перезапуск: состояние в базе, аренда с истечением.
 *  2. Повтор не создаёт второй побочный эффект: ключ идемпотентности.
 *  3. Недоверенный контент не доходит до контекста с инструментами:
 *     карантин применяется здесь, в единственном месте.
 *
 * В S1 воркер живёт в том же процессе, что и API. Вынести его в отдельный —
 * механическая операция: он общается с остальным кодом только через базу.
 */

const llm: LlmPort = createLlm();

const COST_BY_HINT: Record<string, number> = { free: 0, cheap: 0.5, expensive: 5 };

/** Ссылка на результат предыдущего шага в аргументах плана. */
interface StepRefShape {
  $fromStep: { idx: number; path: string };
}

function isStepRef(value: unknown): value is StepRefShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$fromStep' in value &&
    typeof (value as StepRefShape).$fromStep?.idx === 'number'
  );
}

interface StoredResult {
  ok: boolean;
  message?: string;
  dataPatch?: Record<string, unknown>;
  specId?: string;
}

async function resolveArgs(
  jobId: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const hasRefs = Object.values(args).some(isStepRef);
  if (!hasRefs) return args;

  const steps = await stepsOf(jobId);
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (!isStepRef(value)) {
      out[key] = value;
      continue;
    }
    const source = steps.find((s) => s.idx === value.$fromStep.idx);
    const result = source?.result as StoredResult | undefined;
    const path = value.$fromStep.path;
    out[key] = result?.dataPatch?.[path] ?? (result as Record<string, unknown> | undefined)?.[path] ?? null;
  }
  return out;
}

/**
 * Выполнить шаг. Всё, что возвращает инструмент с пометкой returnsUntrusted,
 * проходит карантин ЗДЕСЬ и дальше живёт только как структура.
 */
async function executeStep(
  job: Job,
  step: JobStep & { title: string },
  specId: string | undefined
): Promise<{ result: ToolResult; storable: StoredResult }> {
  const manifest = manifestOf(step.tool);
  const args = await resolveArgs(job.id, step.args);

  const outcome = await execTool(
    step.tool,
    { userId: job.userId, jobId: job.id, specId, confirmed: false },
    args
  );

  let result: ToolResult = outcome;

  if (outcome.untrusted) {
    const cleaned = await quarantine({
      userId: job.userId,
      jobId: job.id,
      tool: step.tool,
      raw: outcome.untrusted.raw,
      ...(outcome.untrusted.sources ? { sources: outcome.untrusted.sources } : {}),
      llm,
    });

    // Сырой текст сюда уже не возвращается — ни в результат шага, ни в базу.
    result = {
      ...outcome,
      untrusted: undefined,
      dataPatch: {
        ...(outcome.dataPatch ?? {}),
        findings: cleaned.findings,
        injectionSuspected: cleaned.injectionSuspected,
      },
      facts: cleaned.facts,
    };

    if (cleaned.injectionSuspected) {
      publish(job.id, {
        type: 'status',
        phase: 'security',
        text: 'В найденном тексте были инструкции для ассистента — я их проигнорировал',
      });
    }
  }

  if (result.facts && result.facts.length > 0) {
    /**
     * Факты из недоверенного источника пишутся как inferred: по политике
     * разрешения конфликтов такой источник никогда не перебьёт то,
     * что сказал сам пользователь.
     */
    const source = manifest?.returnsUntrusted ? 'inferred' : 'procedure';
    await ingestFacts(job.userId, result.facts, source, `job:${job.id}`);
  }

  const storable: StoredResult = {
    ok: result.ok,
    ...(result.message ? { message: result.message } : {}),
    ...(result.dataPatch ? { dataPatch: result.dataPatch } : {}),
    ...(result.spec ? { specId: result.spec.id } : {}),
  };

  return { result, storable };
}

/** Один проход по задаче: выполняем все шаги, готовые к исполнению. */
async function advanceJob(job: Job, workerId: string): Promise<void> {
  const all = await stepsOf(job.id);
  const composed = all.find((s) => s.tool === 'miniapp.compose' && s.status === 'done');
  let specId = (composed?.result as StoredResult | undefined)?.specId;

  const ready = await runnableSteps(job.id);

  for (const pending of ready) {
    const step = all.find((s) => s.idx === pending.idx);
    if (!step) continue;

    // Тот же ключ уже выполнен — воркер перезапустился между вызовом
    // и записью результата. Повторять побочный эффект нельзя.
    const alreadyDone = await completedByKey(step.idempotencyKey);
    if (alreadyDone !== undefined) {
      log.info('шаг пропущен по идемпотентности', { jobId: job.id, idx: step.idx });
      continue;
    }

    await markStepRunning(step.id);
    await extendLease(job.id, workerId);
    publish(job.id, { type: 'status', phase: `step:${step.idx}`, text: step.title });

    let result: ToolResult;
    let storable: StoredResult;
    try {
      const executed = await traced(
        `step.${step.tool}`,
        () => executeStep(job, { ...step, ...pending, title: step.title }, specId),
        { jobId: job.id, idx: step.idx }
      );
      result = executed.result;
      storable = executed.storable;
    } catch (err) {
      const message = (err as Error).message;
      const { willRetry } = await markStepFailed(step.id, message);
      log.error('шаг упал', { jobId: job.id, idx: step.idx, error: message, willRetry });
      if (!willRetry) {
        await setStatus(job.id, 'failed', { lastError: message });
        publish(job.id, { type: 'error', code: 'step_failed', text: `Не смог: ${step.title}` });
        publish(job.id, { type: 'done', jobId: job.id });
      }
      return;
    }

    const cost = COST_BY_HINT[manifestOf(step.tool)?.costHint ?? 'cheap'] ?? 0.5;
    const budget = await chargeBudget(job.id, cost);

    const { verdict, unknownConditions } = judge({
      result,
      postconditions: step.postconditions,
      attempts: pending.attempts + 1,
      maxAttempts: step.maxAttempts,
    });
    if (unknownConditions.length > 0) {
      log.warn('неизвестные постусловия в плане', { conditions: unknownConditions });
    }

    if (verdict.kind === 'accept') {
      await markStepDone(step.id, storable);

      if (result.spec) {
        specId = result.spec.id;
        await addArtifact(job.id, { kind: 'miniapp', id: result.spec.id, title: result.spec.title });
        publish(job.id, { type: 'spec', spec: result.spec });
      }
      for (const [key, value] of Object.entries(result.dataPatch ?? {})) {
        publish(job.id, { type: 'data', key, value });
      }
      if (result.message) {
        publish(job.id, { type: 'message', text: result.message });
      }
    } else if (verdict.kind === 'retry') {
      await markStepFailed(step.id, verdict.reason);
      log.info('шаг будет повторён', { jobId: job.id, idx: step.idx, reason: verdict.reason });
      return;
    } else {
      await markStepFailed(step.id, verdict.reason);
      // Обогащение не обязано получиться: экран у пользователя уже есть,
      // и терять его из-за упавшего поиска было бы хуже, чем продолжить.
      const optional = step.tool === 'web.search' || step.tool === 'miniapp.enrich';
      if (!optional) {
        await setStatus(job.id, 'waiting_user', {
          pendingQuestion: `Не получилось: ${step.title}. Подскажешь, как лучше?`,
          lastError: verdict.reason,
        });
        publish(job.id, { type: 'message', text: `Застрял на шаге «${step.title}». ${verdict.reason}` });
        publish(job.id, { type: 'done', jobId: job.id });
        return;
      }
      log.info('необязательный шаг пропущен', { jobId: job.id, idx: step.idx, reason: verdict.reason });
    }

    if (budget && budget.spentRub > budget.maxCostRub) {
      await setStatus(job.id, 'waiting_user', {
        pendingQuestion: 'Задача уперлась в бюджет. Продолжать?',
      });
      publish(job.id, { type: 'message', text: 'Задача уперлась в бюджет — жду решения' });
      publish(job.id, { type: 'done', jobId: job.id });
      return;
    }
  }

  const after = await stepsOf(job.id);
  const unfinished = after.filter((s) => s.status === 'pending' || s.status === 'running');
  const failed = after.filter((s) => s.status === 'failed');

  if (unfinished.length === 0) {
    const terminal = failed.length > 0 && failed.some((s) => s.tool === 'miniapp.compose') ? 'failed' : 'done';
    await setStatus(job.id, terminal);
    publish(job.id, { type: 'done', jobId: job.id });
  }
}

/* ------------------------------------------------------------------ */
/* Компенсация                                                         */
/* ------------------------------------------------------------------ */

/**
 * Отмена задачи: компенсирующие действия в обратном порядке.
 * «Отменить» — часть контракта инструмента, а не отдельная функция продукта.
 */
export async function cancelJob(userId: string, jobId: string): Promise<{ compensated: number }> {
  const job = await getJob(jobId, userId);
  if (!job) throw new Error('задача не найдена');

  const steps = (await stepsOf(jobId)).filter((s) => s.status === 'done').reverse();
  let compensated = 0;

  for (const step of steps) {
    if (!step.compensation) continue;
    try {
      const outcome = await execTool(
        step.compensation.tool,
        { userId, jobId, confirmed: true },
        step.compensation.args
      );
      if (outcome.ok) {
        await import('./store').then((m) => m.markStepCompensated(step.id));
        compensated += 1;
      }
    } catch (err) {
      log.error('компенсация не удалась', { jobId, idx: step.idx, error: (err as Error).message });
    }
  }

  await setStatus(jobId, 'cancelled');
  publish(jobId, { type: 'message', text: 'Задача отменена' });
  publish(jobId, { type: 'done', jobId });
  return { compensated };
}

/* ------------------------------------------------------------------ */
/* Воркер                                                              */
/* ------------------------------------------------------------------ */

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function tick(workerId: string): Promise<number> {
  const jobs = await claimJobs(workerId, 5);
  for (const job of jobs) {
    try {
      // Проснувшуюся по таймеру задачу возвращаем в работу.
      if (job.status === 'waiting_world') await setStatus(job.id, 'running');
      await advanceJob(job, workerId);
    } catch (err) {
      log.error('обработка задачи упала', { jobId: job.id, error: (err as Error).message });
      await setStatus(job.id, 'failed', { lastError: (err as Error).message });
    } finally {
      await releaseJob(job.id);
    }
  }
  return jobs.length;
}

/**
 * Сканер поводов для проактивности.
 *
 * Отдельный такт с большим периодом: поводы меняются в масштабе часов,
 * а задачи — секунд. Гонять их вместе значит либо жечь запросы впустую,
 * либо тормозить исполнение.
 */
async function proactiveTick(): Promise<void> {
  const { runFor } = await import('../proactive/index');
  const { query } = await import('../../db/client');

  // Только те, кто пользовался продуктом недавно: рассылать неактивным
  // — самый быстрый способ научить людей отключать уведомления.
  const users = await query<{ id: string }>(
    `SELECT DISTINCT u.id FROM app_user u
       JOIN device d ON d.user_id = u.id
      WHERE d.last_seen_at > now() - interval '14 days'
      LIMIT 500`
  );

  for (const user of users) {
    try {
      await runFor(user.id);
    } catch (err) {
      log.error('проактивный проход упал', { userId: user.id, error: (err as Error).message });
    }
  }
}

let proactiveTimer: NodeJS.Timeout | null = null;

export function startWorker(intervalMs = 1000, proactiveIntervalMs = 15 * 60_000): () => void {
  const workerId = newWorkerId();
  log.info('воркер запущен', { workerId, intervalMs, proactiveIntervalMs });

  proactiveTimer = setInterval(() => {
    void proactiveTick().catch((err: unknown) =>
      log.error('такт проактивности упал', { error: (err as Error).message })
    );
  }, proactiveIntervalMs);

  timer = setInterval(() => {
    if (running) return;
    running = true;
    void tick(workerId)
      .catch((err: unknown) => log.error('такт воркера упал', { error: (err as Error).message }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  return () => {
    if (timer) clearInterval(timer);
    if (proactiveTimer) clearInterval(proactiveTimer);
    timer = null;
    proactiveTimer = null;
  };
}

/** Прогнать задачу до остановки синхронно — для тестов и эвалов. */
export async function runJobToCompletion(jobId: string, maxTicks = 25): Promise<Job | null> {
  const workerId = newWorkerId();
  for (let i = 0; i < maxTicks; i++) {
    const job = await getJob(jobId);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'waiting_user') {
      return job;
    }
    await advanceJob(job, workerId);
  }
  return getJob(jobId);
}
