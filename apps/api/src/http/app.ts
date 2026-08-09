import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  ActionRequest,
  RegisterDeviceRequest,
  TurnRequest,
  UISpec,
  type ActionResponse,
} from '@agentic-os/contracts';
import { healthcheck, queryOne } from '../db/client';
import { log } from '../obs/log';
import { authMiddleware, registerDevice } from './auth';
import { handleTurn } from '../modules/orchestrator/index';
import { execTool } from '../modules/tools/index';
import { listJobs } from '../modules/jobs/store';
import { snapshot } from '../modules/memory/graph';

export function createApp(): Hono {
  const app = new Hono();

  app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }));

  app.onError((err, c) => {
    log.error('unhandled request error', { error: err.message, path: c.req.path });
    return c.json({ error: 'Внутренняя ошибка', code: 'internal' }, 500);
  });

  app.get('/health', async (c) => {
    const db = await healthcheck();
    return c.json({ ok: db, db }, db ? 200 : 503);
  });

  /* ---------------- регистрация устройства ---------------- */

  app.post('/v1/devices', async (c) => {
    const parsed = RegisterDeviceRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'Некорректный запрос', code: 'bad_request' }, 400);
    }
    const result = await registerDevice(parsed.data);
    return c.json(result, 201);
  });

  /* ---------------- ход разговора: SSE ---------------- */

  app.post('/v1/turns', authMiddleware, async (c) => {
    const user = c.get('user');
    const parsed = TurnRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'Нужен непустой text', code: 'bad_request' }, 400);
    }

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of handleTurn({
          userId: user.userId,
          text: parsed.data.text,
          source: parsed.data.source,
          locale: user.locale,
        })) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        }
      } catch (err) {
        log.error('turn failed', { error: (err as Error).message });
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ type: 'error', code: 'turn_failed', text: 'Не удалось обработать запрос' }),
        });
      }
    });
  });

  /* ---------------- действия из интерфейса ---------------- */

  app.post('/v1/actions', authMiddleware, async (c) => {
    const user = c.get('user');
    const parsed = ActionRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'Некорректное действие', code: 'bad_request' }, 400);
    }
    const { tool, args, jobId, specId, confirmed } = parsed.data;

    const outcome = await execTool(
      tool,
      { userId: user.userId, specId, jobId, confirmed },
      args
    );

    const body: ActionResponse = {
      ok: outcome.ok,
      needsConfirmation: outcome.needsConfirmation,
      ...(outcome.confirmationText ? { confirmationText: outcome.confirmationText } : {}),
      ...(outcome.dataPatch ? { dataPatch: outcome.dataPatch } : {}),
      ...(outcome.message ? { message: outcome.message } : {}),
    };
    return c.json(body);
  });

  /* ---------------- мини-аппы ---------------- */

  app.get('/v1/miniapps/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    const row = await queryOne<{ spec: unknown }>(
      'SELECT spec FROM miniapp WHERE id = $1 ORDER BY version DESC LIMIT 1',
      [id]
    );
    if (!row) return c.json({ error: 'Мини-аппа не найдена', code: 'not_found' }, 404);

    const state = await queryOne<{ data: Record<string, unknown> }>(
      'SELECT data FROM miniapp_state WHERE user_id = $1 AND spec_id = $2',
      [user.userId, id]
    );

    const spec = UISpec.safeParse(row.spec);
    if (!spec.success) {
      // Спека в базе не проходит текущую схему — это баг у нас, а не у клиента.
      log.error('stored spec is invalid', { id });
      return c.json({ error: 'Мини-аппа повреждена', code: 'invalid_spec' }, 500);
    }

    return c.json({ spec: spec.data, data: state?.data ?? {} });
  });

  /* ---------------- задачи и память ---------------- */

  app.get('/v1/jobs', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json({ jobs: await listJobs(user.userId) });
  });

  app.get('/v1/memory/snapshot', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json(await snapshot(user.userId));
  });

  return app;
}
