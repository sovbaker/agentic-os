import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { UINode } from '@agentic-os/contracts';
import {
  emptyScope,
  evalCondition,
  expandRepeat,
  getPath,
  isVisible,
  resolveActionArgs,
  resolveProps,
  resolveRef,
} from './resolve';

test('getPath проходит по объектам и массивам', () => {
  const root = { a: { b: [{ c: 42 }] } };
  assert.equal(getPath(root, 'a.b.0.c'), 42);
  assert.equal(getPath(root, 'a.b.5.c'), undefined);
  assert.equal(getPath(root, 'a.missing'), undefined);
  assert.equal(getPath(null, 'a'), undefined);
});

test('resolveRef берёт значение из нужной области и уважает fallback', () => {
  const scope = emptyScope({ data: { user: { name: 'Олег' } }, state: { draft: 'привет' } });
  assert.equal(resolveRef({ source: 'data', path: 'user.name' }, scope), 'Олег');
  assert.equal(resolveRef({ source: 'state', path: 'draft' }, scope), 'привет');
  assert.equal(resolveRef({ source: 'data', path: 'нет', fallback: '—' }, scope), '—');
});

test('переменная repeat перекрывает одноимённое поле данных', () => {
  const scope = emptyScope({
    data: { item: { name: 'из данных' } },
    locals: { item: { name: 'из цикла' } },
  });
  assert.equal(resolveRef({ source: 'data', path: 'item.name' }, scope), 'из цикла');
});

test('expandRepeat создаёт область на каждый элемент и берёт ключ из id', () => {
  const node: UINode = {
    type: 'listItem',
    repeat: { ref: { source: 'data', path: 'items' }, as: 'item' },
  };
  const scope = emptyScope({ data: { items: [{ id: 'a' }, { id: 'b' }] } });
  const instances = expandRepeat(node, scope);

  assert.equal(instances.length, 2);
  assert.deepEqual(instances.map((i) => i.key), ['a', 'b']);
  assert.deepEqual(instances[0]?.scope.locals['item'], { id: 'a' });
});

test('repeat по отсутствующей коллекции даёт пусто, а не падение', () => {
  const node: UINode = {
    type: 'listItem',
    repeat: { ref: { source: 'data', path: 'ничего' }, as: 'item' },
  };
  assert.deepEqual(expandRepeat(node, emptyScope()), []);
});

test('resolveProps: bind перекрывает статические props', () => {
  const node: UINode = {
    type: 'text',
    props: { text: 'статика', tone: 'muted' },
    bind: { text: { source: 'data', path: 'title' } },
  };
  const props = resolveProps(node, emptyScope({ data: { title: 'из данных' } }));
  assert.equal(props['text'], 'из данных');
  assert.equal(props['tone'], 'muted');
});

test('аргументы экшена, заданные ссылкой, разрешаются', () => {
  const scope = emptyScope({ locals: { item: { id: 'passport' } } });
  const args = resolveActionArgs(
    { itemId: { source: 'data', path: 'item.id' }, literal: 7 },
    scope
  );
  assert.deepEqual(args, { itemId: 'passport', literal: 7 });
});

test('условия видимости', () => {
  const scope = emptyScope({ data: { count: 3, name: '', tags: ['a'] } });
  assert.equal(evalCondition({ ref: { source: 'data', path: 'count' }, op: 'gt', value: 2 }, scope), true);
  assert.equal(evalCondition({ ref: { source: 'data', path: 'name' }, op: 'empty' }, scope), true);
  assert.equal(evalCondition({ ref: { source: 'data', path: 'tags' }, op: 'exists' }, scope), true);
  assert.equal(evalCondition({ ref: { source: 'data', path: 'нет' }, op: 'exists' }, scope), false);

  const node: UINode = {
    type: 'text',
    visibleIf: { ref: { source: 'data', path: 'count' }, op: 'gte', value: 10 },
  };
  assert.equal(isVisible(node, scope), false);
});
