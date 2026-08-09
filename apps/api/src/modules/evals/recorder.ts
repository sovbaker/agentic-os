import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config';
import { log } from '../../obs/log';

/**
 * Запись заготовок для golden set.
 *
 * Набор собирается на реальных задачах при личном тестировании, а не
 * придумывается: примеры, сочинённые тем же, кто писал правила, проверяют
 * совпадение автора с самим собой. Поэтому здесь только заготовка — что
 * система решила, — а ожидание проставляет человек.
 *
 * Два ограничения важнее удобства:
 *
 *  - **выключено по умолчанию** (`RECORD_EVALS=1`): фразы пользователя на
 *    диск пишутся только по явному включению;
 *  - **`reviewed: false`**: заготовка не попадает в прогон, пока её не
 *    разметили. Иначе набор закрепит текущее поведение как правильное —
 *    и перестанет ловить регрессии ровно в тот момент, когда начнёт врать.
 */

export interface RecordInput {
  text: string;
  locale: string;
  route: { intent: string; family: string; params: Record<string, string> };
  plan: ReadonlyArray<{ tool: string }>;
  jobId: string;
}

let counter = 0;

export async function recordCase(input: RecordInput): Promise<void> {
  if (!config.recordEvals) return;

  try {
    await mkdir(config.evalsDir, { recursive: true });

    counter += 1;
    const line = JSON.stringify({
      id: `rec-${input.jobId.slice(0, 8)}-${counter}`,
      input: input.text,
      locale: input.locale,
      // Ожидание заполнено тем, что система решила: править одно поле
      // быстрее, чем писать все. Но `reviewed: false` держит его вне прогона.
      expect: {
        intent: input.route.intent,
        family: input.route.family,
        params: input.route.params,
        tools: [...new Set(input.plan.map((s) => s.tool))],
      },
      reviewed: false,
      recordedAt: new Date().toISOString(),
    });

    await appendFile(join(config.evalsDir, 'recorded.jsonl'), `${line}\n`, 'utf8');
  } catch (err) {
    // Запись примеров никогда не важнее ответа пользователю.
    log.warn('не удалось записать пример для эвалов', { error: (err as Error).message });
  }
}
