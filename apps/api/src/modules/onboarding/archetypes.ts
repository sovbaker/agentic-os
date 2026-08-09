import type { ExtractedFact } from '../orchestrator/llm';
import { ingestFacts } from '../memory/graph';
import { query } from '../../db/client';

/**
 * Priors по архетипу.
 *
 * Опровергать легче, чем заполнять: три тапа дают скелет графа, который
 * дальше уточняется по ходу дела. Ключевое — уверенность низкая, а источник
 * `inferred`, поэтому по политике разрешения конфликтов такой факт никогда
 * не перебьёт сказанное пользователем и никогда не подаётся как знание.
 */

export interface Archetype {
  id: string;
  label: string;
  glyph: string;
  facts: ExtractedFact[];
}

const prior = (
  entityLabel: string,
  entityType: ExtractedFact['entityType'],
  predicate: string,
  value?: string
): ExtractedFact => ({
  entityLabel,
  entityType,
  predicate,
  ...(value ? { value } : {}),
  // Низкая уверенность обязательна: это гипотеза, а не факт.
  confidence: 0.3,
});

export const ARCHETYPES: readonly Archetype[] = [
  {
    id: 'parent',
    label: 'Родитель школьников',
    glyph: '🎒',
    facts: [
      prior('Учебный год', 'recurring', 'has_cycle', 'сентябрь–май'),
      prior('Медсправки для школы', 'document', 'renews_yearly'),
      prior('Кружки и секции', 'recurring', 'has_weekly_schedule'),
    ],
  },
  {
    id: 'traveler',
    label: 'Много летаю',
    glyph: '✈️',
    facts: [
      prior('Загранпаспорт', 'document', 'expires'),
      prior('Страховка путешественника', 'document', 'renews_per_trip'),
      prior('Поездки', 'recurring', 'happens_often'),
    ],
  },
  {
    id: 'renter',
    label: 'Снимаю квартиру',
    glyph: '🏠',
    facts: [
      prior('Договор аренды', 'document', 'renews_yearly'),
      prior('Оплата аренды', 'recurring', 'monthly_payment'),
      prior('Коммунальные платежи', 'recurring', 'monthly_payment'),
    ],
  },
  {
    id: 'driver',
    label: 'Есть машина',
    glyph: '🚗',
    facts: [
      prior('ОСАГО', 'document', 'renews_yearly'),
      prior('Техосмотр', 'recurring', 'renews_yearly'),
      prior('Сезонная резина', 'recurring', 'twice_a_year'),
    ],
  },
  {
    id: 'caregiver',
    label: 'Забочусь о родителях',
    glyph: '💊',
    facts: [
      prior('Плановые обследования', 'recurring', 'twice_a_year'),
      prior('Лекарства по рецепту', 'recurring', 'monthly'),
    ],
  },
  {
    id: 'freelancer',
    label: 'Работаю на себя',
    glyph: '💼',
    facts: [
      prior('Налоговая отчётность', 'recurring', 'quarterly'),
      prior('Счета клиентам', 'recurring', 'monthly'),
    ],
  },
];

export async function applyArchetypes(userId: string, ids: readonly string[]): Promise<number> {
  const chosen = ARCHETYPES.filter((a) => ids.includes(a.id));
  let written = 0;

  for (const archetype of chosen) {
    written += await ingestFacts(userId, archetype.facts, 'inferred', `archetype:${archetype.id}`);
  }

  await query(
    `UPDATE app_user
        SET onboarding = onboarding || jsonb_build_object('archetypes', $2::jsonb, 'archetypesAt', now())
      WHERE id = $1`,
    [userId, JSON.stringify(chosen.map((a) => a.id))]
  );

  return written;
}
