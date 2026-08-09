import { migrate, vectorSearchAvailable } from './migrate';
import { close } from './client';
import { log } from '../obs/log';

/** Отдельная точка входа: миграции гоняются в деплое до старта приложения. */
migrate()
  .then(async () => {
    log.info('миграции применены', { vectorSearch: await vectorSearchAvailable() });
    await close();
  })
  .catch(async (err: unknown) => {
    log.error('миграции не применились', { error: (err as Error).message });
    await close();
    process.exit(1);
  });
