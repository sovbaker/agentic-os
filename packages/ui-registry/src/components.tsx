import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text as RNText, TextInput, View } from 'react-native';
import type { ComponentType } from '@agentic-os/contracts';
import { toneColor, type Theme, type Tone } from './theme';

/**
 * Реестр компонентов.
 *
 * Закрытый список, вшитый в бинарь. Сервер присылает данные и композицию,
 * но никогда — код: это одновременно требование App Store, требование
 * безопасности и условие мгновенного детерминированного рендера.
 *
 * S0: 15 базовых компонентов. Расширение до 35–45 — в S2.
 */

export interface ComponentProps {
  props: Record<string, unknown>;
  theme: Theme;
  children: ReactNode;
  /** Отправить экшен с этого узла. Что он делает — знает сервер, не клиент. */
  fire: (name: string, payload?: unknown) => void;
  hasAction: (name: string) => boolean;
}

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);
const bool = (v: unknown): boolean => v === true;
const tone = (v: unknown): Tone => {
  const t = str(v, 'default');
  return t === 'muted' || t === 'success' || t === 'warning' || t === 'danger' ? t : 'default';
};

type Renderer = (p: ComponentProps) => ReactNode;

/* ---------------------------- раскладка ---------------------------- */

const screen: Renderer = ({ theme, children }) => (
  <ScrollView
    style={{ flex: 1, backgroundColor: theme.colors.bg }}
    contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(3), paddingBottom: theme.spacing(12) }}
  >
    {children}
  </ScrollView>
);

const stack: Renderer = ({ props, theme, children }) => (
  <View style={{ gap: theme.spacing(num(props['gap'], 2)) }}>{children}</View>
);

const row: Renderer = ({ props, theme, children }) => (
  <View
    style={{
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing(num(props['gap'], 2)),
      justifyContent: str(props['justify'], 'flex-start') as 'flex-start',
    }}
  >
    {children}
  </View>
);

const section: Renderer = ({ theme, children }) => (
  <View style={{ gap: theme.spacing(2) }}>{children}</View>
);

const card: Renderer = ({ theme, children }) => (
  <View
    style={{
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
      padding: theme.spacing(4),
      gap: theme.spacing(3),
    }}
  >
    {children}
  </View>
);

const divider: Renderer = ({ theme }) => (
  <View style={{ height: 1, backgroundColor: theme.colors.border }} />
);

const spacer: Renderer = ({ props, theme }) => (
  <View style={{ height: theme.spacing(num(props['size'], 2)) }} />
);

/* ------------------------------ текст ------------------------------ */

const heading: Renderer = ({ props, theme }) => {
  const level = num(props['level'], 2);
  const size = level === 1 ? theme.font.h1 : level === 2 ? theme.font.h2 : theme.font.h3;
  return (
    <RNText style={{ fontSize: size, fontWeight: '700', color: theme.colors.text, lineHeight: size * 1.25 }}>
      {str(props['text'])}
    </RNText>
  );
};

const text: Renderer = ({ props, theme }) => (
  <RNText
    style={{
      fontSize: theme.font.body,
      color: toneColor(theme, tone(props['tone'])),
      lineHeight: theme.font.body * 1.45,
    }}
  >
    {str(props['text'])}
  </RNText>
);

const badge: Renderer = ({ props, theme }) => {
  const color = toneColor(theme, tone(props['tone']));
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: theme.spacing(3),
        paddingVertical: theme.spacing(1.5),
        borderRadius: theme.radius.sm,
        backgroundColor: `${color}1A`,
        borderWidth: 1,
        borderColor: `${color}40`,
      }}
    >
      <RNText style={{ fontSize: theme.font.small, color, fontWeight: '600' }}>
        {str(props['text'])}
      </RNText>
    </View>
  );
};

/* ------------------------------ данные ----------------------------- */

const list: Renderer = ({ theme, children }) => (
  <View style={{ gap: theme.spacing(1) }}>{children}</View>
);

const checklist: Renderer = ({ theme, children }) => (
  <View style={{ gap: theme.spacing(1) }}>{children}</View>
);

const listItem: Renderer = ({ props, theme, fire, hasAction }) => {
  const checked = bool(props['checked']);
  const showCheckbox = 'checked' in props;
  const pressable = hasAction('onPress');
  const subtitle = str(props['subtitle']);

  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing(3),
        paddingVertical: theme.spacing(2.5),
      }}
    >
      {showCheckbox ? (
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            borderWidth: 2,
            borderColor: checked ? theme.colors.success : theme.colors.border,
            backgroundColor: checked ? theme.colors.success : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 1,
          }}
        >
          {checked ? (
            <RNText style={{ color: theme.colors.surface, fontSize: 13, fontWeight: '800' }}>✓</RNText>
          ) : null}
        </View>
      ) : null}

      <View style={{ flex: 1, gap: 2 }}>
        <RNText
          style={{
            fontSize: theme.font.body,
            color: checked ? theme.colors.textMuted : theme.colors.text,
            textDecorationLine: checked ? 'line-through' : 'none',
            lineHeight: theme.font.body * 1.4,
          }}
        >
          {str(props['title'])}
        </RNText>
        {subtitle ? (
          <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted }}>{subtitle}</RNText>
        ) : null}
      </View>
    </View>
  );

  if (!pressable) return body;
  return (
    <Pressable onPress={() => fire('onPress')} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}>
      {body}
    </Pressable>
  );
};

/* ----------------------------- действия ---------------------------- */

const button: Renderer = ({ props, theme, fire }) => {
  const variant = str(props['variant'], 'primary');
  const disabled = bool(props['disabled']);
  const primary = variant === 'primary';

  return (
    <Pressable
      disabled={disabled}
      onPress={() => fire('onPress')}
      style={({ pressed }) => ({
        backgroundColor: primary ? theme.colors.accent : 'transparent',
        borderWidth: primary ? 0 : 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.md,
        paddingVertical: theme.spacing(3.5),
        paddingHorizontal: theme.spacing(5),
        alignItems: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <RNText
        style={{
          color: primary ? theme.colors.accentText : theme.colors.text,
          fontSize: theme.font.body,
          fontWeight: '600',
        }}
      >
        {str(props['label'], 'Действие')}
      </RNText>
    </Pressable>
  );
};

/* ------------------------------- ввод ------------------------------ */

const textField: Renderer = ({ props, theme, fire }) => {
  const label = str(props['label']);
  const multiline = bool(props['multiline']);
  return (
    <View style={{ gap: theme.spacing(1.5) }}>
      {label ? (
        <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted, fontWeight: '600' }}>
          {label}
        </RNText>
      ) : null}
      <TextInput
        defaultValue={str(props['value'])}
        placeholder={str(props['placeholder'])}
        placeholderTextColor={theme.colors.textMuted}
        multiline={multiline}
        onChangeText={(v) => fire('onChange', v)}
        onSubmitEditing={(e) => fire('onSubmit', e.nativeEvent.text)}
        style={{
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceAlt,
          color: theme.colors.text,
          paddingHorizontal: theme.spacing(3.5),
          paddingVertical: theme.spacing(3),
          fontSize: theme.font.body,
          minHeight: multiline ? 88 : undefined,
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
    </View>
  );
};

/* ------------------------------------------------------------------ */

export const REGISTRY: Partial<Record<ComponentType, Renderer>> = {
  screen, stack, row, section, card, divider, spacer,
  heading, text, badge,
  list, listItem, checklist,
  button, textField,
};

/**
 * Незнакомый компонент НЕ должен ронять экран.
 *
 * Сервер выкатывается чаще, чем приложение проходит ревью, поэтому старый
 * клиент обязан деградировать вперёд: показать заглушку и отрендерить детей.
 */
export const Fallback: Renderer = ({ props, theme, children }) => (
  <View
    style={{
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: theme.colors.border,
      borderRadius: theme.radius.md,
      padding: theme.spacing(3),
      gap: theme.spacing(2),
    }}
  >
    <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted }}>
      {str(props['__fallbackLabel'], 'Этот блок появится после обновления приложения')}
    </RNText>
    {children}
  </View>
);
