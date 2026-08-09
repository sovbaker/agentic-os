import { close } from '../../db/client';
import { snapshot } from './index';

/**
 * `npm run metrics` — то, на что смотрят раз в неделю перед интервью с бетой.
 *
 * Порядок вывода не алфавитный, а по важности решения: сначала TCFY (идём
 * дальше или пересобираем клин), потом воронка, качество и экономика.
 */

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const rub = (v: number): string => `${v.toFixed(1)} ₽`;

const s = await snapshot();
const out: string[] = [];

out.push('TCFY — задач, закрытых за пользователя, в неделю');
if (s.tcfy.weeks.length === 0) {
  out.push('  данных ещё нет');
} else {
  for (const w of s.tcfy.weeks.slice(0, 8)) out.push(`  ${w.weekStart}  ${'█'.repeat(Math.min(w.closed, 40))} ${w.closed}`);
  out.push(`  медиана: ${s.tcfy.median} · гейт G3 (≥3): ${s.tcfy.gatePassed ? 'пройден' : 'НЕ пройден'}`);
}

out.push('', 'Воронка');
out.push(`  пользователей: ${s.funnel.users}`);
out.push(`  дошли до первой закрытой задачи: ${s.funnel.activated} (${pct(s.funnel.activationRate)})`);
out.push(
  `  медианное время до первой пользы: ${
    s.funnel.medianTimeToValueMin === null ? '—' : `${Math.round(s.funnel.medianTimeToValueMin)} мин`
  }`
);

out.push('', 'Качество');
out.push(`  доля успешных задач: ${pct(s.quality.successRate)}`);
// Растущая доля вопросов — сигнал, что продукт создаёт работу, а не забирает.
out.push(`  потребовали вопроса пользователю: ${pct(s.quality.askedUserRate)}`);
out.push(`  отменённых действий: ${pct(s.quality.reversedRate)}`);

out.push('', 'Экономика');
out.push(`  медиана на закрытую задачу: ${rub(s.economy.medianCostPerClosedRub)} (цель ≤ 25 ₽)`);
out.push(`  p90 на закрытую задачу: ${rub(s.economy.p90CostPerClosedRub)}`);
out.push(`  вход из кэша: ${pct(s.economy.cacheHitRate)}`);
for (const r of s.economy.byRole) out.push(`    ${r.role.padEnd(10)} ${rub(r.rub)} за ${r.calls} вызовов`);

out.push('', 'Мини-аппы (гейт G2)');
for (const o of s.miniapps.byOrigin) out.push(`  ${o.origin.padEnd(14)} ${o.count}`);
out.push(`  доля каталога: ${pct(s.miniapps.catalogShare)}`);

console.log(out.join('\n'));
await close();
