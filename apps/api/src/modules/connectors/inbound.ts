import { randomBytes } from 'node:crypto';
import { query, queryOne } from '../../db/client';
import { log } from '../../obs/log';
import { quarantine } from '../orchestrator/quarantine';
import { createLlm } from '../orchestrator/llm';
import { calendar } from '../tools/calendar';

/**
 * Входящие данные без единой внешней верификации.
 *
 * Чтение почты у крупных провайдеров — restricted scope: сторонний аудит,
 * деньги и недели ожидания. Для первой версии это стоп-фактор, поэтому почта
 * приходит на адрес для пересылки, который пользователь настраивает сам.
 *
 * Это не компромисс, а более честная модель: человек решает, что мы видим,
 * и на экране приватности это аргумент, а не оправдание.
 */

const llm = createLlm();

export async function ensureInboxKey(userId: string): Promise<string> {
  const existing = await queryOne<{ inbox_key: string | null }>('SELECT inbox_key FROM app_user WHERE id = $1', [
    userId,
  ]);
  if (existing?.inbox_key) return existing.inbox_key;

  const key = randomBytes(6).toString('base64url').toLowerCase();
  await query('UPDATE app_user SET inbox_key = $2 WHERE id = $1', [userId, key]);
  return key;
}

/** `u+abc123@in.example.ru` → `abc123` */
export function parseInboxAddress(address: string): string | null {
  const match = /(?:^|<)\s*[a-z0-9._-]*\+([a-z0-9_-]+)@/i.exec(address);
  return match?.[1]?.toLowerCase() ?? null;
}

export interface InboundEmail {
  to: string;
  from?: string;
  subject?: string;
  text: string;
}

export interface InboundResult {
  accepted: boolean;
  factsWritten: number;
  injectionSuspected: boolean;
}

export async function ingestEmail(email: InboundEmail): Promise<InboundResult> {
  const key = parseInboxAddress(email.to);
  if (!key) return { accepted: false, factsWritten: 0, injectionSuspected: false };

  const user = await queryOne<{ id: string }>('SELECT id FROM app_user WHERE inbox_key = $1', [key]);
  if (!user) return { accepted: false, factsWritten: 0, injectionSuspected: false };

  /**
   * Письмо — недоверенный ввод по определению: его содержимое пишет кто угодно,
   * в том числе с расчётом на то, что его прочитает агент. Поэтому оно идёт
   * тем же путём, что и результаты веб-поиска, — через карантин.
   */
  const raw = [email.subject, email.text].filter(Boolean).join('\n\n');
  const cleaned = await quarantine({
    userId: user.id,
    jobId: null,
    tool: 'inbound.email',
    raw,
    sources: [{ title: email.subject?.slice(0, 120) ?? 'Письмо', snippet: email.text }],
    llm,
  });

  const { ingestFacts } = await import('../memory/graph');
  // Источник `email` слабее прямых слов пользователя — так и должно быть.
  const written = await ingestFacts(user.id, cleaned.facts, 'email', `inbox:${key}`);

  log.info('входящее письмо обработано', {
    userId: user.id,
    facts: written,
    injectionSuspected: cleaned.injectionSuspected,
  });

  return { accepted: true, factsWritten: written, injectionSuspected: cleaned.injectionSuspected };
}

/* ------------------------------------------------------------------ */
/* Календарь через .ics                                                */
/* ------------------------------------------------------------------ */

export interface ParsedEvent {
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  externalId: string | null;
}

/** `20260920T103000Z` и `20260920` — два формата, которые реально встречаются. */
function parseIcsDate(value: string): string | null {
  const clean = value.trim().replace(/^;?[^:]*:/, '');
  const withTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(clean);
  if (withTime) {
    const [, y, m, d, hh, mm, ss] = withTime;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}${withTime[7] ? 'Z' : 'Z'}`).toISOString();
  }
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(clean);
  if (dateOnly) return new Date(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T00:00:00Z`).toISOString();
  return null;
}

/**
 * Минимальный разбор ICS: то, что нужно ассистенту, и ничего больше.
 * Полноценная библиотека тянет зависимость ради полей, которыми мы не
 * пользуемся, и открывает поверхность для сюрпризов в чужом формате.
 */
export function parseIcs(source: string): ParsedEvent[] {
  // Строки в ICS переносятся с отступом — сначала склеиваем.
  const unfolded = source.replace(/\r?\n[ \t]/g, '');
  const events: ParsedEvent[] = [];

  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0] ?? '';
    const field = (name: string): string | null => {
      const re = new RegExp(`^${name}([^:]*):(.*)$`, 'im');
      return re.exec(body)?.[2]?.trim() ?? null;
    };

    const title = field('SUMMARY');
    const startRaw = /^DTSTART[^:]*:(.*)$/im.exec(body)?.[1];
    if (!title || !startRaw) continue;

    const startsAt = parseIcsDate(startRaw);
    if (!startsAt) continue;

    const endRaw = /^DTEND[^:]*:(.*)$/im.exec(body)?.[1];

    events.push({
      title: title.slice(0, 200),
      startsAt,
      endsAt: endRaw ? parseIcsDate(endRaw) : null,
      location: field('LOCATION'),
      externalId: field('UID'),
    });
  }

  return events;
}

export async function importIcs(userId: string, source: string): Promise<{ imported: number; skipped: number }> {
  const events = parseIcs(source);
  let imported = 0;
  let skipped = 0;

  for (const event of events) {
    // Повторный импорт того же файла не должен плодить дубли.
    if (event.externalId) {
      const existing = await queryOne<{ id: string }>(
        `SELECT id FROM calendar_event WHERE user_id = $1 AND source = 'ics' AND external_id = $2`,
        [userId, event.externalId]
      );
      if (existing) {
        skipped += 1;
        continue;
      }
    }

    await query(
      `INSERT INTO calendar_event (user_id, title, starts_at, ends_at, location, source, external_id)
       VALUES ($1, $2, $3, $4, $5, 'ics', $6)`,
      [userId, event.title, event.startsAt, event.endsAt, event.location, event.externalId]
    );
    imported += 1;
  }

  return { imported, skipped };
}

/** Календарь — самый плотный источник фактов о ритме жизни человека. */
export async function factsFromCalendar(userId: string): Promise<number> {
  const now = new Date();
  const events = await calendar.listEvents(
    userId,
    new Date(now.getTime() - 90 * 86_400_000).toISOString(),
    new Date(now.getTime() + 180 * 86_400_000).toISOString()
  );
  if (events.length === 0) return 0;

  const byTitle = new Map<string, number>();
  for (const event of events) {
    const key = event.title.toLowerCase().replace(/\d+/g, '').trim();
    byTitle.set(key, (byTitle.get(key) ?? 0) + 1);
  }

  const { ingestFacts } = await import('../memory/graph');
  // Повторяющееся событие — это ритм, а разовое ничего не говорит о человеке.
  const recurring = [...byTitle.entries()].filter(([, count]) => count >= 3);

  return ingestFacts(
    userId,
    recurring.map(([title, count]) => ({
      entityLabel: title.slice(0, 60),
      entityType: 'recurring' as const,
      predicate: 'happens_regularly',
      value: String(count),
      confidence: 0.6,
    })),
    'calendar',
    'calendar-scan'
  );
}
