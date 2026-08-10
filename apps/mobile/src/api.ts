import { TurnEvent, type ActionResponse, type MiniAppResponse, type UIAction, type UISpec } from '@agentic-os/contracts';

/**
 * Клиент API.
 *
 * SSE читаем через XMLHttpRequest, а не EventSource: EventSource умеет только
 * GET и отсутствует в React Native, а onprogress у XHR работает одинаково
 * и в браузере, и на устройстве.
 */

export const API_URL = process.env['EXPO_PUBLIC_API_URL'] ?? 'http://localhost:8787';

let token: string | null = null;

export function setToken(value: string | null): void {
  token = value;
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function registerDevice(input: {
  platform: 'ios' | 'android' | 'web';
  deviceName?: string;
}): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${API_URL}/v1/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: input.platform,
      deviceName: input.deviceName,
      locale: 'ru-RU',
      timezone: 'Europe/Moscow',
    }),
  });
  if (!res.ok) throw new Error(`Регистрация не удалась: ${res.status}`);
  return (await res.json()) as { token: string; userId: string };
}

/**
 * Разбор потока SSE. Кадры разделены пустой строкой; нас интересует только
 * поле data — тип события всё равно продублирован внутри JSON.
 */
function parseFrames(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';

  for (const frame of parts) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        events.push(JSON.parse(payload));
      } catch {
        // Битый кадр — пропускаем: один сбой не должен обрывать поток.
      }
    }
  }
  return { events, rest };
}

/** Ошибка с кодом от сервера — по нему вызывающий решает, что показать. */
export interface ApiError extends Error {
  code?: string;
}

export function streamTurn(
  text: string,
  source: 'text' | 'voice',
  onEvent: (event: TurnEvent) => void,
  /**
   * Задача, к которой относится фраза. Без неё «а когда крайний срок?»,
   * сказанное на открытом экране задачи, приезжает на сервер как новая
   * задача: продолжения разговора не существует, потому что не с чем
   * его связать.
   */
  jobId?: string | null
): { promise: Promise<void>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  let consumed = 0;
  let buffer = '';

  const promise = new Promise<void>((resolve, reject) => {
    xhr.open('POST', `${API_URL}/v1/turns`);
    for (const [k, v] of Object.entries(headers())) xhr.setRequestHeader(k, v);

    const drain = (): void => {
      const chunk = xhr.responseText.slice(consumed);
      consumed = xhr.responseText.length;
      buffer += chunk;
      const { events, rest } = parseFrames(buffer);
      buffer = rest;
      for (const raw of events) {
        // Неизвестные события игнорируем молча: сервер выкатывается чаще,
        // чем приложение проходит ревью.
        const parsed = TurnEvent.safeParse(raw);
        if (parsed.success) onEvent(parsed.data);
      }
    };

    xhr.onprogress = drain;
    xhr.onload = () => {
      /*
       * Отказ приезжает обычным JSON, а не потоком. Разбирать его рамками
       * SSE бессмысленно: раньше такой ответ давал ноль событий и
       * `resolve()` — то есть отказ сервера («нужно согласие», «слишком
       * часто») выглядел как успешно закончившийся ход, после которого
       * ничего не появилось.
       */
      if (xhr.status >= 400) {
        let message = `Сервер ответил ${xhr.status}`;
        let code: string | undefined;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string; code?: string };
          if (body.error) message = body.error;
          code = body.code;
        } catch {
          // Тело не JSON — остаётся общий текст со статусом.
        }
        const err: ApiError = new Error(message);
        if (code) err.code = code;
        reject(err);
        return;
      }

      drain();
      resolve();
    };
    xhr.onerror = () => reject(new Error('Сеть недоступна'));
    xhr.onabort = () => resolve();
    xhr.send(JSON.stringify({ text, source, ...(jobId ? { jobId } : {}) }));
  });

  return { promise, abort: () => xhr.abort() };
}

export async function dispatchAction(
  action: Extract<UIAction, { kind: 'tool' } | { kind: 'submit' }>,
  ctx: { specId?: string; jobId?: string; confirmed?: boolean }
): Promise<ActionResponse> {
  const res = await fetch(`${API_URL}/v1/actions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      tool: action.tool,
      args: action.kind === 'tool' ? action.args : {},
      specId: ctx.specId,
      jobId: ctx.jobId,
      confirmed: ctx.confirmed ?? false,
    }),
  });
  if (!res.ok) throw new Error(`Действие не выполнено: ${res.status}`);
  return (await res.json()) as ActionResponse;
}

/* ---------------------------------------------------------------- */
/* Лента и онбординг                                                  */
/* ---------------------------------------------------------------- */

export interface FeedCard {
  kind: 'morning_brief' | 'did_for_you' | 'need_decision' | 'deadline' | 'discovery';
  title: string;
  body: string;
  jobId: string | null;
  /** Куда ведёт карточка. Без него лента — дайджест с фальшивой нажимаемостью. */
  specId: string | null;
}

export async function fetchFeed(): Promise<{ greeting: string; cards: FeedCard[] }> {
  const res = await fetch(`${API_URL}/v1/feed`, { headers: headers() });
  if (!res.ok) throw new Error(`Лента не загрузилась: ${res.status}`);
  return (await res.json()) as { greeting: string; cards: FeedCard[] };
}

export interface Archetype {
  id: string;
  label: string;
  /** Имя из закрытого набора, а не эмодзи: рисунок живёт в бинаре. */
  icon: string;
}

export async function fetchOnboarding(): Promise<{ archetypes: Archetype[]; inboxAddress: string }> {
  const res = await fetch(`${API_URL}/v1/onboarding`, { headers: headers() });
  if (!res.ok) throw new Error(`Онбординг не загрузился: ${res.status}`);
  return (await res.json()) as { archetypes: Archetype[]; inboxAddress: string };
}

export async function applyArchetypes(ids: readonly string[]): Promise<void> {
  await fetch(`${API_URL}/v1/onboarding/archetypes`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ids }),
  });
}

export async function fetchLifeMap(): Promise<MiniAppResponse> {
  const res = await fetch(`${API_URL}/v1/lifemap`, { headers: headers() });
  if (!res.ok) throw new Error(`Карта не загрузилась: ${res.status}`);
  return (await res.json()) as MiniAppResponse;
}

export async function fetchMiniApp(id: string): Promise<MiniAppResponse> {
  const res = await fetch(`${API_URL}/v1/miniapps/${encodeURIComponent(id)}`, { headers: headers() });
  if (!res.ok) throw new Error(`Мини-аппа не загрузилась: ${res.status}`);
  return (await res.json()) as MiniAppResponse;
}

export async function fetchPrivacy(): Promise<MiniAppResponse> {
  const res = await fetch(`${API_URL}/v1/privacy/screen`, { headers: headers() });
  if (!res.ok) throw new Error(`Экран приватности не загрузился: ${res.status}`);
  return (await res.json()) as MiniAppResponse;
}

/**
 * Согласие. Текст и признак «нужно ли спрашивать» приходят с сервера:
 * отметка живёт там же, где данные, и переустановка приложения её не
 * стирает — иначе человека спрашивали бы заново на каждом устройстве,
 * а доказательства согласия не было бы вовсе.
 */
export async function fetchConsent(): Promise<{ needed: boolean; version: string; spec: UISpec }> {
  const res = await fetch(`${API_URL}/v1/consent`, { headers: headers() });
  if (!res.ok) throw new Error(`Согласие не загрузилось: ${res.status}`);
  return (await res.json()) as { needed: boolean; version: string; spec: UISpec };
}

export async function acceptConsent(version: string): Promise<void> {
  const res = await fetch(`${API_URL}/v1/consent`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ version }),
  });
  if (!res.ok) throw new Error(`Согласие не записалось: ${res.status}`);
}

export async function registerPushToken(token: string): Promise<void> {
  await fetch(`${API_URL}/v1/devices/push-token`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ token }),
  });
}
