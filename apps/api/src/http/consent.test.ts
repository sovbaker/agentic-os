import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { close, query } from '../db/client';
import { CONSENT_VERSION } from '../modules/privacy/consent';
import { createApp } from './app';

/**
 * Согласие проверяется на сервере, а не только экраном в клиенте.
 *
 * Экран можно не показать: старая сборка, ошибка в условии, прямой
 * запрос из curl. Если запрет живёт только там, то слова человека уедут
 * в модель без его согласия — и доказывать, что так не было, придётся нам.
 *
 * Поэтому тест ходит в HTTP, а не в функцию: проверяется именно дверь.
 */

const hasDb = Boolean(process.env['DATABASE_URL']);
const users: string[] = [];

after(async () => {
  if (hasDb) for (const id of users) await query('DELETE FROM app_user WHERE id = $1', [id]);
  await close();
});

async function register(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await app.request('/v1/devices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', locale: 'ru-RU', timezone: 'Europe/Moscow' }),
  });
  assert.equal(res.status, 201);

  const body = (await res.json()) as { token: string; userId: string };
  users.push(body.userId);
  return body.token;
}

test('до согласия ход не принимается', { skip: !hasDb }, async () => {
  const app = createApp();
  const token = await register(app);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const res = await app.request('/v1/turns', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'продлить визу в Италию к октябрю', source: 'text' }),
  });

  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'consent_required');
});

test('согласие спрашивается один раз и запоминается на сервере', { skip: !hasDb }, async () => {
  const app = createApp();
  const token = await register(app);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const before = (await (await app.request('/v1/consent', { headers: auth })).json()) as {
    needed: boolean;
    version: string;
    spec: { id: string };
  };
  assert.equal(before.needed, true);
  assert.equal(before.version, CONSENT_VERSION);
  assert.equal(before.spec.id, 'consent', 'текст согласия приходит с сервера, а не зашит в клиент');

  // Чужая редакция не засчитывается: человек согласился бы с другим текстом.
  const stale = await app.request('/v1/consent', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ version: '2000-01-1' }),
  });
  assert.equal(stale.status, 409);

  const ok = await app.request('/v1/consent', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ version: CONSENT_VERSION }),
  });
  assert.equal(ok.status, 200);

  const after = (await (await app.request('/v1/consent', { headers: auth })).json()) as { needed: boolean };
  assert.equal(after.needed, false, 'повторно спрашивать нельзя');
});

test('переустановка приложения не стирает согласие', { skip: !hasDb }, async () => {
  const app = createApp();
  const token = await register(app);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  await app.request('/v1/consent', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ version: CONSENT_VERSION }),
  });

  // Новый экземпляр приложения — то же, что новый процесс сервера:
  // отметка лежит в базе, а не в памяти и не в телефоне.
  const fresh = createApp();
  const again = (await (await fresh.request('/v1/consent', { headers: auth })).json()) as { needed: boolean };
  assert.equal(again.needed, false);
});
