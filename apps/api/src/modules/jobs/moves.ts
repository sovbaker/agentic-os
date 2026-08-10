import { query, queryOne } from '../../db/client';

/**
 * Ходы по задаче: чей сейчас ход.
 *
 * Это данные под компоненты агентности. Раньше экран задачи знал только
 * свой чек-лист — то есть описывал задачу, а не работу над ней, и отличить
 * продукт от списка дел было нечем.
 *
 * Ходы не выдумываются: сделанное берётся из журнала аудита (там же, где
 * лежит компенсация), намерение — из вопроса, на котором задача остановилась,
 * ожидание — из полей задачи. Ни одно поле не вычисляется «примерно».
 */

export interface Moves {
  hasMoves: boolean;
  didMoves: Array<{ id: string; title: string; at: string; undoUntil: string }>;
  intentMoves: Array<{ id: string; title: string; before: string; after: string; discloses: string }>;
  awaitingMoves: Array<{ who: string; since: string; usually: string }>;
}

const fmtTime = (d: Date): string =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);

const fmtDate = (d: Date): string =>
  new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(d);

/** Сколько осталось до конца обратимости, человеческим языком. */
function remaining(until: Date, now: Date): string {
  const ms = until.getTime() - now.getTime();
  if (ms <= 0) return '';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `ещё ${hours} ч ${minutes} мин` : `ещё ${minutes} мин`;
}

export async function computeMoves(jobId: string, now = new Date()): Promise<Moves> {
  const [did, job] = await Promise.all([
    query<{ id: string; human_readable: string; at: Date; reversible_until: Date | null; reversed_at: Date | null }>(
      `SELECT id, human_readable, at, reversible_until, reversed_at
         FROM audit_log
        WHERE job_id = $1 AND reversed_at IS NULL
        ORDER BY at DESC LIMIT 5`,
      [jobId]
    ),
    queryOne<{
      pending_question: string | null;
      awaiting_who: string | null;
      awaiting_since: Date | null;
      awaiting_usually: string | null;
      intent: { title?: string; after?: string; discloses?: string } | null;
    }>(
      `SELECT pending_question, awaiting_who, awaiting_since, awaiting_usually, intent
         FROM job WHERE id = $1`,
      [jobId]
    ),
  ]);

  const didMoves = did.map((r) => ({
    id: r.id,
    title: r.human_readable,
    at: fmtTime(r.at),
    // Пусто означает «отменить уже нельзя», и компонент говорит это словами.
    undoUntil: r.reversible_until ? remaining(r.reversible_until, now) : '',
  }));

  /**
   * Намерение. Пока задача умеет остановиться ровно на одном решении,
   * поэтому и намерение одно: честнее показать одно настоящее, чем
   * выдумать список.
   *
   * Дифф берётся из объявленного намерения, если оно есть, и остаётся
   * пустым, если его нет: показать «было → станет» с выдуманными
   * сторонами хуже, чем не показать ничего.
   */
  const intentMoves = job?.pending_question
    ? [
        {
          id: jobId,
          title: job.intent?.title ?? job.pending_question,
          before: '',
          after: job.intent?.after ?? '',
          discloses: job.intent?.discloses ?? '',
        },
      ]
    : [];

  const awaitingMoves =
    job?.awaiting_who && job.awaiting_since
      ? [{ who: job.awaiting_who, since: fmtDate(job.awaiting_since), usually: job.awaiting_usually ?? '' }]
      : [];

  return {
    hasMoves: didMoves.length + intentMoves.length + awaitingMoves.length > 0,
    didMoves,
    intentMoves,
    awaitingMoves,
  };
}
