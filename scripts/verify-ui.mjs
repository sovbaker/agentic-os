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
  await page.screenshot({ path: `${OUT}/01-home-${scheme}.png` });

  console.log(`[${scheme}] фраза → мини-аппа`);
  await page.getByText('Надо оформить визу в Италию к октябрю').click();
  await page.getByText('Виза: Италия', { exact: false }).waitFor({ timeout: 20_000 });

  check('заголовок мини-аппы отрендерен', await page.getByText('Виза: Италия').isVisible());
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

  console.log(`[${scheme}] подтверждение необратимого действия`);
  await page.getByText('Напомнить через 2 дня').click();
  await page.waitForTimeout(1000);
  check('напоминание поставлено без лишнего подтверждения (класс auto)',
    await page.getByText('Напомню', { exact: false }).isVisible());
  await page.screenshot({ path: `${OUT}/04-reminder-${scheme}.png` });

  // Скриншот-тест реестра: все 49 компонентов на одном экране.
  console.log(`[${scheme}] реестр компонентов`);
  await page.goto(`http://localhost:${PORT}/?dev=registry`, { waitUntil: 'networkidle' });
  await page.getByText('Реестр компонентов').first().waitFor({ timeout: 15_000 });
  check('реестр отрендерился целиком', await page.getByText('Действия и состояния').isVisible());
  await page.screenshot({ path: `${OUT}/05-registry-${scheme}.png`, fullPage: true });

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
