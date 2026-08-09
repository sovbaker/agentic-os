import type { PermissionClass, ToolManifest } from '@agentic-os/contracts';
import { query, queryOne, transaction } from '../../db/client';

/**
 * Каталог инструментов.
 *
 * Класс прав — атрибут манифеста, а НЕ решение модели в рантайме и не то,
 * что прислал клиент. Проверка происходит здесь, на сервере: подменённый
 * запрос с "confirmed": true не должен обходить ограничение.
 */

export interface ToolContext {
  userId: string;
  specId?: string | undefined;
  jobId?: string | undefined;
  confirmed: boolean;
}

export interface ToolResult {
  ok: boolean;
  message?: string;
  dataPatch?: Record<string, unknown>;
  /** Человекочитаемая запись в журнал: пользователь должен понять без нас. */
  audit?: { humanReadable: string; reason: string; reversible: boolean };
}

interface Tool {
  manifest: ToolManifest;
  exec: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

interface ChecklistItem {
  id: string;
  name: string;
  done: boolean;
}

async function loadItems(userId: string, specId: string): Promise<ChecklistItem[]> {
  const row = await queryOne<{ data: { items?: ChecklistItem[] } }>(
    'SELECT data FROM miniapp_state WHERE user_id = $1 AND spec_id = $2',
    [userId, specId]
  );
  return row?.data.items ?? [];
}

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
    const itemId = String(args['itemId'] ?? '');
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
    const afterDays = Number(args['afterDays'] ?? 1);
    const about = String(args['about'] ?? 'Напоминание');
    const when = new Date(Date.now() + afterDays * 24 * 3600 * 1000);

    await query(
      `INSERT INTO proactive_event (user_id, kind, title, body, job_id, score, scheduled_for)
       VALUES ($1, 'deadline', $2, $3, $4, 0.7, $5)`,
      [ctx.userId, about, `Напоминаю: ${about}`, ctx.jobId ?? null, when.toISOString()]
    );

    return {
      ok: true,
      message: `Напомню ${when.toLocaleDateString('ru-RU')}`,
      audit: {
        humanReadable: `Поставил напоминание «${about}» на ${when.toLocaleDateString('ru-RU')}`,
        reason: 'пользователь нажал кнопку напоминания',
        reversible: true,
      },
    };
  },
};

/**
 * Инструменты-источники данных для dataSources мини-аппы.
 * Только чтение — состояние живёт в miniapp_state.
 */
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
      return { ok: true, dataPatch: { items: await loadItems(ctx.userId, ctx.specId) } };
    },
  };
}

/**
 * Заглушка веб-поиска. Помечена returnsUntrusted: всё, что она вернёт,
 * обязано пройти через карантинный экстрактор и никогда не попадать
 * напрямую в контекст планировщика, у которого есть инструменты.
 */
const webSearch: Tool = {
  manifest: {
    name: 'web.search',
    description: 'Поиск в вебе',
    inputSchema: { q: 'string' },
    permission: 'auto',
    returnsUntrusted: true,
    costHint: 'cheap',
    timeoutMs: 20_000,
    source: 'builtin',
  },
  async exec(_ctx, args) {
    return { ok: true, message: `Поиск «${String(args['q'] ?? '')}» будет подключён в S1` };
  },
};

/** Демонстрирует контур подтверждения: класс confirm без тапа не выполняется. */
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
    const text = String(args['text'] ?? 'Тест');
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

const TOOL_LIST: readonly Tool[] = [
  toggleItem,
  scheduleReminder,
  webSearch,
  sendTestNotification,
  checklistSource('docs.checklist'),
  checklistSource('trip.checklist'),
  checklistSource('task.checklist'),
];

export const TOOLS: ReadonlyMap<string, Tool> = new Map(TOOL_LIST.map((t) => [t.manifest.name, t]));

export const KNOWN_TOOLS: ReadonlySet<string> = new Set(TOOLS.keys());

export function manifestOf(name: string): ToolManifest | null {
  return TOOLS.get(name)?.manifest ?? null;
}

export interface ExecOutcome extends ToolResult {
  needsConfirmation: boolean;
  confirmationText?: string;
  permission: PermissionClass;
}

/**
 * Единственная точка выполнения инструментов. Здесь же — проверка прав,
 * поэтому обойти её, минуя вызов, невозможно.
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
      `INSERT INTO audit_log (user_id, job_id, action, human_readable, reason, permission, confirmed_by_user, reversible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ctx.userId,
        ctx.jobId ?? null,
        name,
        result.audit.humanReadable,
        result.audit.reason,
        permission,
        ctx.confirmed,
        result.audit.reversible,
      ]
    );
  }

  return { ...result, needsConfirmation: false, permission };
}
