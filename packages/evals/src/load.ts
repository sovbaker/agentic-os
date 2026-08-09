import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EvalCase } from './types';

/**
 * Загрузка набора из JSONL.
 *
 * Формат построчный не случайно: заготовки дописываются в конец файла из
 * работающего сервера, а размечаются вручную в редакторе. JSON-массив
 * пришлось бы каждый раз переписывать целиком.
 */

export interface LoadResult {
  cases: EvalCase[];
  /** Заготовки без разметки: они не идут в прогон, но их надо видеть. */
  unreviewed: number;
  /** Строки, которые не разобрались. Молча пропускать их нельзя. */
  broken: Array<{ file: string; line: number; error: string }>;
}

export async function loadCases(dir: string): Promise<LoadResult> {
  const result: LoadResult = { cases: [], unreviewed: 0, broken: [] };

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return result;
  }

  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim();
      if (!line || line.startsWith('//')) continue;

      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (err) {
        result.broken.push({ file, line: i + 1, error: (err as Error).message });
        continue;
      }

      const parsed = EvalCase.safeParse(raw);
      if (!parsed.success) {
        result.broken.push({ file, line: i + 1, error: parsed.error.issues[0]?.message ?? 'не по схеме' });
        continue;
      }
      if (!parsed.data.reviewed) {
        result.unreviewed += 1;
        continue;
      }
      result.cases.push(parsed.data);
    }
  }

  return result;
}
