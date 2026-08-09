import type { UINode, UISpec } from '@agentic-os/contracts';
import { query } from '../../db/client';

/**
 * «Карта твоей жизни».
 *
 * Двойная выгода: для пользователя — момент, когда он впервые верит, что
 * продукт про него; для нас — самая дешёвая разметка в мире. Каждое
 * исправление превращается в подтверждённый факт с максимальной уверенностью.
 *
 * Поэтому у каждого факта виден источник: ассистент обязан уметь ответить
 * «откуда ты это взял», иначе первая же ошибка стоит доверия целиком.
 */

const SOURCE_LABEL: Record<string, string> = {
  user_said: 'с твоих слов',
  user_confirmed: 'подтверждено тобой',
  calendar: 'из календаря',
  contacts: 'из контактов',
  email: 'из почты',
  procedure: 'по ходу задачи',
  inferred: 'предположение',
};

const TYPE_LABEL: Record<string, string> = {
  person: 'Люди',
  place: 'Места',
  org: 'Организации',
  thing: 'Вещи',
  document: 'Документы',
  account: 'Счета и подписки',
  recurring: 'Повторяется',
  goal: 'Планы',
  constraint: 'Ограничения',
};

interface FactRow {
  fact_id: string;
  label: string;
  type: string;
  predicate: string;
  confidence: number;
  source: string;
}

export interface LifeMap {
  spec: UISpec;
  data: Record<string, unknown>;
}

export async function buildLifeMap(userId: string): Promise<LifeMap> {
  const rows = await query<FactRow>(
    `SELECT f.id AS fact_id, e.label, e.type, f.predicate, f.confidence, f.source
       FROM fact f JOIN entity e ON e.id = f.subject_id
      WHERE f.user_id = $1 AND f.valid_to IS NULL AND e.archived_at IS NULL
      ORDER BY f.confidence DESC, f.observed_at DESC
      LIMIT 60`,
    [userId]
  );

  const groups = new Map<string, FactRow[]>();
  for (const row of rows) {
    const list = groups.get(row.type) ?? [];
    list.push(row);
    groups.set(row.type, list);
  }

  const sections = [...groups.entries()].map(([type, facts]) => ({
    title: TYPE_LABEL[type] ?? type,
    items: facts.map((f) => ({
      id: f.fact_id,
      name: f.label,
      // Предположения помечаем прямо в тексте: уверенная ошибка дороже
      // признания незнания.
      note: `${SOURCE_LABEL[f.source] ?? f.source}${f.confidence < 0.5 ? ', уточню' : ''}`,
    })),
  }));

  const root: UINode = {
    type: 'screen',
    props: { title: 'Что я о тебе знаю' },
    children: [
      {
        type: 'section',
        children: [
          { type: 'heading', props: { text: 'Карта твоей жизни', level: 1 } },
          {
            type: 'text',
            props: {
              text:
                rows.length > 0
                  ? 'Вот что я понял. Поправь, если что-то не так — я запомню.'
                  : 'Пока пусто. Расскажи о задаче, и карта начнёт заполняться сама.',
              tone: 'muted',
            },
          },
          { type: 'row', props: { gap: 4 }, children: [
            { type: 'stat', bind: { value: { source: 'data', path: 'factCount' } }, props: { label: 'Фактов' } },
            { type: 'stat', bind: { value: { source: 'data', path: 'confirmedCount' } }, props: { label: 'Подтверждено' } },
          ] },
        ],
      },
      {
        type: 'emptyState',
        visibleIf: { ref: { source: 'data', path: 'sections' }, op: 'empty' },
        props: { glyph: '🗺', title: 'Карта пока пустая', text: 'Она наполняется по ходу дела, а не анкетой' },
      },
      {
        type: 'stack',
        repeat: { ref: { source: 'data', path: 'sections' }, as: 'section' },
        children: [
          {
            type: 'card',
            children: [
              { type: 'heading', bind: { text: { source: 'data', path: 'section.title' } }, props: { level: 2 } },
              {
                type: 'list',
                repeat: { ref: { source: 'data', path: 'section.items' }, as: 'fact' },
                children: [
                  {
                    type: 'listItem',
                    bind: {
                      title: { source: 'data', path: 'fact.name' },
                      subtitle: { source: 'data', path: 'fact.note' },
                    },
                    actions: {
                      // Один тап = подтверждённый факт с максимальной уверенностью.
                      onPress: {
                        kind: 'tool',
                        tool: 'memory.confirm_fact',
                        args: { factId: { source: 'data', path: 'fact.id' } },
                        optimistic: true,
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const spec: UISpec = {
    schemaVersion: '1.0',
    id: 'life-map',
    version: 1,
    title: 'Что я о тебе знаю',
    dataSources: [],
    meta: { origin: 'catalog', graphRefs: [], runtimeKeys: ['sections', 'factCount', 'confirmedCount'], shareable: false },
    root,
  };

  return {
    spec,
    data: {
      sections,
      factCount: rows.length,
      confirmedCount: rows.filter((r) => r.confidence >= 0.8).length,
    },
  };
}
