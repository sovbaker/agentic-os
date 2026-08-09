import { query } from '../../db/client';
import { log } from '../../obs/log';

/**
 * Порт пушей.
 *
 * На iOS фоновой работы фактически нет, поэтому пуш — единственный канал
 * проактивности, и от его качества напрямую зависит удержание. Отправка
 * идёт через Expo Push API: он же покрывает APNs и FCM, что для решения D1
 * (РФ первым, глобал в архитектуре) важнее, чем прямая интеграция.
 */

export interface PushMessage {
  title: string;
  body: string;
  eventId?: string;
}

export interface PushPort {
  readonly name: string;
  send(tokens: readonly string[], message: PushMessage): Promise<{ sent: number }>;
}

/** Адаптер для разработки и тестов: пуши видно в логах, ничего не улетает. */
export class ConsolePush implements PushPort {
  readonly name = 'console';
  async send(tokens: readonly string[], message: PushMessage): Promise<{ sent: number }> {
    log.info('push (console)', { tokens: tokens.length, title: message.title });
    return { sent: tokens.length };
  }
}

export class ExpoPush implements PushPort {
  readonly name = 'expo';

  async send(tokens: readonly string[], message: PushMessage): Promise<{ sent: number }> {
    if (tokens.length === 0) return { sent: 0 };
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(
          tokens.map((to) => ({
            to,
            title: message.title,
            body: message.body,
            sound: 'default',
            data: message.eventId ? { eventId: message.eventId } : {},
          }))
        ),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`push ${res.status}`);
      return { sent: tokens.length };
    } catch (err) {
      // Недоставленный пуш не должен ронять задачу, которая его породила.
      log.warn('пуш не отправлен', { error: (err as Error).message });
      return { sent: 0 };
    }
  }
}

export const push: PushPort = process.env['EXPO_PUSH_ENABLED'] === '1' ? new ExpoPush() : new ConsolePush();

export async function sendPush(userId: string, message: PushMessage): Promise<void> {
  const rows = await query<{ push_token: string }>(
    'SELECT push_token FROM device WHERE user_id = $1 AND push_token IS NOT NULL',
    [userId]
  );
  await push.send(rows.map((r) => r.push_token), message);
}
