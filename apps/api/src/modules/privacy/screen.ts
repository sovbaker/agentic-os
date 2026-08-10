import type { UINode, UISpec } from '@agentic-os/contracts';
import { monthSpendRub } from '../billing/cost';
import { PLANS, getPlan } from '../billing/quota';
import { privacySummary } from './index';

/**
 * Экран приватности — той же природы, что и всё остальное: серверный UISpec
 * из закрытого реестра компонентов. Отдельный нативный экран означал бы,
 * что для правки формулировки нужен релиз в App Store, а на экране про
 * доверие формулировки меняются чаще всего.
 *
 * Содержание подчинено одной задаче: ответить на «а вы там всё моё читаете?»
 * до того, как вопрос задан. Поэтому сначала числа, потом объяснение
 * карантина, и только потом кнопки.
 */

export interface PrivacyScreen {
  spec: UISpec;
  data: Record<string, unknown>;
}

export async function buildPrivacyScreen(userId: string): Promise<PrivacyScreen> {
  const [summary, plan, spent] = await Promise.all([
    privacySummary(userId),
    getPlan(userId),
    monthSpendRub(userId),
  ]);

  const root: UINode = {
    type: 'screen',
    props: { title: 'Данные и приватность' },
    children: [
      {
        type: 'section',
        children: [
          { type: 'heading', props: { text: 'Что я о тебе храню', level: 1 } },
          {
            type: 'text',
            props: {
              text: 'Всё это можно забрать одним файлом или удалить целиком. Без писем в поддержку.',
              tone: 'muted',
            },
          },
        ],
      },
      /*
       * Правило пустого прибора: ни один компонент не печатает 0 крупным
       * кеглем. Пять нулей как первое, что видит человек на экране про
       * доверие, характеризуют не продукт, а его самого.
       */
      {
        type: 'text',
        visibleIf: { ref: { source: 'data', path: 'hasData' }, op: 'eq', value: false },
        props: { text: 'Пока ничего: я ещё не знаю о тебе ни одного факта и не сделал ни одного действия.', tone: 'muted' },
      },
      {
        type: 'grid',
        visibleIf: { ref: { source: 'data', path: 'hasData' }, op: 'eq', value: true },
        props: { columns: 2, gap: 4 },
        children: [
          { type: 'stat', props: { label: 'Фактов о тебе' }, bind: { value: { source: 'data', path: 'facts' } } },
          { type: 'stat', props: { label: 'Записей в дневнике' }, bind: { value: { source: 'data', path: 'episodes' } } },
          { type: 'stat', props: { label: 'Задач' }, bind: { value: { source: 'data', path: 'jobs' } } },
          { type: 'stat', props: { label: 'Действий в журнале' }, bind: { value: { source: 'data', path: 'actions' } } },
        ],
      },
      {
        type: 'card',
        children: [
          { type: 'heading', props: { text: 'Недоверенное — отдельно', level: 2 } },
          {
            type: 'stat',
            visibleIf: { ref: { source: 'data', path: 'hasQuarantine' }, op: 'eq', value: true },
            props: { label: 'Писем и страниц в карантине' },
            bind: { value: { source: 'data', path: 'quarantined' } },
          },
          {
            type: 'text',
            props: {
              /**
               * Это не техническая деталь, а суть обещания: текст, который
               * пишет кто угодно, физически не может стать инструкцией
               * ассистенту. Пользователь имеет право это знать.
               */
              text:
                'Текст из писем и с сайтов лежит в отдельном хранилище и никогда не становится командой. ' +
                'Из него берутся только факты — и с пометкой «предположение», которая не может перебить твои слова.',
              tone: 'muted',
            },
          },
        ],
      },
      {
        type: 'card',
        children: [
          { type: 'heading', props: { text: 'Тариф и расход', level: 2 } },
          // Один keyValue со списком пар, а не три компонента подряд:
          // выравнивание значений по правому краю работает только внутри
          // одного блока.
          { type: 'keyValue', bind: { items: { source: 'data', path: 'planRows' } } },
          {
            type: 'text',
            props: { text: 'Показываю честно: это наши расходы на твои задачи, а не счёт тебе.', tone: 'muted' },
          },
        ],
      },
      {
        type: 'section',
        children: [
          {
            type: 'button',
            props: { label: 'Выгрузить всё в файл', variant: 'secondary' },
            actions: { onPress: { kind: 'tool', tool: 'privacy.export', args: {} } },
          },
          {
            type: 'button',
            // Удаление необратимо, поэтому это единственная кнопка опасного
            // вида на весь продукт, и подтверждение спрашивает сервер.
            props: { label: 'Удалить все мои данные', variant: 'danger' },
            actions: {
              onPress: {
                kind: 'tool',
                tool: 'privacy.delete',
                args: {},
                confirm: 'Удалить всё безвозвратно? Граф, задачи, журнал и переписку восстановить будет нельзя.',
                /* Клиент отличит опасное по этому тексту и покажет другой лист. */
              },
            },
          },
        ],
      },
    ],
  };

  const spec: UISpec = {
    schemaVersion: '1.0',
    id: 'privacy',
    version: 1,
    title: 'Данные и приватность',
    dataSources: [],
    meta: {
      origin: 'catalog',
      graphRefs: [],
      runtimeKeys: ['facts', 'episodes', 'jobs', 'actions', 'quarantined', 'planRows', 'hasData', 'hasQuarantine'],
      shareable: false,
    },
    root,
  };

  const limit = PLANS[plan].tasksPerMonth;

  return {
    spec,
    data: {
      facts: summary.facts,
      episodes: summary.episodes,
      jobs: summary.jobs,
      actions: summary.actions,
      quarantined: summary.quarantined,
      hasData: summary.facts + summary.episodes + summary.jobs + summary.actions > 0,
      hasQuarantine: summary.quarantined > 0,
      planRows: [
        { key: 'Тариф', value: plan === 'pro' ? 'Pro' : 'Бесплатный' },
        {
          key: 'Задач в этом месяце',
          value: limit === null ? `${summary.jobs} · без ограничения` : `${summary.jobs} из ${limit}`,
        },
        { key: 'Потрачено на модели', value: `${spent.toFixed(2)} ₽` },
      ],
    },
  };
}
