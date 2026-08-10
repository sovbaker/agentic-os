import type { UISpec } from '@agentic-os/contracts';
import { query, queryOne } from '../../db/client';

/**
 * Согласие перед первым ходом.
 *
 * Текст живёт на сервере по той же причине, что и экран приватности:
 * формулировки согласия правятся чаще всего и меньше всего заслуживают
 * релиза в App Store ради запятой.
 *
 * Отметка — на сервере, и это не то же самое, что флажок в клиенте.
 * Флажок отвечает «показывать ли экран», а вопрос, который зададут
 * ревью и юрист, звучит иначе: было ли согласие и на какую редакцию.
 */

/**
 * Версия редакции. Меняется вместе с текстом — тогда экран покажется
 * снова, и это правильно: изменившаяся политика требует нового согласия,
 * а не наследует старое.
 */
export const CONSENT_VERSION = '2026-08-1';

export interface ConsentState {
  needed: boolean;
  version: string;
  spec: UISpec;
}

const spec = (): UISpec => ({
  schemaVersion: '1.0',
  id: 'consent',
  version: 1,
  title: 'Прежде чем начнём',
  dataSources: [],
  meta: { origin: 'catalog', graphRefs: [], runtimeKeys: [], shareable: false },
  root: {
    type: 'screen',
    props: { title: 'Прежде чем начнём' },
    children: [
      {
        type: 'section',
        children: [
          { type: 'heading', props: { text: 'Три вещи честно', level: 1 } },
          {
            type: 'text',
            props: {
              text: 'Дальше — то, что обычно прячут в мелкий шрифт. Здесь это весь экран, потому что от этого зависит, стоит ли мне доверять.',
              tone: 'muted',
            },
          },
        ],
      },
      {
        type: 'section',
        children: [
          { type: 'heading', props: { text: 'Я запоминаю то, что ты рассказываешь', level: 2 } },
          {
            type: 'text',
            props: {
              text: 'Иначе не смогу быть полезным: без памяти это просто список дел. Что именно я запомнил — видно на экране «Данные и приватность», там же всё это можно забрать файлом или удалить.',
            },
          },
        ],
      },
      {
        type: 'section',
        children: [
          { type: 'heading', props: { text: 'Твои слова уходят в языковую модель', level: 2 } },
          {
            type: 'text',
            props: {
              text: 'Обрабатывает её Anthropic, США. Туда уезжает твоя фраза и та часть контекста, без которой задачу не понять. Не для обучения модели: только чтобы ответить тебе.',
            },
          },
        ],
      },
      {
        type: 'section',
        children: [
          { type: 'heading', props: { text: 'Письма и страницы я читаю в карантине', level: 2 } },
          {
            type: 'text',
            props: {
              text: 'Пересланное письмо может написать кто угодно. Из него я достаю факты — и только факты: инструкция, спрятанная внутри письма, никогда не станет моей командой.',
            },
          },
        ],
      },
      {
        type: 'section',
        children: [
          {
            type: 'text',
            props: {
              text: 'Рекламы нет. Слежки между приложениями нет. Продажи данных нет.',
              tone: 'muted',
            },
          },
        ],
      },
    ],
  },
});

export async function consentState(userId: string): Promise<ConsentState> {
  const row = await queryOne<{ consent_version: string | null }>(
    'SELECT consent_version FROM app_user WHERE id = $1',
    [userId]
  );

  return {
    needed: row?.consent_version !== CONSENT_VERSION,
    version: CONSENT_VERSION,
    spec: spec(),
  };
}

export async function acceptConsent(userId: string): Promise<void> {
  await query('UPDATE app_user SET consent_version = $2, consent_at = now() WHERE id = $1', [
    userId,
    CONSENT_VERSION,
  ]);
}
