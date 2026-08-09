import { close } from '../../db/client';
import { runEvals } from './run';

/**
 * Точка входа `npm run evals`.
 *
 * Код возврата — не украшение: прогон встаёт в один ряд с типами и тестами,
 * а значит должен уметь уронить CI. Гейт G1 задаётся через EVALS_GATE.
 */
const { ok, text } = await runEvals();
console.log(text);
await close();
process.exit(ok ? 0 : 1);
