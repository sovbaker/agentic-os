import { query, queryOne } from '../../db/client';

/**
 * Порт календаря.
 *
 * Реализация на своей таблице — временная, адаптеры EventKit и CalDAV
 * приходят в S3 (решение D1: РФ первым, глобал через порты). Но порт и
 * данные уже настоящие: всё, что выше, не знает названий поставщиков и
 * не изменится при подключении реального календаря.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  source: string;
}

export interface NewEvent {
  title: string;
  startsAt: string;
  endsAt?: string | null;
  location?: string | null;
}

export interface CalendarPort {
  listEvents(userId: string, from: string, to: string): Promise<CalendarEvent[]>;
  createEvent(userId: string, event: NewEvent): Promise<CalendarEvent>;
  deleteEvent(userId: string, eventId: string): Promise<boolean>;
}

interface Row {
  id: string;
  title: string;
  starts_at: Date;
  ends_at: Date | null;
  location: string | null;
  source: string;
}

const toEvent = (r: Row): CalendarEvent => ({
  id: r.id,
  title: r.title,
  startsAt: r.starts_at.toISOString(),
  endsAt: r.ends_at ? r.ends_at.toISOString() : null,
  location: r.location,
  source: r.source,
});

export class LocalCalendar implements CalendarPort {
  async listEvents(userId: string, from: string, to: string): Promise<CalendarEvent[]> {
    const rows = await query<Row>(
      `SELECT id, title, starts_at, ends_at, location, source
         FROM calendar_event
        WHERE user_id = $1 AND starts_at >= $2 AND starts_at < $3
        ORDER BY starts_at`,
      [userId, from, to]
    );
    return rows.map(toEvent);
  }

  async createEvent(userId: string, event: NewEvent): Promise<CalendarEvent> {
    const row = await queryOne<Row>(
      `INSERT INTO calendar_event (user_id, title, starts_at, ends_at, location)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, starts_at, ends_at, location, source`,
      [userId, event.title, event.startsAt, event.endsAt ?? null, event.location ?? null]
    );
    if (!row) throw new Error('failed to create event');
    return toEvent(row);
  }

  /** Компенсация для createEvent: любое действие должно уметь откатываться. */
  async deleteEvent(userId: string, eventId: string): Promise<boolean> {
    const rows = await query('DELETE FROM calendar_event WHERE id = $1 AND user_id = $2 RETURNING id', [
      eventId,
      userId,
    ]);
    return rows.length > 0;
  }
}

export const calendar: CalendarPort = new LocalCalendar();
