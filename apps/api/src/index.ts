import { serve } from '@hono/node-server';
import { config } from './config';
import { createApp } from './http/app';
import { migrate, vectorSearchAvailable } from './db/migrate';
import { close, healthcheck } from './db/client';
import { log } from './obs/log';
import { CATALOG } from './modules/miniapps/catalog';
import { validateSpec } from './modules/miniapps/validate';
import { KNOWN_TOOLS } from './modules/tools/index';

/**
 * Самопроверка каталога на старте.
 *
 * Сломанная мини-аппа должна ронять деплой, а не показываться пользователю.
 * Это дешевле любого мониторинга: ошибка не доезжает до продакшена вообще.
 */
function verifyCatalog(): void {
  const sample = { goal: 'проверка', params: { country: 'Италия' }, locale: config.defaultLocale };
  for (const entry of CATALOG) {
    const result = validateSpec(entry.build(sample), { knownTools: KNOWN_TOOLS });
    if (!result.ok) {
      throw new Error(
        `Каталожная мини-аппа "${entry.id}" не проходит валидацию: ` +
          JSON.stringify([...result.errors, ...result.budgetExceeded])
      );
    }
  }
  log.info('каталог проверен', { entries: CATALOG.length });
}

async function main(): Promise<void> {
  if (!(await healthcheck())) {
    throw new Error(`Нет соединения с базой: ${config.databaseUrl.replace(/:[^:@]*@/, ':***@')}`);
  }

  await migrate();
  const vector = await vectorSearchAvailable();
  verifyCatalog();

  const server = serve({ fetch: createApp().fetch, port: config.port }, (info) => {
    log.info('api запущен', {
      port: info.port,
      env: config.nodeEnv,
      vectorSearch: vector,
      llm: config.anthropicApiKey ? 'anthropic' : 'rule',
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`получен ${signal}, останавливаюсь`);
    server.close();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('старт не удался', { error: (err as Error).message });
  process.exit(1);
});
