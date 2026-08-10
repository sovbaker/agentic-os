import type { PermissionClass, ToolManifest, UISpec } from '@agentic-os/contracts';
import { query, queryOne, transaction } from '../../db/client';
import type { ExtractedFact } from '../orchestrator/llm';
import { checkQuota } from '../billing/quota';
import { deleteUser, exportUser } from '../privacy/index';
import { compose } from '../miniapps/compose';
import { createLlm } from '../orchestrator/llm';
import type { JobFamily } from '../orchestrator/llm';
import { calendar } from './calendar';
import { createSearch } from './search';
import { currentWeather } from './weather';

/**
 * Каталог инструментов.
 *
 * Класс прав — атрибут манифеста, а НЕ решение модели в рантайме и не то,
 * что прислал клиент. Проверка происходит здесь, поэтому обойти её,
 * минуя вызов, невозможно.
 */

export interface ToolContext {
  userId: string;
  specId?: string | undefined;
  jobId?: string | undefined;
  confirmed: boolean;
}

export interface UntrustedPayload {
  raw: string;
  sources?: Array<{ title: string; url?: string; snippet: string }>;
}

export interface ToolResult {
  ok: boolean;
  message?: string;
  dataPatch?: Record<string, unknown>;
  /** Мини-аппа, произведённая шагом. Публикуется клиенту исполнителем. */
  spec?: UISpec;
  facts?: ExtractedFact[];
  /**
   * Контент из недоверенного источника. НИКОГДА не возвращается вызывающему
   * напрямую: исполнитель обязан прогнать его через карантин.
   */
  untrusted?: UntrustedPayload;
  audit?: {
    humanReadable: string;
    reason: string;
    reversible: boolean;
    /** Чем откатывать. Без этого «обратимо» — просто отметка в журнале. */
    compensation?: { tool: string; args: Record<string, unknown>; specId?: string };
  };
}

interface Tool {
  manifest: ToolManifest & { internal?: boolean };
  exec: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

interface ChecklistItem {
  id: string;
  name: string;
  done: boolean;
}

const search = createSearch();
const llm = createLlm();

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

async function loadState(userId: string, specId: string): Promise<Record<string, unknown>> {
  const row = await queryOne<{ data: Record<string, unknown> }>(
    'SELECT data FROM miniapp_state WHERE user_id = $1 AND spec_id = $2',
    [userId, specId]
  );
  return row?.data ?? {};
}

async function saveState(userId: string, specId: string, data: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO miniapp_state (user_id, spec_id, data, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, spec_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [userId, specId, JSON.stringify(data)]
  );
}

/* ------------------------------------------------------------------ */
/* Пользовательские действия                                           */
/* ------------------------------------------------------------------ */

const toggleItem: Tool = {
  manifest: {
    name: 'task.toggle_item',
    description: 'Отметить или снять отметку с пункта чек-листа',
    inputSchema: { itemId: 'string' },
    permission: 'auto',
    compensation: 'task.toggle_item с тем же itemId',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 5_000,
    source: 'builtin',
  },
  async exec(ctx, args) {
    const itemId = str(args['itemId']);
    const specId = ctx.specId;
    if (!specId) return { ok: false, message: 'не указана мини-аппа' };

    return transaction(async (client) => {
      const res = await client.query<{ data: { items?: ChecklistItem[] } }>(
        'SELECT data FROM miniapp_state WHERE user_id = $1 AND spec_id = $2 FOR UPDATE',
        [ctx.userId, specId]
      );
      const data = res.rows[0]?.data ?? {};
      const items = data.items ?? [];
      const item = items.find((i) => i.id === itemId);
      if (!item) return { ok: false, message: `пункт "${itemId}" не найден` };

      item.done = !item.done;
      await client.query(
        `INSERT INTO miniapp_state (user_id, spec_id, data, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, spec_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [ctx.userId, specId, JSON.stringify({ ...data, items })]
      );

      return {
        ok: true,
        dataPatch: { items },
        audit: {
          humanReadable: `${item.done ? 'Отметил' : 'Снял отметку'}: ${item.name}`,
          reason: 'действие пользователя в мини-аппе',
          reversible: true,
          compensation: { tool: 'task.toggle_item', args: { itemId }, specId },
        },
      };
    });
  },
};

const scheduleReminder: Tool = {
  manifest: {
    name: 'reminder.schedule',
    description: 'Поставить напоминание',
    inputSchema: { afterDays: 'number', about: 'string' },
    permission: 'auto',
    compensation: 'reminder.cancel',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 5_000,
    source: 'builtin',
  },
  async exec(ctx, args) {
    const afterDays = num(args['afterDays'], 1);
    const about = str(args['about'], 'Напоминание');
    const when = new Date(Date.now() + afterDays * 24 * 3600 * 1000);

    await query(
      `INSERT INTO proactive_event (user_id, kind, title, body, job_id, score, scheduled_for)
       VALUES ($1, 'deadline', $2, $3, $4, 0.7, $5)`,
      [ctx.userId, about, `Напоминаю: ${about}`, ctx.jobId ?? null, when.toISOString()]
    );

    return {
      ok: true,
      message: `Напомню ${when.toLocaleDateString('ru-RU')}`,
      // Кнопка узнаёт о результате из данных, а не из баннера над клавиатурой.
      dataPatch: {
        reminderState: 'done',
        reminderDone: `Напомню ${when.toLocaleDateString('ru-RU')}`,
      },
      audit: {
        humanReadable: `Поставил напоминание «${about}» на ${when.toLocaleDateString('ru-RU')}`,
        reason: 'шаг плана задачи',
        reversible: true,
      },
    };
  },
};

const sendTestNotification: Tool = {
  manifest: {
    name: 'notify.send_test',
    description: 'Отправить тестовое уведомление',
    inputSchema: { text: 'string' },
    permission: 'confirm',
    compensation: 'нельзя отозвать доставленное уведомление',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 5_000,
    source: 'builtin',
  },
  async exec(ctx, args) {
    const text = str(args['text'], 'Тест');
    await query(
      `INSERT INTO proactive_event (user_id, kind, title, body, score, scheduled_for)
       VALUES ($1, 'did_for_you', $2, $3, 0.5, now())`,
      [ctx.userId, 'Тестовое уведомление', text]
    );
    return {
      ok: true,
      message: 'Отправлено',
      audit: {
        humanReadable: `Отправил тестовое уведомление: «${text}»`,
        reason: 'пользователь подтвердил отправку',
        reversible: false,
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* Источники данных мини-аппы                                          */
/* ------------------------------------------------------------------ */

function checklistSource(name: string): Tool {
  return {
    manifest: {
      name,
      description: 'Прочитать чек-лист мини-аппы',
      inputSchema: {},
      permission: 'auto',
      returnsUntrusted: false,
      costHint: 'free',
      timeoutMs: 5_000,
      source: 'builtin',
    },
    async exec(ctx) {
      if (!ctx.specId) return { ok: true, dataPatch: { items: [] } };
      const data = await loadState(ctx.userId, ctx.specId);
      return { ok: true, dataPatch: { items: data['items'] ?? [] } };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Внешний мир                                                         */
/* ------------------------------------------------------------------ */

const webSearch: Tool = {
  manifest: {
    name: 'web.search',
    description: 'Найти информацию в вебе',
    inputSchema: { q: 'string', limit: 'number' },
    permission: 'auto',
    // Ключевой флаг: исполнитель обязан прогнать результат через карантин.
    returnsUntrusted: true,
    costHint: 'cheap',
    timeoutMs: 20_000,
    source: 'builtin',
  },
  async exec(_ctx, args) {
    const q = str(args['q']);
    if (!q) return { ok: false, message: 'пустой запрос' };

    const results = await search.search(q, num(args['limit'], 3));

    // Возвращаем именно untrusted, а не message: попасть в контекст
    // с инструментами этот текст не должен ни при каких условиях.
    return {
      ok: true,
      untrusted: {
        raw: results.map((r) => `${r.title}\n${r.snippet}`).join('\n\n'),
        sources: results,
      },
    };
  },
};

const timeNow: Tool = {
  manifest: {
    name: 'time.now',
    description: 'Текущие дата и время',
    inputSchema: { timezone: 'string' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 2_000,
    source: 'builtin',
  },
  async exec(_ctx, args) {
    const timezone = str(args['timezone'], 'Europe/Moscow');
    const now = new Date();
    return {
      ok: true,
      dataPatch: {
        now: now.toISOString(),
        local: new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeStyle: 'short', timeZone: timezone }).format(now),
      },
    };
  },
};

const weatherCurrent: Tool = {
  manifest: {
    name: 'weather.current',
    description: 'Погода сейчас в городе',
    inputSchema: { city: 'string' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'cheap',
    timeoutMs: 15_000,
    source: 'builtin',
  },
  async exec(_ctx, args) {
    const city = str(args['city'], 'Москва');
    const weather = await currentWeather(city);
    if (!weather) return { ok: false, message: `не знаю погоду для «${city}»` };
    return {
      ok: true,
      message: `${weather.place}: ${weather.temperature}°C, ${weather.description}`,
      dataPatch: { weather },
    };
  },
};

const listEvents: Tool = {
  manifest: {
    name: 'calendar.list_events',
    description: 'Показать события календаря за период',
    inputSchema: { fromDays: 'number', toDays: 'number' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 10_000,
    source: 'builtin',
  },
  async exec(ctx, args) {
    const from = new Date(Date.now() + num(args['fromDays'], 0) * 86_400_000);
    const to = new Date(Date.now() + num(args['toDays'], 14) * 86_400_000);
    const events = await calendar.listEvents(ctx.userId, from.toISOString(), to.toISOString());
    return { ok: true, dataPatch: { events } };
  },
};

const createEvent: Tool = {
  manifest: {
    name: 'calendar.create_event',
    description: 'Создать событие в календаре',
    inputSchema: { title: 'string', startsAt: 'string' },
    permission: 'auto',
    compensation: 'calendar.delete_event',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 10_000,
    source: 'builtin',
  },
  async exec(ctx, args) {
    const title = str(args['title']);
    const startsAt = str(args['startsAt']);
    if (!title || !startsAt) return { ok: false, message: 'нужны title и startsAt' };

    const event = await calendar.createEvent(ctx.userId, { title, startsAt });
    return {
      ok: true,
      message: `Событие «${title}» создано`,
      dataPatch: { createdEventId: event.id },
      audit: {
        humanReadable: `Создал событие «${title}» на ${new Date(startsAt).toLocaleDateString('ru-RU')}`,
        reason: 'шаг плана задачи',
        reversible: true,
        compensation: { tool: 'calendar.delete_event', args: { eventId: event.id } },
      },
    };
  },
};

const deleteEvent: Tool = {
  manifest: {
    name: 'calendar.delete_event',
    description: 'Удалить событие календаря',
    inputSchema: { eventId: 'string' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 10_000,
    source: 'builtin',
    internal: true,
  },
  async exec(ctx, args) {
    const ok = await calendar.deleteEvent(ctx.userId, str(args['eventId']));
    return {
      ok,
      audit: {
        humanReadable: 'Отменил созданное событие',
        reason: 'компенсация шага задачи',
        reversible: false,
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* Внутренние шаги плана                                               */
/* ------------------------------------------------------------------ */

/**
 * Собирает мини-аппу из каталога. Внутренний инструмент: вызывать его
 * напрямую с клиента нельзя, иначе любой мог бы подсунуть произвольные
 * параметры сборки.
 */
const miniappCompose: Tool = {
  manifest: {
    name: 'miniapp.compose',
    description: 'Собрать мини-аппу под задачу',
    inputSchema: { family: 'string', goal: 'string', params: 'object' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'cheap',
    timeoutMs: 20_000,
    source: 'builtin',
    internal: true,
  },
  async exec(ctx, args) {
    /**
     * Генерация — платная возможность, но отказ в ней не оставляет
     * пользователя без экрана: без адаптера модели компилятор доходит до
     * каталога и эвристики, а те покрывают все пять семейств клина.
     */
    const mayGenerate = await checkQuota(ctx.userId, 'generation');

    const result = await compose(
      {
        family: str(args['family'], 'other') as JobFamily,
        goal: str(args['goal'], 'Задача'),
        params: (args['params'] as Record<string, string>) ?? {},
        locale: str(args['locale'], 'ru-RU'),
      },
      mayGenerate.allowed ? { llm } : undefined
    );

    const { spec, data } = result;

    await query(
      `INSERT INTO miniapp (id, version, user_id, title, origin, spec)
       VALUES ($1, $2, NULL, $3, $4, $5)
       ON CONFLICT (id, version) DO NOTHING`,
      [spec.id, spec.version, spec.title, spec.meta.origin, JSON.stringify(spec)]
    );
    await query(
      `INSERT INTO miniapp_state (user_id, spec_id, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, spec_id) DO NOTHING`,
      [ctx.userId, spec.id, JSON.stringify(data)]
    );

    return { ok: true, spec, dataPatch: data, message: undefined };
  },
};

/**
 * Обогащает мини-аппу тем, что нашлось. На вход приходят УЖЕ прошедшие
 * карантин структуры, а не сырой текст: исполнитель подменяет аргумент
 * перед вызовом.
 */
const miniappEnrich: Tool = {
  manifest: {
    name: 'miniapp.enrich',
    description: 'Дополнить мини-аппу найденными сведениями',
    inputSchema: { findings: 'array' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 10_000,
    source: 'builtin',
    internal: true,
  },
  async exec(ctx, args) {
    const findings = Array.isArray(args['findings']) ? args['findings'] : [];
    if (!ctx.specId) return { ok: true, message: 'нечего обогащать' };

    const data = await loadState(ctx.userId, ctx.specId);
    const next = { ...data, findings };
    await saveState(ctx.userId, ctx.specId, next);

    return {
      ok: true,
      dataPatch: { findings },
      message: findings.length > 0 ? `Добавил ${findings.length} источник(а)` : undefined,
    };
  },
};


/* ------------------------------------------------------------------ */
/* Память и передача                                                   */
/* ------------------------------------------------------------------ */

/**
 * Подтверждение факта одним тапом на «карте твоей жизни».
 * Самая дешёвая разметка, какая бывает: пользователь исправляет то,
 * что ему и так интересно исправить.
 */
const confirmFact: Tool = {
  manifest: {
    name: 'memory.confirm_fact',
    description: 'Подтвердить факт о себе',
    inputSchema: { factId: 'string' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 5_000,
    source: 'builtin',
  },
  async exec(ctx, args) {
    const factId = str(args['factId']);
    const rows = await query<{ id: string }>(
      `UPDATE fact SET confidence = 1.0, source = 'user_confirmed', observed_at = now()
        WHERE id = $1 AND user_id = $2 AND valid_to IS NULL
        RETURNING id`,
      [factId, ctx.userId]
    );
    if (rows.length === 0) return { ok: false, message: 'факт не найден' };

    return {
      ok: true,
      message: 'Запомнил',
      audit: {
        humanReadable: 'Подтверждён факт на карте жизни',
        reason: 'пользователь подтвердил на экране «что я о тебе знаю»',
        reversible: false,
      },
    };
  },
};

/**
 * Ассистированная передача — то, что в MVP занимает место эмулятора.
 *
 * Агент делает всю подготовку, последний шаг остаётся за человеком: один тап
 * по ссылке с уже подставленными параметрами. ~80% ощущаемой ценности при
 * ~5% риска, без хранения чужих учёток и без нарушения чьих-либо правил.
 */
const HANDOFF_TEMPLATES: Record<string, (p: Record<string, string>) => { url: string; fallback?: string; label: string }> = {
  route: (p) => ({
    url: `yandexmaps://maps.yandex.ru/?rtext=~${encodeURIComponent(p['to'] ?? '')}&rtt=auto`,
    fallback: `https://yandex.ru/maps/?rtext=~${encodeURIComponent(p['to'] ?? '')}`,
    label: `Маршрут: ${p['to'] ?? ''}`.trim(),
  }),
  call: (p) => ({ url: `tel:${(p['phone'] ?? '').replace(/[^\d+]/g, '')}`, label: 'Позвонить' }),
  email: (p) => ({
    url: `mailto:${p['to'] ?? ''}?subject=${encodeURIComponent(p['subject'] ?? '')}&body=${encodeURIComponent(p['body'] ?? '')}`,
    label: 'Открыть письмо',
  }),
  web: (p) => ({ url: p['url'] ?? '', label: p['label'] ?? 'Открыть' }),
};

const prepareHandoff: Tool = {
  manifest: {
    name: 'handoff.prepare',
    description: 'Подготовить переход в другое приложение с заполненными данными',
    inputSchema: { kind: 'string', params: 'object' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 5_000,
    source: 'builtin',
  },
  async exec(_ctx, args) {
    const kind = str(args['kind'], 'web');
    const template = HANDOFF_TEMPLATES[kind];
    if (!template) return { ok: false, message: `неизвестный тип перехода "${kind}"` };

    const built = template((args['params'] as Record<string, string>) ?? {});
    if (!built.url) return { ok: false, message: 'не хватает данных для перехода' };

    // Ссылку отдаём как данные: открывает её пользователь, не агент.
    return { ok: true, dataPatch: { handoff: built } };
  },
};



/**
 * Ответ на уточняющий вопрос.
 *
 * Значение приходит полезной нагрузкой экшена, а не аргументом: поле ввода
 * знает свой текст, сервер знает, какой вопрос задавал.
 */
const answerQuestion: Tool = {
  manifest: {
    name: 'task.answer',
    description: 'Ответить на уточняющий вопрос по задаче',
    inputSchema: { text: 'string' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 5_000,
    source: 'builtin',
  },
  async exec(ctx, args) {
    const text = str(args['text']).trim();
    if (!text || !ctx.jobId) return { ok: false, message: 'Нечего записывать' };

    await query(
      `UPDATE job SET status = 'running', pending_question = NULL, updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [ctx.jobId, ctx.userId]
    );
    await query(
      `INSERT INTO episode (user_id, kind, payload, job_id) VALUES ($1, 'answer', $2::jsonb, $3)`,
      [ctx.userId, JSON.stringify({ text }), ctx.jobId]
    );

    return {
      ok: true,
      message: 'Записал, продолжаю',
      audit: {
        humanReadable: `Записал твой ответ: «${text.slice(0, 60)}»`,
        reason: 'ответ на уточняющий вопрос',
        reversible: false,
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/* Ходы                                                                */
/* ------------------------------------------------------------------ */

/**
 * Подтвердить объявленное намерение.
 *
 * Потолок доверия MVP — «делает дела с подтверждением», и это его исполняющая
 * часть: задача стояла в `waiting_user` и продолжается только отсюда.
 */
const confirmMove: Tool = {
  manifest: {
    name: 'task.confirm_move',
    description: 'Подтвердить объявленное намерение агента',
    inputSchema: { moveId: 'string' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 5_000,
    source: 'builtin',
  },
  async exec(ctx, args) {
    const jobId = str(args['moveId'], ctx.jobId ?? '');
    if (!jobId) return { ok: false, message: 'Нечего подтверждать' };

    const row = await queryOne<{ id: string }>(
      `UPDATE job SET status = 'running', pending_question = NULL, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'waiting_user' RETURNING id`,
      [jobId, ctx.userId]
    );
    if (!row) return { ok: false, message: 'Это уже подтверждено' };

    return {
      ok: true,
      message: 'Понял, продолжаю',
      audit: {
        humanReadable: 'Продолжил задачу с твоего подтверждения',
        reason: 'Пользователь подтвердил объявленное намерение',
        reversible: false,
      },
    };
  },
};

/** Отменить сделанное. Отменяет ровно тем, чем записано в журнале. */
const undoMove: Tool = {
  manifest: {
    name: 'task.undo_move',
    description: 'Отменить действие агента по записи журнала',
    inputSchema: { moveId: 'string' },
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'free',
    timeoutMs: 15_000,
    source: 'builtin',
  },
  async exec(ctx, args) {
    const id = str(args['moveId']);
    const row = await queryOne<{
      compensation: { tool: string; args: Record<string, unknown>; specId?: string } | null;
      reversible_until: Date | null;
    }>(
      `SELECT compensation, reversible_until FROM audit_log
        WHERE id = $1 AND user_id = $2 AND reversed_at IS NULL`,
      [id, ctx.userId]
    );

    if (!row?.compensation) return { ok: false, message: 'Это действие нельзя отменить' };
    if (row.reversible_until && row.reversible_until.getTime() < Date.now()) {
      return { ok: false, message: 'Срок отмены истёк' };
    }

    const outcome = await execTool(
      row.compensation.tool,
      { userId: ctx.userId, specId: row.compensation.specId, jobId: ctx.jobId, confirmed: true },
      row.compensation.args
    );
    if (!outcome.ok) return { ok: false, message: 'Не получилось отменить' };

    await query('UPDATE audit_log SET reversed_at = now() WHERE id = $1', [id]);
    return { ok: true, message: 'Отменил', ...(outcome.dataPatch ? { dataPatch: outcome.dataPatch } : {}) };
  },
};

/* ------------------------------------------------------------------ */
/* Приватность                                                         */
/* ------------------------------------------------------------------ */

/**
 * Выгрузка. Инструмент не отдаёт сам файл — он готовит его и говорит, где
 * забрать: тащить весь архив жизни через ответ на нажатие кнопки означало бы
 * держать его в памяти клиента без нужды.
 */
const privacyExport: Tool = {
  manifest: {
    name: 'privacy.export',
    description: 'Собрать выгрузку всех данных пользователя',
    inputSchema: {},
    permission: 'auto',
    returnsUntrusted: false,
    costHint: 'cheap',
    timeoutMs: 30_000,
    source: 'builtin',
  },
  async exec(ctx) {
    const bundle = await exportUser(ctx.userId);
    const total = Object.values(bundle.summary).reduce((s, n) => s + n, 0);

    return {
      ok: true,
      message: `Готово: ${total} записей. Забрать — GET /v1/privacy/export`,
      audit: {
        humanReadable: 'Собрал выгрузку твоих данных',
        reason: 'Запрос на экспорт с экрана приватности',
        reversible: false,
      },
    };
  },
};

/**
 * Удаление. Класс прав `confirm` — не перестраховка: это единственное
 * действие в продукте, которое нечем компенсировать. Текст подтверждения
 * пишет сервер, потому что клиенту тут доверять нельзя.
 */
const privacyDelete: Tool = {
  manifest: {
    name: 'privacy.delete',
    description: 'Удалить все данные пользователя без возможности восстановления',
    inputSchema: {},
    permission: 'confirm',
    returnsUntrusted: false,
    costHint: 'cheap',
    timeoutMs: 30_000,
    source: 'builtin',
  },
  async exec(ctx) {
    const result = await deleteUser(ctx.userId);
    return {
      ok: result.deleted,
      message: result.deleted ? 'Всё удалено. Спасибо, что попробовал.' : 'Данные уже удалены',
      audit: {
        humanReadable: 'Удалил все твои данные',
        reason: 'Запрос на удаление с экрана приватности',
        reversible: false,
      },
    };
  },
};

/* ------------------------------------------------------------------ */

const TOOL_LIST: readonly Tool[] = [
  answerQuestion,
  confirmMove,
  undoMove,
  privacyExport,
  privacyDelete,
  toggleItem,
  scheduleReminder,
  sendTestNotification,
  webSearch,
  timeNow,
  weatherCurrent,
  listEvents,
  createEvent,
  deleteEvent,
  miniappCompose,
  miniappEnrich,
  confirmFact,
  prepareHandoff,
  checklistSource('docs.checklist'),
  checklistSource('trip.checklist'),
  checklistSource('task.checklist'),
];

export const TOOLS: ReadonlyMap<string, Tool> = new Map(TOOL_LIST.map((t) => [t.manifest.name, t]));

export const KNOWN_TOOLS: ReadonlySet<string> = new Set(TOOLS.keys());

/** Инструменты, доступные планировщику. Внутренние он тоже может ставить в план. */
export const PLANNABLE_TOOLS: readonly ToolManifest[] = TOOL_LIST.map((t) => t.manifest);

export function manifestOf(name: string): (ToolManifest & { internal?: boolean }) | null {
  return TOOLS.get(name)?.manifest ?? null;
}

export interface ExecOutcome extends ToolResult {
  needsConfirmation: boolean;
  confirmationText?: string;
  permission: PermissionClass;
}

/**
 * Единственная точка выполнения инструментов — здесь же проверка прав.
 *
 * `untrusted` наружу проходит специально: обязанность прогнать его через
 * карантин лежит на исполнителе, и нарушение этого видно в одном месте,
 * а не размазано по коду.
 */
export async function execTool(
  name: string,
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ExecOutcome> {
  const tool = TOOLS.get(name);
  if (!tool) {
    return { ok: false, message: `неизвестный инструмент "${name}"`, needsConfirmation: false, permission: 'never' };
  }

  const permission = tool.manifest.permission;

  if (permission === 'never') {
    return {
      ok: false,
      message: 'Это действие в текущей версии выполняется только вручную',
      needsConfirmation: false,
      permission,
    };
  }

  if (permission === 'confirm' && !ctx.confirmed) {
    return {
      ok: false,
      needsConfirmation: true,
      confirmationText: `Подтверди: ${tool.manifest.description.toLowerCase()}`,
      permission,
    };
  }

  const result = await tool.exec(ctx, args);

  if (result.audit) {
    await query(
      /*
       * Срок обратимости задаётся здесь, а не считается на экране: «отменить»
       * без срока однажды окажется кнопкой, которая уже ничего не отменит.
       * Шесть часов — столько, сколько человек реально возвращается к делу.
       */
      `INSERT INTO audit_log (user_id, job_id, action, human_readable, reason, permission, confirmed_by_user, reversible, compensation, reversible_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
               -- Тип параметра выводится по ПЕРВОМУ использованию, а внутри
               -- CASE его вывести не из чего: приведение обязательно.
               CASE WHEN $8::boolean AND $9::jsonb IS NOT NULL THEN now() + interval '6 hours' ELSE NULL END)`,
      [
        ctx.userId,
        ctx.jobId ?? null,
        name,
        result.audit.humanReadable,
        result.audit.reason,
        permission,
        ctx.confirmed,
        result.audit.reversible,
        result.audit.compensation ? JSON.stringify(result.audit.compensation) : null,
      ]
    );
  }

  return { ...result, needsConfirmation: false, permission };
}
