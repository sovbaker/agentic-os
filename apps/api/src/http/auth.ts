import { createHash, randomBytes } from 'node:crypto';
import type { Context, Next } from 'hono';
import { config } from '../config';
import { queryOne, query } from '../db/client';

/**
 * Аутентификация устройства.
 *
 * В базе лежит только хэш токена: утечка дампа не должна давать доступ
 * к аккаунтам. Полноценный вход (Sign in with Apple) — в S3, здесь ровно
 * столько, сколько нужно, чтобы у данных был владелец с первого дня.
 */

export interface AuthedUser {
  userId: string;
  deviceId: string;
  locale: string;
  timezone: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthedUser;
  }
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

export async function registerDevice(input: {
  platform: 'ios' | 'android' | 'web';
  deviceName?: string | undefined;
  locale: string;
  timezone: string;
}): Promise<{ token: string; userId: string; deviceId: string }> {
  const user = await queryOne<{ id: string }>(
    'INSERT INTO app_user (locale, timezone, plan) VALUES ($1, $2, $3) RETURNING id',
    [input.locale, input.timezone, config.defaultPlan]
  );
  if (!user) throw new Error('failed to create user');

  const token = randomBytes(32).toString('base64url');
  const device = await queryOne<{ id: string }>(
    'INSERT INTO device (user_id, platform, device_name, token_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [user.id, input.platform, input.deviceName ?? null, hash(token)]
  );
  if (!device) throw new Error('failed to create device');

  return { token, userId: user.id, deviceId: device.id };
}

export async function authMiddleware(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return c.json({ error: 'Требуется токен устройства', code: 'unauthorized' }, 401);
  }

  const row = await queryOne<{
    device_id: string;
    user_id: string;
    locale: string;
    timezone: string;
  }>(
    `SELECT d.id AS device_id, u.id AS user_id, u.locale, u.timezone
       FROM device d JOIN app_user u ON u.id = d.user_id
      WHERE d.token_hash = $1`,
    [hash(token)]
  );

  if (!row) {
    return c.json({ error: 'Токен не найден', code: 'unauthorized' }, 401);
  }

  c.set('user', {
    userId: row.user_id,
    deviceId: row.device_id,
    locale: row.locale,
    timezone: row.timezone,
  });

  // Не ждём запись: обновление last_seen не должно добавлять задержку ответу.
  void query('UPDATE device SET last_seen_at = now() WHERE id = $1', [row.device_id]).catch(() => {});

  await next();
}
