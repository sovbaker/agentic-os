import type { TurnEvent, UISpec } from '@agentic-os/contracts';
import { query } from '../../db/client';
import { log, traced } from '../../obs/log';
import { selectEntry } from '../miniapps/catalog';
import { validateSpec } from '../miniapps/validate';
import { KNOWN_TOOLS } from '../tools/index';
import { createJob } from '../jobs/store';
import { ingestFacts, recordEpisode } from '../memory/graph';
import { createLlm, type LlmPort } from './llm';

/**
 * Оркестратор хода разговора.
 *
 * В S0 роли ещё слиты в один проход — это осознанно: контур сначала должен
 * заработать end-to-end. Разделение на роутер → планировщик → исполнители →
 * критик приходит в S1, и границы уже расставлены так, чтобы это было
 * расширением, а не переписыванием.
 *
 * Порядок событий подчинён воспринимаемой задержке: экран уходит клиенту
 * раньше, чем мы начинаем возиться с памятью.
 */

const llm: LlmPort = createLlm();

/** Экран, который показываем, если сгенерированная мини-аппа не прошла валидацию. */
function fallbackSpec(goal: string): UISpec {
  return {
    schemaVersion: '1.0',
    id: 'fallback',
    version: 1,
    title: 'Задача принята',
    dataSources: [],
    meta: { origin: 'catalog', graphRefs: [], shareable: false },
    root: {
      type: 'screen',
      props: { title: 'Задача принята' },
      children: [
        {
          type: 'card',
          children: [
            { type: 'heading', props: { text: goal.slice(0, 90), level: 1 } },
            {
              type: 'text',
              props: {
                text: 'Взял в работу. Экран под эту задачу пока собрать не удалось — вернусь с результатом.',
                tone: 'muted',
              },
            },
          ],
        },
      ],
    },
  };
}

async function persistMiniApp(
  userId: string,
  spec: UISpec,
  data: Record<string, unknown>
): Promise<void> {
  await query(
    `INSERT INTO miniapp (id, version, user_id, title, origin, spec)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id, version) DO NOTHING`,
    [spec.id, spec.version, null, spec.title, spec.meta.origin, JSON.stringify(spec)]
  );

  // Состояние мини-аппы принадлежит пользователю и переживает перезапуск:
  // «Ремонт кухни» через месяц должен помнить, что было.
  await query(
    `INSERT INTO miniapp_state (user_id, spec_id, data)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, spec_id) DO NOTHING`,
    [userId, spec.id, JSON.stringify(data)]
  );
}

export interface TurnInput {
  userId: string;
  text: string;
  source: 'text' | 'voice';
  locale: string;
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

  yield { type: 'status', phase: 'planning', text: 'Собираю план…' };

  const job = await createJob({ userId, goal: route.goal, status: 'running' });
  yield { type: 'job', job };

  const entry = selectEntry(route.family);
  const params = { goal: route.goal, params: route.params, locale };

  let spec = entry.build(params);
  const data = entry.data(params);

  // Каталожные аппы проходят ту же валидацию, что и сгенерированные:
  // единственный способ не узнать о сломанном экране от пользователя.
  const validation = validateSpec(spec, { knownTools: KNOWN_TOOLS });
  if (!validation.ok) {
    log.error('catalog spec failed validation', {
      specId: spec.id,
      errors: validation.errors,
      budget: validation.budgetExceeded,
    });
    spec = fallbackSpec(route.goal);
  }

  await persistMiniApp(userId, spec, data);

  yield { type: 'spec', spec };
  for (const [key, value] of Object.entries(data)) {
    yield { type: 'data', key, value };
  }

  // Память наполняется после того, как пользователь увидел результат:
  // граф — побочный продукт использования, а не предусловие для него.
  yield { type: 'status', phase: 'memory', text: 'Запоминаю контекст…' };

  try {
    const facts = await traced('orchestrator.extract', () => llm.extractFacts(text));
    const written = await ingestFacts(userId, facts, 'user_said', `job:${job.id}`);
    await recordEpisode(userId, 'turn', { text, family: route.family, facts: written }, job.id);
    log.info('facts ingested', { count: written });
  } catch (err) {
    // Сбой памяти не должен ломать выданный результат.
    log.error('fact ingestion failed', { error: (err as Error).message });
  }

  yield { type: 'done', jobId: job.id };
}
