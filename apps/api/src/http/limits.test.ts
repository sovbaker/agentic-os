import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BUDGETS, Window, waitPhrase } from './limits';

/**
 * Ограничитель — чистая функция от времени, поэтому время подаётся снаружи,
 * а не берётся из часов. Тест на лимите частоты, который ждёт реальную
 * минуту, никто не запускает.
 */

test('лимит пропускает ровно столько, сколько разрешено', () => {
  const w = new Window({ limit: 3, windowMs: 1000 });

  assert.equal(w.hit('a', 0), null);
  assert.equal(w.hit('a', 10), null);
  assert.equal(w.hit('a', 20), null);
  assert.notEqual(w.hit('a', 30), null, 'четвёртый запрос обязан упереться');
});

test('окно открывается заново, а не навсегда закрывается', () => {
  const w = new Window({ limit: 1, windowMs: 1000 });

  assert.equal(w.hit('a', 0), null);
  const retry = w.hit('a', 500);
  assert.equal(retry, 1, 'ждать должно ровно до конца окна');

  assert.equal(w.hit('a', 1001), null, 'после окна счётчик начинается заново');
});

test('счётчики разных ключей не смешиваются', () => {
  const w = new Window({ limit: 1, windowMs: 1000 });

  assert.equal(w.hit('a', 0), null);
  assert.equal(w.hit('b', 0), null, 'сосед за тем же NAT не должен страдать');
  assert.notEqual(w.hit('a', 1), null);
});

test('уборка не даёт карте расти по числу когда-либо виденных ключей', () => {
  const w = new Window({ limit: 10, windowMs: 1000 });

  for (let i = 0; i < 100; i += 1) w.hit(`ip:${i}`, 0);
  assert.equal(w.size, 100);

  w.sweep(500);
  assert.equal(w.size, 100, 'живые окна трогать нельзя');

  w.sweep(1001);
  assert.equal(w.size, 0);
});

test('обещанное время ожидания совпадает с настоящим', () => {
  // Окно регистрации — час. Ответ «попробуй через минуту» с
  // `Retry-After: 3600` — не мелочь стиля, а неправда пользователю.
  assert.equal(waitPhrase(30), 'через 30 с');
  assert.equal(waitPhrase(150), 'через 3 мин');
  assert.equal(waitPhrase(3600), 'через час');
  assert.equal(waitPhrase(7200), 'через 2 ч');
});

test('бюджет хода дешевле бюджета чтения', () => {
  // Ход — единственная ручка, которая тратит деньги на модель. Если это
  // равенство когда-нибудь сломается, лимит перестанет защищать кошелёк.
  const turnPerMinute = (BUDGETS.turn.limit / BUDGETS.turn.windowMs) * 60_000;
  const readPerMinute = (BUDGETS.read.limit / BUDGETS.read.windowMs) * 60_000;

  assert.ok(turnPerMinute < readPerMinute, `${turnPerMinute} должно быть меньше ${readPerMinute}`);
});
