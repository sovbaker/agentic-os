import { Fragment, type ReactNode } from 'react';
import type { UIAction, UINode, UISpec } from '@agentic-os/contracts';
import { COMPLEXITY_BUDGET } from '@agentic-os/contracts';
import { Fallback, REGISTRY } from './components';
import { emptyScope, expandRepeat, isVisible, resolveAction, resolveProps, type RenderScope } from './resolve';
import { lightTheme, type Theme } from './theme';

/**
 * Рендерер UISpec.
 *
 * Детерминированная функция от (спека, данные, состояние) — никаких обращений
 * к модели на пути отрисовки. Мини-аппа генерируется один раз и версионируется,
 * поэтому здесь остаётся только обход дерева.
 */

export type ActionDispatcher = (action: UIAction, payload?: unknown) => void;

export interface RendererProps {
  spec: UISpec;
  data?: Record<string, unknown>;
  state?: Record<string, unknown>;
  job?: Record<string, unknown>;
  theme?: Theme;
  onAction: ActionDispatcher;
}

function renderNode(
  node: UINode,
  scope: RenderScope,
  theme: Theme,
  onAction: ActionDispatcher,
  depth: number,
  keyPrefix: string
): ReactNode {
  // Защита от циклов и от спеки, прошедшей мимо валидатора:
  // рендерер не имеет права уронить приложение.
  if (depth > COMPLEXITY_BUDGET.maxDepth) return null;
  if (!isVisible(node, scope)) return null;

  const instances = expandRepeat(node, scope);

  return instances.map((instance) => {
    const props = resolveProps(node, instance.scope);
    const key = `${keyPrefix}:${instance.key}`;

    const children = node.children?.map((child, i) =>
      renderNode(child, instance.scope, theme, onAction, depth + 1, `${key}.${i}`)
    );

    const fire = (name: string, payload?: unknown): void => {
      const action = node.actions?.[name];
      if (!action) return;
      onAction(resolveAction(action, instance.scope), payload);
    };

    const hasAction = (name: string): boolean => Boolean(node.actions?.[name]);
    const Component = REGISTRY[node.type] ?? Fallback;

    return (
      <Fragment key={key}>
        {Component({
          props: Component === Fallback ? { ...props, __fallbackLabel: `Компонент «${node.type}»` } : props,
          theme,
          children,
          fire,
          hasAction,
        })}
      </Fragment>
    );
  });
}

export function Renderer({ spec, data, state, job, theme, onAction }: RendererProps): ReactNode {
  const scope = emptyScope({ data: data ?? {}, state: state ?? {}, job: job ?? {} });
  return renderNode(spec.root, scope, theme ?? lightTheme, onAction, 1, 'root');
}
