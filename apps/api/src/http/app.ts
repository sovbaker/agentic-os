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
import { healthcheck, query, queryOne } from '../db/client';
import { log } from '../obs/log';
import { authMiddleware, registerDevice } from './auth';
import { handleTurn } from '../modules/orchestrator/index';
import { execTool, manifestOf } from '../modules/tools/index';
import { getJob, listJobs, stepsOf } from '../modules/jobs/store';
import { cancelJob } from '../modules/jobs/runner';
import { snapshot } from '../modules/memory/graph';
import { retrieve } from '../modules/memory/retrieval';

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
    if (!parsed.success) return c.json({ error: 'Некорректный запрос', code: 'bad_request' }, 400);
    return c.json(await registerDevice(parsed.data), 201);
  });

  /* ---------------- ход разговора: SSE ---------------- */

  app.post('/v1/turns', authMiddleware, async (c) => {
    const user = c.get('user');
    const parsed = TurnRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Нужен непустой text', code: 'bad_request' }, 400);

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of handleTurn({
          userId: user.userId,
          text: parsed.data.text,
          source: parsed.data.source,
          locale: user.locale,
          jobId: parsed.data.jobId,
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
    if (!parsed.success) return c.json({ error: 'Некорректное действие', code: 'bad_request' }, 400);

    const { tool, args, jobId, specId, confirmed } = parsed.data;

    /**
     * Внутренние инструменты — шаги плана, а не кнопки. Разрешить их
     * с клиента означало бы дать любому собирать мини-аппы с произвольными
     * параметрами и вызывать компенсации в обход задачи.
     */
    const manifest = manifestOf(tool);
    if (manifest?.internal) {
      return c.json({ error: 'Этот инструмент вызывается только из плана задачи', code: 'internal_tool' }, 403);
    }

    const outcome = await execTool(tool, { userId: user.userId, specId, jobId, confirmed }, args);

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
      log.error('stored spec is invalid', { id });
      return c.json({ error: 'Мини-аппа повреждена', code: 'invalid_spec' }, 500);
    }

    return c.json({ spec: spec.data, data: state?.data ?? {} });
  });

  /* ---------------- задачи ---------------- */

  app.get('/v1/jobs', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json({ jobs: await listJobs(user.userId) });
  });

  app.get('/v1/jobs/:id', authMiddleware, async (c) => {
    const user = c.get('user');
    const jobId = c.req.param('id');
    if (!jobId) return c.json({ error: 'Нужен id задачи', code: 'bad_request' }, 400);

    const job = await getJob(jobId, user.userId);
    if (!job) return c.json({ error: 'Задача не найдена', code: 'not_found' }, 404);

    // Пользователь должен видеть, что происходит, а не только итог.
    const steps = await stepsOf(job.id);
    return c.json({
      job,
      steps: steps.map((s) => ({
        idx: s.idx,
        title: s.title,
        status: s.status,
        attempts: s.attempts,
        error: s.error ?? null,
      })),
    });
  });

  app.post('/v1/jobs/:id/cancel', authMiddleware, async (c) => {
    const user = c.get('user');
    const jobId = c.req.param('id');
    if (!jobId) return c.json({ error: 'Нужен id задачи', code: 'bad_request' }, 400);

    try {
      const result = await cancelJob(user.userId, jobId);
      return c.json({ ok: true, compensated: result.compensated });
    } catch (err) {
      return c.json({ error: (err as Error).message, code: 'cancel_failed' }, 404);
    }
  });

  /* ---------------- журнал и отмена ---------------- */

  app.get('/v1/audit', authMiddleware, async (c) => {
    const user = c.get('user');
    const rows = await query<{
      id: string;
      at: Date;
      human_readable: string;
      reason: string;
      permission: string;
      reversible: boolean;
      reversed_at: Date | null;
      compensation: unknown;
    }>(
      `SELECT id, at, human_readable, reason, permission, reversible, reversed_at, compensation
         FROM audit_log WHERE user_id = $1 ORDER BY at DESC LIMIT 50`,
      [user.userId]
    );

    return c.json({
      entries: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        what: r.human_readable,
        why: r.reason,
        permission: r.permission,
        // Отменить можно только то, для чего записано, ЧЕМ отменять.
        undoable: r.reversible && r.reversed_at === null && r.compensation !== null,
        undoneAt: r.reversed_at ? r.reversed_at.toISOString() : null,
      })),
    });
  });

  app.post('/v1/audit/:id/undo', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    const row = await queryOne<{
      compensation: { tool: string; args: Record<string, unknown>; specId?: string } | null;
      reversible: boolean;
      reversed_at: Date | null;
      job_id: string | null;
    }>('SELECT compensation, reversible, reversed_at, job_id FROM audit_log WHERE id = $1 AND user_id = $2', [
      id,
      user.userId,
    ]);

    if (!row) return c.json({ error: 'Запись не найдена', code: 'not_found' }, 404);
    if (!row.reversible || !row.compensation) {
      return c.json({ error: 'Это действие нельзя отменить', code: 'not_reversible' }, 409);
    }
    if (row.reversed_at) return c.json({ error: 'Уже отменено', code: 'already_undone' }, 409);

    const outcome = await execTool(
      row.compensation.tool,
      {
        userId: user.userId,
        specId: row.compensation.specId,
        jobId: row.job_id ?? undefined,
        // Отмена по явному запросу пользователя — подтверждение уже дано.
        confirmed: true,
      },
      row.compensation.args
    );

    if (!outcome.ok) {
      return c.json({ error: outcome.message ?? 'Не удалось отменить', code: 'undo_failed' }, 500);
    }

    await query('UPDATE audit_log SET reversed_at = now() WHERE id = $1', [id]);
    return c.json({ ok: true, ...(outcome.dataPatch ? { dataPatch: outcome.dataPatch } : {}) });
  });

  /* ---------------- память ---------------- */

  app.get('/v1/memory/snapshot', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json(await snapshot(user.userId));
  });

  app.get('/v1/memory/search', authMiddleware, async (c) => {
    const user = c.get('user');
    const intent = c.req.query('q') ?? '';
    const facts = await retrieve({ userId: user.userId, intent, limit: 10 });
    return c.json({ facts });
  });

  return app;
}
