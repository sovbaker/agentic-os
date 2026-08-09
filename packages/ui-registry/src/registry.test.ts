import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ComponentType } from '@agentic-os/contracts';
import { KITCHEN_SINK } from './fixtures';

/**
 * Реестр закрыт в обе стороны.
 *
 * Компонент, объявленный в контракте, но не отрисованный клиентом, валидатор
 * пропустит — и пользователь увидит заглушку вместо интерфейса. Проверяем,
 * что каждый тип реально встречается в фикстуре, по которой снимается скриншот.
 */

function typesIn(node: { type: string; children?: unknown[] }, acc = new Set<string>()): Set<string> {
  acc.add(node.type);
  (node.children as Array<{ type: string; children?: unknown[] }> | undefined)?.forEach((c) => typesIn(c, acc));
  return acc;
}

test('каждый тип из контракта присутствует в фикстуре реестра', () => {
  const declared = ComponentType.options;
  const covered = typesIn(KITCHEN_SINK.root);
  const missing = declared.filter((t) => !covered.has(t));

  assert.deepEqual(missing, [], `не покрыты фикстурой: ${missing.join(', ')}`);
});

test('фикстура не ссылается на типы вне контракта', () => {
  const declared = new Set<string>(ComponentType.options);
  const extra = [...typesIn(KITCHEN_SINK.root)].filter((t) => !declared.has(t));
  assert.deepEqual(extra, []);
});
