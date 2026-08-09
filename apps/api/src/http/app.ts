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
import { feed, runFor } from '../modules/proactive/index';
import { recordReaction, type EventKind } from '../modules/proactive/policy';
import { ARCHETYPES, applyArchetypes } from '../modules/onboarding/archetypes';
import { buildLifeMap } from '../modules/onboarding/lifemap';
import { ensureInboxKey, importIcs, ingestEmail, factsFromCalendar } from '../modules/connectors/inbound';
import { monthSpendRub } from '../modules/billing/cost';
import { PLANS, TASK_BUDGET_RUB, checkQuota, getPlan } from '../modules/billing/quota';
import { deleteUser, exportUser, privacySummary } from '../modules/privacy/index';
import { buildPrivacyScreen } from '../modules/privacy/screen';
import * as metrics from '../modules/metrics/index';

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

  /* ---------------- лента «Сегодня» и проактивность ---------------- */

  app.get('/v1/feed', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json(await feed(user.userId));
  });

  /** Ручной прогон сканера — для отладки и для эвалов. */
  app.post('/v1/proactive/run', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json({ delivered: await runFor(user.userId) });
  });

  app.post('/v1/proactive/:id/reaction', authMiddleware, async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { reaction?: string };
    const reaction = body.reaction;

    if (reaction !== 'opened' && reaction !== 'ignored' && reaction !== 'muted_class') {
      return c.json({ error: 'reaction: opened | ignored | muted_class', code: 'bad_request' }, 400);
    }

    const row = await queryOne<{ kind: EventKind }>(
      'UPDATE proactive_event SET reaction = $3 WHERE id = $1 AND user_id = $2 RETURNING kind',
      [id, user.userId, reaction]
    );
    if (!row) return c.json({ error: 'Событие не найдено', code: 'not_found' }, 404);

    // Игнор — сильный сигнал: он обязан снижать частоту этого класса.
    await recordReaction(user.userId, row.kind, reaction);
    return c.json({ ok: true });
  });

  app.post('/v1/devices/push-token', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (!body.token) return c.json({ error: 'Нужен token', code: 'bad_request' }, 400);

    await query('UPDATE device SET push_token = $2 WHERE id = $1', [user.deviceId, body.token]);
    return c.json({ ok: true });
  });

  /* ---------------- онбординг ---------------- */

  app.get('/v1/onboarding', authMiddleware, async (c) => {
    const user = c.get('user');
    const inboxKey = await ensureInboxKey(user.userId);
    return c.json({
      archetypes: ARCHETYPES.map((a) => ({ id: a.id, label: a.label, glyph: a.glyph })),
      // Адрес для пересылки: подключение почты без единой верификации.
      inboxAddress: `u+${inboxKey}@${process.env['INBOUND_DOMAIN'] ?? 'in.localhost'}`,
    });
  });

  app.post('/v1/onboarding/archetypes', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === 'string') : [];

    return c.json({ ok: true, factsWritten: await applyArchetypes(user.userId, ids) });
  });

  app.get('/v1/lifemap', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json(await buildLifeMap(user.userId));
  });

  /* ---------------- входящие данные ---------------- */

  /**
   * Приём пересланной почты. Аутентификация по общему секрету, а не по
   * пользователю: письмо приходит от почтового шлюза, а не из приложения.
   */
  app.post('/v1/inbound/email', async (c) => {
    const secret = process.env['INBOUND_SECRET'];
    if (secret && c.req.header('x-inbound-secret') !== secret) {
      return c.json({ error: 'Нет доступа', code: 'unauthorized' }, 401);
    }

    const body = (await c.req.json().catch(() => ({}))) as { to?: string; from?: string; subject?: string; text?: string };
    if (!body.to || !body.text) return c.json({ error: 'Нужны to и text', code: 'bad_request' }, 400);

    const result = await ingestEmail({ to: body.to, from: body.from, subject: body.subject, text: body.text });
    return c.json(result, result.accepted ? 200 : 404);
  });

  app.post('/v1/import/ics', authMiddleware, async (c) => {
    const user = c.get('user');
    const source = await c.req.text();
    if (!source.includes('BEGIN:VEVENT')) {
      return c.json({ error: 'Это не похоже на .ics', code: 'bad_request' }, 400);
    }

    const result = await importIcs(user.userId, source);
    const facts = await factsFromCalendar(user.userId);
    return c.json({ ...result, factsWritten: facts });
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

  /* ---------------- тариф, расход, приватность ---------------- */

  app.get('/v1/usage', authMiddleware, async (c) => {
    const user = c.get('user');
    const [plan, spent, quota] = await Promise.all([
      getPlan(user.userId),
      monthSpendRub(user.userId),
      checkQuota(user.userId, 'task'),
    ]);

    return c.json({
      plan,
      tasks: { used: quota.used ?? 0, limit: quota.limit ?? null },
      // Расход показываем самому пользователю в рублях, а не в токенах:
      // токены — наша единица учёта, а не его.
      spendRubMonth: Number(spent.toFixed(2)),
      taskBudgetRub: TASK_BUDGET_RUB,
      features: { generation: PLANS[plan].generation, proactive: PLANS[plan].proactive },
    });
  });

  /**
   * Экран приватности: что о тебе хранится, одним взглядом.
   *
   * Отдельный счётчик у карантина не для красоты — он показывает, что
   * недоверенный текст лежит отдельно и не смешан с тем, что мы считаем
   * знанием о пользователе.
   */
  app.get('/v1/privacy', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json(await privacySummary(user.userId));
  });

  /** Тот же экран, но как UISpec: формулировки правятся без релиза. */
  app.get('/v1/privacy/screen', authMiddleware, async (c) => {
    const user = c.get('user');
    return c.json(await buildPrivacyScreen(user.userId));
  });

  app.get('/v1/privacy/export', authMiddleware, async (c) => {
    const user = c.get('user');
    const bundle = await exportUser(user.userId);

    c.header('Content-Disposition', `attachment; filename="agentic-os-export.json"`);
    return c.json(bundle);
  });

  /**
   * Удаление. Требует явного подтверждения в теле запроса: необратимое
   * действие не должно срабатывать от случайного POST — это ровно тот
   * случай, ради которого в продукте вообще есть подтверждения.
   */
  app.post('/v1/privacy/delete', authMiddleware, async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown };
    if (body.confirm !== true) {
      return c.json({ error: 'Нужно подтверждение: {"confirm": true}', code: 'confirmation_required' }, 400);
    }

    const result = await deleteUser(user.userId);
    return c.json(result, result.deleted ? 200 : 404);
  });

  /* ---------------- продуктовые метрики ---------------- */

  /**
   * Данные по всем пользователям, поэтому за отдельным токеном, а не за
   * пользовательской сессией. Без токена в окружении ручка не существует:
   * забытая переменная не должна оборачиваться открытой аналитикой.
   */
  app.get('/v1/metrics', async (c) => {
    const token = process.env['METRICS_TOKEN'];
    if (!token || c.req.header('x-metrics-token') !== token) {
      return c.json({ error: 'Нет доступа', code: 'unauthorized' }, 401);
    }
    return c.json(await metrics.snapshot());
  });

  return app;
}
