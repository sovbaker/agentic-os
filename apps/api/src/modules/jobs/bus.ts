import { EventEmitter } from 'node:events';
import type { TurnEvent } from '@agentic-os/contracts';

/**
 * Шина событий задачи.
 *
 * Задача живёт дольше, чем HTTP-соединение: пользователь получает поток
 * ровно столько, сколько держит экран, а работа продолжается и после того,
 * как он его закрыл. Поэтому шина — способ ПОДСМОТРЕТЬ за исполнением,
 * а не канал управления им. Источник правды всегда база.
 *
 * В памяти процесса — осознанно: терять эти события не страшно, в отличие
 * от состояния задачи.
 */

const emitters = new Map<string, EventEmitter>();

function emitterFor(jobId: string): EventEmitter {
  let emitter = emitters.get(jobId);
  if (!emitter) {
    emitter = new EventEmitter();
    // Наблюдателей может быть несколько (несколько устройств пользователя).
    emitter.setMaxListeners(20);
    emitters.set(jobId, emitter);
  }
  return emitter;
}

export function publish(jobId: string, event: TurnEvent): void {
  emitterFor(jobId).emit('event', event);
}

export function subscribe(jobId: string, listener: (event: TurnEvent) => void): () => void {
  const emitter = emitterFor(jobId);
  emitter.on('event', listener);
  return () => {
    emitter.off('event', listener);
    if (emitter.listenerCount('event') === 0) emitters.delete(jobId);
  };
}

/**
 * Асинхронный итератор поверх шины с буфером.
 *
 * Буфер нужен, потому что события приходят быстрее, чем их успевает
 * забрать SSE-поток: без него первые шаги задачи терялись бы.
 */
export async function* stream(
  jobId: string,
  signal: { done: boolean },
  idleTimeoutMs = 30_000
): AsyncGenerator<TurnEvent> {
  const buffer: TurnEvent[] = [];
  let wake: (() => void) | null = null;

  const unsubscribe = subscribe(jobId, (event) => {
    buffer.push(event);
    wake?.();
  });

  try {
    const deadline = Date.now() + idleTimeoutMs;
    while (!signal.done || buffer.length > 0) {
      if (buffer.length === 0) {
        if (Date.now() > deadline) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 100);
        });
        wake = null;
        continue;
      }
      yield buffer.shift() as TurnEvent;
    }
  } finally {
    unsubscribe();
  }
}
