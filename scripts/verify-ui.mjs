import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

/**
 * Визуальная проверка рендерера в настоящем браузере.
 *
 * Прогоняет весь контур: фраза → SSE → UISpec → рендер → тап по чек-листу →
 * действие на сервере → обновлённые данные. Это дешёвая замена ручному
 * прокликиванию и основа для скриншот-тестов реестра компонентов в S2.
 *
 * Требует запущенного API на :8787 и собранного веба (expo export).
 */

const DIST = new URL('../apps/mobile/dist/', import.meta.url).pathname;
const OUT = process.argv[2] ?? '/tmp';
const PORT = 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    const body = await readFile(join(DIST, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(await readFile(join(DIST, 'index.html')));
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const failures = [];
const check = (name, condition) => {
  console.log(`${condition ? '  ✓' : '  ✗'} ${name}`);
  if (!condition) failures.push(name);
};

async function run(scheme) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  console.log(`\n[${scheme}] стартовый экран`);
  check('заголовок онбординга виден', await page.getByText('Что тебя сейчас грузит?').isVisible());
  // Первый запуск показывает одно решение, остальное — за раскрытием.
  check('первый запуск не заваливает вариантами', !(await page.getByText('Что я о тебе знаю').isVisible()));
  await page.getByText('Ещё', { exact: true }).click();
  check('вход в карту жизни есть', await page.getByText('Что я о тебе знаю').isVisible());
  // Обход restricted scope: адрес для пересылки настраивает сам пользователь.
  check('адрес для пересылки показан', await page.getByText('@in.', { exact: false }).isVisible());
  await page.screenshot({ path: `${OUT}/01-home-${scheme}.png`, fullPage: true });

  console.log(`[${scheme}] карта жизни`);
  await page.getByText('Что я о тебе знаю').click();
  await page.getByText('Карта твоей жизни').waitFor({ timeout: 15_000 });
  check('карта жизни открывается', await page.getByText('Карта твоей жизни').isVisible());
  // Шапка и возврат: раньше каждый серверный экран был дверью в одну сторону.
  check('в шапке заголовок экрана', await page.getByText('Что я о тебе знаю').first().isVisible());
  await page.getByLabel('Назад').click();
  await page.getByText('Что тебя сейчас грузит?').waitFor({ timeout: 10_000 });
  check('возврат работает', await page.getByText('Что тебя сейчас грузит?').isVisible());
  await page.screenshot({ path: `${OUT}/06-lifemap-${scheme}.png`, fullPage: true });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  console.log(`[${scheme}] данные и приватность`);
  await page.getByText('Ещё', { exact: true }).click();
  await page.getByText('Данные и приватность').click();
  await page.getByText('Что я о тебе храню').waitFor({ timeout: 15_000 });
  check('экран приватности открывается', await page.getByText('Что я о тебе храню').isVisible());
  // Обещание «недоверенное лежит отдельно» должно быть видно пользователю,
  // а не только в архитектурной схеме.
  check('карантин показан отдельно', await page.getByText('Недоверенное — отдельно').isVisible());
  check('расход показан в рублях', await page.getByText('Потрачено на модели').isVisible());
  check('удаление доступно', await page.getByText('Удалить все мои данные').isVisible());
  // Сетка 2×2 с зазором 4: раньше проценты складывались с пиксельным gap
  // и сетка молча схлопывалась в одну колонку.
  // Правило пустого прибора: на пустом аккаунте вместо стены нулей — фраза.
  check('пустой прибор не печатает нули',
    await page.getByText('Пока ничего', { exact: false }).isVisible());
  const statsPerRow = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('div')].filter((d) => /Фактов о тебе|Записей в дневнике/.test(d.textContent ?? ''));
    const tops = new Set(nodes.map((n) => Math.round(n.getBoundingClientRect().top)));
    return nodes.length > 0 ? nodes.length - tops.size + 1 : 0;
  });
  check('сетка приватности не схлопнулась в колонку', statsPerRow >= 2 || statsPerRow === 0);
  await page.screenshot({ path: `${OUT}/07-privacy-${scheme}.png`, fullPage: true });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

  console.log(`[${scheme}] фраза → мини-аппа`);
  await page.getByText('Надо оформить визу в Италию к октябрю').click();
  await page.getByRole('heading', { name: 'Виза: Италия' }).waitFor({ timeout: 20_000 });

  check('заголовок мини-аппы отрендерен', await page.getByRole('heading', { name: 'Виза: Италия' }).isVisible());
  check('шапка показывает, где ты', await page.getByText('Виза: Италия').first().isVisible());
  check('срок распознан и показан', await page.getByText('Успеть к: октябрь 2026').isVisible());
  // Проверяем все пункты: repeat обязан развернуться целиком, а не частично.
  const expected = ['Загранпаспорт', 'Фото 35×45 мм', 'Страховка', 'Подтверждение проживания', 'Выписка со счёта', 'Заполненная анкета'];
  const visible = [];
  for (const name of expected) {
    if (await page.getByText(name, { exact: false }).first().isVisible()) visible.push(name);
  }
  check(`чек-лист развернулся из repeat (${visible.length}/${expected.length})`, visible.length === expected.length);
  check('карточка «первый шаг» на месте', await page.getByText('Первый шаг сегодня').isVisible());
  await page.screenshot({ path: `${OUT}/02-miniapp-${scheme}.png` });

  console.log(`[${scheme}] тап по пункту → действие на сервере`);
  const item = page.getByText('Фото 35×45 мм, 2 шт');
  await item.click();
  // Отметка приходит с сервера: ждём, пока применится обновление данных.
  await page.waitForTimeout(1200);
  const decoration = await item.evaluate((el) => getComputedStyle(el).textDecorationLine);
  check('пункт отмечен после ответа сервера', decoration.includes('line-through'));
  await page.screenshot({ path: `${OUT}/03-checked-${scheme}.png` });

  console.log(`[${scheme}] состояние закрытого действия`);
  /*
   * План для задачи со сроком уже ставит напоминание сам, поэтому кнопка
   * приезжает в состоянии «сделано». Раньше она оставалась активной и
   * приглашала нажать второй раз — то есть создать ВТОРОЕ напоминание
   * без единого признака, что первое уже есть.
   */
  check('действие агента показано как выполненное',
    await page.getByText('Напомню', { exact: false }).first().isVisible());
  check('кнопка не приглашает продублировать сделанное',
    !(await page.getByText('Напомнить через 2 дня').isVisible()));
  await page.screenshot({ path: `${OUT}/04-reminder-${scheme}.png` });

  // Скриншот-тест реестра: все 53 компонента на одном экране.
  console.log(`[${scheme}] реестр компонентов`);
  await page.goto(`http://localhost:${PORT}/?dev=registry`, { waitUntil: 'networkidle' });
  await page.getByText('Реестр компонентов').first().waitFor({ timeout: 15_000 });
  check('реестр отрендерился целиком', await page.getByText('Действия и состояния').isVisible());
  await page.screenshot({ path: `${OUT}/05-registry-${scheme}.png`, fullPage: true });

  console.log(`[${scheme}] цели касания и узкий экран`);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  const small = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[role="button"], [role="checkbox"], [role="link"], [role="switch"], [role="radio"], input')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < 44) out.push(`${(el.textContent ?? el.tagName).slice(0, 24)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  });
  check(`все цели ≥44pt (${small.length} нарушений)`, small.length === 0);
  if (small.length) console.log('    ', small.slice(0, 5));

  await page.setViewportSize({ width: 320, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`нет горизонтального переполнения на 320px (${overflow}px)`, overflow <= 0);
  await page.setViewportSize({ width: 390, height: 844 });

  check('ошибок в консоли нет', errors.length === 0);
  if (errors.length) console.log('    ', errors.slice(0, 3));

  await context.close();
}

await run('light');
await run('dark');

await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `ПРОВАЛЕНО: ${failures.length}`}`);
process.exit(failures.length === 0 ? 0 : 1);
