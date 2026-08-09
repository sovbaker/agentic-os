import type { ReactNode } from 'react';
import { Image, Pressable, ScrollView, Text as RNText, TextInput, View } from 'react-native';
import type { ComponentType } from '@agentic-os/contracts';
import { toneColor, type Theme, type Tone } from './theme';

/**
 * Реестр компонентов.
 *
 * Закрытый список, вшитый в бинарь. Сервер присылает данные и композицию,
 * но никогда — код: это одновременно требование App Store, требование
 * безопасности и условие мгновенного детерминированного рендера.
 *
 * Список закрыт в обе стороны: в перечислении контрактов ровно то, что
 * здесь реализовано. Компонент, объявленный, но не отрисованный, валидатор
 * пропустил бы, а пользователь увидел бы заглушку — поэтому таких нет.
 */

export interface ComponentProps {
  props: Record<string, unknown>;
  theme: Theme;
  children: ReactNode;
  /** Отправить экшен с этого узла. Что он делает — знает сервер, не клиент. */
  fire: (name: string, payload?: unknown) => void;
  hasAction: (name: string) => boolean;
}

type Renderer = (p: ComponentProps) => ReactNode;

/* ---------------------------- помощники ---------------------------- */

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: unknown): boolean => v === true;
const tone = (v: unknown): Tone => {
  const t = str(v, 'default');
  return t === 'muted' || t === 'success' || t === 'warning' || t === 'danger' ? t : 'default';
};

interface Option {
  value: string;
  label: string;
}

const options = (v: unknown): Option[] => {
  if (!Array.isArray(v)) return [];
  return v.map((o) =>
    typeof o === 'string'
      ? { value: o, label: o }
      : { value: str((o as Option)?.value), label: str((o as Option)?.label, str((o as Option)?.value)) }
  );
};

const rows = (v: unknown): unknown[][] => (Array.isArray(v) ? v.map((r) => (Array.isArray(r) ? r : [r])) : []);

/* ---------------------------- раскладка ---------------------------- */

const screen: Renderer = ({ theme, children }) => (
  <ScrollView
    style={{ flex: 1, backgroundColor: theme.colors.bg }}
    contentContainerStyle={{
      padding: theme.spacing(4),
      gap: theme.spacing(3),
      paddingBottom: theme.spacing(12),
    }}
  >
    {children}
  </ScrollView>
);

const scroll: Renderer = ({ props, theme, children }) =>
  bool(props['horizontal']) ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.spacing(2) }}>
      {children}
    </ScrollView>
  ) : (
    <ScrollView contentContainerStyle={{ gap: theme.spacing(2) }}>{children}</ScrollView>
  );

const stack: Renderer = ({ props, theme, children }) => (
  <View style={{ gap: theme.spacing(num(props['gap'], 2)) }}>{children}</View>
);

const row: Renderer = ({ props, theme, children }) => (
  <View
    style={{
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: bool(props['wrap']) ? 'wrap' : 'nowrap',
      gap: theme.spacing(num(props['gap'], 2)),
      justifyContent: str(props['justify'], 'flex-start') as 'flex-start',
    }}
  >
    {children}
  </View>
);

const grid: Renderer = ({ props, theme, children }) => (
  <View
    style={{
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing(num(props['gap'], 2)),
    }}
  >
    {/* Ширину задаём в процентах: колонок обычно 2, реже 3. */}
    {Array.isArray(children)
      ? children.map((child, i) => (
          <View key={i} style={{ width: `${100 / num(props['columns'], 2) - 2}%` }}>
            {child}
          </View>
        ))
      : children}
  </View>
);

const section: Renderer = ({ theme, children }) => <View style={{ gap: theme.spacing(2) }}>{children}</View>;

const card: Renderer = ({ props, theme, children, fire, hasAction }) => {
  const body = (
    <View
      style={{
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: tone(props['tone']) === 'default' ? theme.colors.border : `${toneColor(theme, tone(props['tone']))}55`,
        padding: theme.spacing(4),
        gap: theme.spacing(3),
      }}
    >
      {children}
    </View>
  );
  if (!hasAction('onPress')) return body;
  return (
    <Pressable onPress={() => fire('onPress')} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  );
};

const divider: Renderer = ({ theme }) => <View style={{ height: 1, backgroundColor: theme.colors.border }} />;

const spacer: Renderer = ({ props, theme }) => <View style={{ height: theme.spacing(num(props['size'], 2)) }} />;

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

const label: Renderer = ({ props, theme }) => (
  <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted, fontWeight: '600' }}>
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
      <RNText style={{ fontSize: theme.font.small, color, fontWeight: '600' }}>{str(props['text'])}</RNText>
    </View>
  );
};

/**
 * Markdown в объёме, который реально нужен ассистенту: абзацы, списки
 * и жирный. Полноценный парсер тянет зависимость и открывает поверхность
 * для вёрстки, которую никто не тестировал.
 */
const markdown: Renderer = ({ props, theme }) => {
  const source = str(props['text']);
  const blocks = source.split(/\n{2,}/).filter(Boolean);

  return (
    <View style={{ gap: theme.spacing(2) }}>
      {blocks.map((block, bi) => {
        const lines = block.split('\n');
        const isList = lines.every((l) => /^\s*[-*•]\s+/.test(l));
        if (isList) {
          return (
            <View key={bi} style={{ gap: theme.spacing(1) }}>
              {lines.map((line, li) => (
                <View key={li} style={{ flexDirection: 'row', gap: theme.spacing(2) }}>
                  <RNText style={{ color: theme.colors.textMuted }}>•</RNText>
                  <RNText style={{ flex: 1, color: theme.colors.text, fontSize: theme.font.body, lineHeight: theme.font.body * 1.45 }}>
                    {line.replace(/^\s*[-*•]\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1')}
                  </RNText>
                </View>
              ))}
            </View>
          );
        }
        return (
          <RNText key={bi} style={{ color: theme.colors.text, fontSize: theme.font.body, lineHeight: theme.font.body * 1.45 }}>
            {block.replace(/\*\*(.+?)\*\*/g, '$1')}
          </RNText>
        );
      })}
    </View>
  );
};

/* ------------------------------ медиа ------------------------------ */

const image: Renderer = ({ props, theme }) => {
  const uri = str(props['uri']);
  if (!uri) return null;
  return (
    <Image
      source={{ uri }}
      style={{
        width: '100%',
        height: num(props['height'], 180),
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surfaceAlt,
      }}
      resizeMode="cover"
    />
  );
};

const icon: Renderer = ({ props }) => <RNText style={{ fontSize: num(props['size'], 20) }}>{str(props['glyph'], '•')}</RNText>;

const avatar: Renderer = ({ props, theme }) => {
  const size = num(props['size'], 40);
  const name = str(props['name'], '?');
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.colors.surfaceAlt,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <RNText style={{ color: theme.colors.text, fontWeight: '600', fontSize: size * 0.36 }}>{initials}</RNText>
    </View>
  );
};

/* ------------------------------ данные ----------------------------- */

const list: Renderer = ({ theme, children }) => <View style={{ gap: theme.spacing(1) }}>{children}</View>;
const checklist: Renderer = ({ theme, children }) => <View style={{ gap: theme.spacing(1) }}>{children}</View>;

const listItem: Renderer = ({ props, theme, fire, hasAction }) => {
  const checked = bool(props['checked']);
  const showCheckbox = 'checked' in props;
  const pressable = hasAction('onPress');
  const subtitle = str(props['subtitle']);
  const trailing = str(props['trailing']);

  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing(3), paddingVertical: theme.spacing(2.5) }}>
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
          {checked ? <RNText style={{ color: theme.colors.surface, fontSize: 13, fontWeight: '800' }}>✓</RNText> : null}
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
        {subtitle ? <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted }}>{subtitle}</RNText> : null}
      </View>

      {trailing ? <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted }}>{trailing}</RNText> : null}
    </View>
  );

  if (!pressable) return body;
  return (
    <Pressable onPress={() => fire('onPress')} style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}>
      {body}
    </Pressable>
  );
};

const table: Renderer = ({ props, theme }) => {
  const headers = Array.isArray(props['headers']) ? (props['headers'] as unknown[]).map((h) => str(h)) : [];
  const body = rows(props['rows']);

  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, overflow: 'hidden' }}>
      {headers.length > 0 ? (
        <View style={{ flexDirection: 'row', backgroundColor: theme.colors.surfaceAlt }}>
          {headers.map((h, i) => (
            <RNText
              key={i}
              style={{ flex: 1, padding: theme.spacing(2.5), fontSize: theme.font.small, fontWeight: '700', color: theme.colors.textMuted }}
            >
              {h}
            </RNText>
          ))}
        </View>
      ) : null}
      {body.map((r, ri) => (
        <View key={ri} style={{ flexDirection: 'row', borderTopWidth: ri === 0 && headers.length === 0 ? 0 : 1, borderTopColor: theme.colors.border }}>
          {r.map((cell, ci) => (
            <RNText key={ci} style={{ flex: 1, padding: theme.spacing(2.5), fontSize: theme.font.small, color: theme.colors.text }}>
              {str(cell)}
            </RNText>
          ))}
        </View>
      ))}
    </View>
  );
};

const keyValue: Renderer = ({ props, theme }) => {
  const pairs = Array.isArray(props['items']) ? (props['items'] as Array<{ key?: unknown; value?: unknown }>) : [];
  return (
    <View style={{ gap: theme.spacing(2) }}>
      {pairs.map((p, i) => (
        <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing(3) }}>
          <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted, flex: 1 }}>{str(p.key)}</RNText>
          <RNText style={{ fontSize: theme.font.small, color: theme.colors.text, fontWeight: '600', flex: 1, textAlign: 'right' }}>
            {str(p.value)}
          </RNText>
        </View>
      ))}
    </View>
  );
};

/** Столбчатая диаграмма на View: без библиотек и без нативных зависимостей. */
const chart: Renderer = ({ props, theme }) => {
  const series = Array.isArray(props['series'])
    ? (props['series'] as Array<{ label?: unknown; value?: unknown }>).map((s) => ({
        label: str(s.label),
        value: num(s.value, 0),
      }))
    : [];
  const max = Math.max(1, ...series.map((s) => s.value));

  return (
    <View style={{ gap: theme.spacing(2) }}>
      {series.map((s, i) => (
        <View key={i} style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted }}>{s.label}</RNText>
            <RNText style={{ fontSize: theme.font.small, color: theme.colors.text, fontWeight: '600' }}>{s.value}</RNText>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: theme.colors.surfaceAlt, overflow: 'hidden' }}>
            <View style={{ width: `${(s.value / max) * 100}%`, height: '100%', backgroundColor: theme.colors.accent }} />
          </View>
        </View>
      ))}
    </View>
  );
};

const progress: Renderer = ({ props, theme }) => {
  const value = Math.max(0, Math.min(1, num(props['value'], 0)));
  return (
    <View style={{ gap: 6 }}>
      {str(props['label']) ? (
        <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted }}>{str(props['label'])}</RNText>
      ) : null}
      <View style={{ height: 10, borderRadius: 5, backgroundColor: theme.colors.surfaceAlt, overflow: 'hidden' }}>
        <View style={{ width: `${value * 100}%`, height: '100%', backgroundColor: theme.colors.success }} />
      </View>
    </View>
  );
};

const stat: Renderer = ({ props, theme }) => (
  <View style={{ gap: 2 }}>
    <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted }}>{str(props['label'])}</RNText>
    <RNText style={{ fontSize: theme.font.h2, fontWeight: '700', color: toneColor(theme, tone(props['tone'])) }}>
      {str(props['value'])}
    </RNText>
    {str(props['hint']) ? (
      <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted }}>{str(props['hint'])}</RNText>
    ) : null}
  </View>
);

const timeline: Renderer = ({ props, theme }) => {
  const items = Array.isArray(props['items'])
    ? (props['items'] as Array<{ title?: unknown; at?: unknown; done?: unknown }>)
    : [];
  return (
    <View style={{ gap: theme.spacing(3) }}>
      {items.map((item, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: theme.spacing(3) }}>
          <View style={{ alignItems: 'center' }}>
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                marginTop: 5,
                backgroundColor: bool(item.done) ? theme.colors.success : theme.colors.border,
              }}
            />
            {i < items.length - 1 ? <View style={{ width: 2, flex: 1, backgroundColor: theme.colors.border, marginTop: 4 }} /> : null}
          </View>
          <View style={{ flex: 1, paddingBottom: theme.spacing(1) }}>
            <RNText style={{ color: theme.colors.text, fontSize: theme.font.body }}>{str(item.title)}</RNText>
            {str(item.at) ? (
              <RNText style={{ color: theme.colors.textMuted, fontSize: theme.font.small }}>{str(item.at)}</RNText>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
};

/**
 * Календарь как повестка, а не сетка месяца.
 * В ассистенте важнее «что ближайшее», чем «как выглядит октябрь».
 */
const calendar: Renderer = ({ props, theme }) => {
  const events = Array.isArray(props['events'])
    ? (props['events'] as Array<{ title?: unknown; startsAt?: unknown; location?: unknown }>)
    : [];

  if (events.length === 0) {
    return <RNText style={{ color: theme.colors.textMuted, fontSize: theme.font.small }}>Событий нет</RNText>;
  }

  const fmt = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  };

  return (
    <View style={{ gap: theme.spacing(2) }}>
      {events.map((e, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: theme.spacing(3), alignItems: 'flex-start' }}>
          <RNText style={{ fontSize: theme.font.small, color: theme.colors.accent, fontWeight: '600', width: 96 }}>
            {fmt(str(e.startsAt))}
          </RNText>
          <View style={{ flex: 1 }}>
            <RNText style={{ color: theme.colors.text, fontSize: theme.font.body }}>{str(e.title)}</RNText>
            {str(e.location) ? (
              <RNText style={{ color: theme.colors.textMuted, fontSize: theme.font.small }}>{str(e.location)}</RNText>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
};

/* ------------------------------- ввод ------------------------------ */

function field(theme: Theme, children: ReactNode, labelText: string): ReactNode {
  return (
    <View style={{ gap: theme.spacing(1.5) }}>
      {labelText ? (
        <RNText style={{ fontSize: theme.font.small, color: theme.colors.textMuted, fontWeight: '600' }}>{labelText}</RNText>
      ) : null}
      {children}
    </View>
  );
}

function inputStyle(theme: Theme, multiline = false) {
  return {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    color: theme.colors.text,
    paddingHorizontal: theme.spacing(3.5),
    paddingVertical: theme.spacing(3),
    fontSize: theme.font.body,
    minHeight: multiline ? 88 : undefined,
    textAlignVertical: multiline ? ('top' as const) : ('center' as const),
  };
}

const textField: Renderer = ({ props, theme, fire }) =>
  field(
    theme,
    <TextInput
      defaultValue={str(props['value'])}
      placeholder={str(props['placeholder'])}
      placeholderTextColor={theme.colors.textMuted}
      onChangeText={(v) => fire('onChange', v)}
      onSubmitEditing={(e) => fire('onSubmit', e.nativeEvent.text)}
      style={inputStyle(theme)}
    />,
    str(props['label'])
  );

const textArea: Renderer = ({ props, theme, fire }) =>
  field(
    theme,
    <TextInput
      defaultValue={str(props['value'])}
      placeholder={str(props['placeholder'])}
      placeholderTextColor={theme.colors.textMuted}
      multiline
      onChangeText={(v) => fire('onChange', v)}
      style={inputStyle(theme, true)}
    />,
    str(props['label'])
  );

const numberField: Renderer = ({ props, theme, fire }) =>
  field(
    theme,
    <TextInput
      defaultValue={str(props['value'])}
      placeholder={str(props['placeholder'])}
      placeholderTextColor={theme.colors.textMuted}
      keyboardType="numeric"
      onChangeText={(v) => fire('onChange', Number(v.replace(',', '.')))}
      style={inputStyle(theme)}
    />,
    str(props['label'])
  );

/** Выбор — чипами, а не выпадающим списком: на телефоне это меньше шагов. */
function chips(
  theme: Theme,
  items: Option[],
  selected: readonly string[],
  onPick: (value: string) => void
): ReactNode {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(2) }}>
      {items.map((opt) => {
        const active = selected.includes(opt.value);
        return (
          <Pressable
            key={opt.value}
            onPress={() => onPick(opt.value)}
            style={{
              paddingHorizontal: theme.spacing(3.5),
              paddingVertical: theme.spacing(2.5),
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: active ? theme.colors.accent : theme.colors.border,
              backgroundColor: active ? `${theme.colors.accent}1A` : theme.colors.surfaceAlt,
            }}
          >
            <RNText style={{ color: active ? theme.colors.accent : theme.colors.text, fontSize: theme.font.small, fontWeight: active ? '700' : '400' }}>
              {opt.label}
            </RNText>
          </Pressable>
        );
      })}
    </View>
  );
}

const select: Renderer = ({ props, theme, fire }) => {
  const selected = str(props['value']);
  return field(theme, chips(theme, options(props['options']), selected ? [selected] : [], (v) => fire('onChange', v)), str(props['label']));
};

const multiSelect: Renderer = ({ props, theme, fire }) => {
  const selected = Array.isArray(props['value']) ? (props['value'] as unknown[]).map((v) => str(v)) : [];
  return field(
    theme,
    chips(theme, options(props['options']), selected, (v) =>
      fire('onChange', selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v])
    ),
    str(props['label'])
  );
};

const radioGroup: Renderer = ({ props, theme, fire }) => {
  const selected = str(props['value']);
  return field(
    theme,
    <View style={{ gap: theme.spacing(2) }}>
      {options(props['options']).map((opt) => {
        const active = opt.value === selected;
        return (
          <Pressable key={opt.value} onPress={() => fire('onChange', opt.value)} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}>
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                borderWidth: 2,
                borderColor: active ? theme.colors.accent : theme.colors.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {active ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.accent }} /> : null}
            </View>
            <RNText style={{ color: theme.colors.text, fontSize: theme.font.body }}>{opt.label}</RNText>
          </Pressable>
        );
      })}
    </View>,
    str(props['label'])
  );
};

const checkbox: Renderer = ({ props, theme, fire }) => {
  const checked = bool(props['value']);
  return (
    <Pressable onPress={() => fire('onChange', !checked)} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 2,
          borderColor: checked ? theme.colors.accent : theme.colors.border,
          backgroundColor: checked ? theme.colors.accent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <RNText style={{ color: theme.colors.accentText, fontSize: 13, fontWeight: '800' }}>✓</RNText> : null}
      </View>
      <RNText style={{ color: theme.colors.text, fontSize: theme.font.body, flex: 1 }}>{str(props['label'])}</RNText>
    </Pressable>
  );
};

const toggle: Renderer = ({ props, theme, fire }) => {
  const on = bool(props['value']);
  return (
    <Pressable onPress={() => fire('onChange', !on)} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}>
      <RNText style={{ color: theme.colors.text, fontSize: theme.font.body, flex: 1 }}>{str(props['label'])}</RNText>
      <View
        style={{
          width: 46,
          height: 28,
          borderRadius: 14,
          padding: 3,
          backgroundColor: on ? theme.colors.success : theme.colors.border,
          alignItems: on ? 'flex-end' : 'flex-start',
        }}
      >
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: theme.colors.surface }} />
      </View>
    </Pressable>
  );
};

/**
 * Слайдер шагами, а не перетаскиванием: жесты требуют нативной зависимости,
 * а для «сколько человек» и «какой бюджет» шаги честнее и точнее.
 */
const slider: Renderer = ({ props, theme, fire }) => {
  const min = num(props['min'], 0);
  const max = num(props['max'], 10);
  const step = num(props['step'], 1);
  const value = Math.max(min, Math.min(max, num(props['value'], min)));
  const ratio = max === min ? 0 : (value - min) / (max - min);

  const button = (glyph: string, next: number, disabled: boolean): ReactNode => (
    <Pressable
      disabled={disabled}
      onPress={() => fire('onChange', next)}
      style={{
        width: 36,
        height: 36,
        borderRadius: theme.radius.sm,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <RNText style={{ color: theme.colors.text, fontSize: 18 }}>{glyph}</RNText>
    </Pressable>
  );

  return field(
    theme,
    <View style={{ gap: theme.spacing(2) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}>
        {button('−', Math.max(min, value - step), value <= min)}
        <View style={{ flex: 1, gap: 6 }}>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: theme.colors.surfaceAlt, overflow: 'hidden' }}>
            <View style={{ width: `${ratio * 100}%`, height: '100%', backgroundColor: theme.colors.accent }} />
          </View>
          <RNText style={{ textAlign: 'center', color: theme.colors.text, fontWeight: '600', fontSize: theme.font.small }}>
            {value}
            {str(props['unit']) ? ` ${str(props['unit'])}` : ''}
          </RNText>
        </View>
        {button('+', Math.min(max, value + step), value >= max)}
      </View>
    </View>,
    str(props['label'])
  );
};

const rating: Renderer = ({ props, theme, fire }) => {
  const value = num(props['value'], 0);
  const max = num(props['max'], 5);
  return field(
    theme,
    <View style={{ flexDirection: 'row', gap: theme.spacing(2) }}>
      {Array.from({ length: max }, (_, i) => (
        <Pressable key={i} onPress={() => fire('onChange', i + 1)}>
          <RNText style={{ fontSize: 26, color: i < value ? theme.colors.warning : theme.colors.border }}>★</RNText>
        </Pressable>
      ))}
    </View>,
    str(props['label'])
  );
};

/** Выбор даты и времени — быстрыми вариантами. Нативный пикер требует dev build. */
function quickPicker(
  theme: Theme,
  items: Option[],
  value: string,
  onPick: (v: string) => void,
  labelText: string
): ReactNode {
  return field(theme, chips(theme, items, value ? [value] : [], onPick), labelText);
}

const datePicker: Renderer = ({ props, theme, fire }) => {
  const custom = options(props['options']);
  const items =
    custom.length > 0
      ? custom
      : [0, 1, 2, 7, 14, 30].map((days) => {
          const d = new Date(Date.now() + days * 86_400_000);
          return {
            value: d.toISOString().slice(0, 10),
            label:
              days === 0 ? 'сегодня' : days === 1 ? 'завтра' : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(d),
          };
        });
  return quickPicker(theme, items, str(props['value']), (v) => fire('onChange', v), str(props['label'], 'Дата'));
};

const timePicker: Renderer = ({ props, theme, fire }) => {
  const custom = options(props['options']);
  const items = custom.length > 0 ? custom : ['09:00', '12:00', '15:00', '18:00', '20:00'].map((t) => ({ value: t, label: t }));
  return quickPicker(theme, items, str(props['value']), (v) => fire('onChange', v), str(props['label'], 'Время'));
};

/* ----------------------------- действия ---------------------------- */

const button: Renderer = ({ props, theme, fire }) => {
  const variant = str(props['variant'], 'primary');
  const disabled = bool(props['disabled']);
  const primary = variant === 'primary';
  const danger = variant === 'danger';

  return (
    <Pressable
      disabled={disabled}
      onPress={() => fire('onPress')}
      style={({ pressed }) => ({
        backgroundColor: danger ? theme.colors.danger : primary ? theme.colors.accent : 'transparent',
        borderWidth: primary || danger ? 0 : 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.md,
        paddingVertical: theme.spacing(3.5),
        paddingHorizontal: theme.spacing(5),
        alignItems: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <RNText style={{ color: primary || danger ? theme.colors.accentText : theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>
        {str(props['label'], 'Действие')}
      </RNText>
    </Pressable>
  );
};

const buttonGroup: Renderer = ({ theme, children }) => (
  <View style={{ flexDirection: 'row', gap: theme.spacing(2) }}>
    {Array.isArray(children) ? children.map((child, i) => <View key={i} style={{ flex: 1 }}>{child}</View>) : children}
  </View>
);

const link: Renderer = ({ props, theme, fire }) => (
  <Pressable onPress={() => fire('onPress')}>
    <RNText style={{ color: theme.colors.accent, fontSize: theme.font.body, textDecorationLine: 'underline' }}>
      {str(props['label'], str(props['url']))}
    </RNText>
  </Pressable>
);

/* --------------------------- обратная связь ------------------------ */

const alert: Renderer = ({ props, theme }) => {
  const color = toneColor(theme, tone(props['tone']) === 'default' ? 'warning' : tone(props['tone']));
  return (
    <View
      style={{
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: `${color}55`,
        backgroundColor: `${color}12`,
        padding: theme.spacing(3.5),
        gap: 4,
      }}
    >
      {str(props['title']) ? <RNText style={{ color, fontWeight: '700', fontSize: theme.font.small }}>{str(props['title'])}</RNText> : null}
      <RNText style={{ color: theme.colors.text, fontSize: theme.font.small, lineHeight: theme.font.small * 1.45 }}>
        {str(props['text'])}
      </RNText>
    </View>
  );
};

const emptyState: Renderer = ({ props, theme, children }) => (
  <View style={{ alignItems: 'center', gap: theme.spacing(2), paddingVertical: theme.spacing(8) }}>
    <RNText style={{ fontSize: 32 }}>{str(props['glyph'], '🗂')}</RNText>
    <RNText style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>{str(props['title'], 'Пока пусто')}</RNText>
    {str(props['text']) ? (
      <RNText style={{ color: theme.colors.textMuted, fontSize: theme.font.small, textAlign: 'center' }}>{str(props['text'])}</RNText>
    ) : null}
    {children}
  </View>
);

const skeleton: Renderer = ({ props, theme }) => (
  <View style={{ gap: theme.spacing(2) }}>
    {Array.from({ length: num(props['lines'], 3) }, (_, i) => (
      <View
        key={i}
        style={{
          height: 14,
          borderRadius: 7,
          backgroundColor: theme.colors.surfaceAlt,
          width: i === num(props['lines'], 3) - 1 ? '60%' : '100%',
        }}
      />
    ))}
  </View>
);

const confirmSheet: Renderer = ({ props, theme, fire }) => (
  <View
    style={{
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      padding: theme.spacing(4),
      gap: theme.spacing(3),
    }}
  >
    <RNText style={{ color: theme.colors.text, fontSize: theme.font.body, fontWeight: '600' }}>
      {str(props['text'], 'Подтвердить действие?')}
    </RNText>
    <View style={{ flexDirection: 'row', gap: theme.spacing(2) }}>
      <Pressable
        onPress={() => fire('onConfirm')}
        style={{ flex: 1, backgroundColor: theme.colors.accent, borderRadius: theme.radius.md, paddingVertical: theme.spacing(3), alignItems: 'center' }}
      >
        <RNText style={{ color: theme.colors.accentText, fontWeight: '600' }}>{str(props['confirmLabel'], 'Подтверждаю')}</RNText>
      </Pressable>
      <Pressable
        onPress={() => fire('onCancel')}
        style={{ flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.md, paddingVertical: theme.spacing(3), alignItems: 'center' }}
      >
        <RNText style={{ color: theme.colors.text }}>{str(props['cancelLabel'], 'Отмена')}</RNText>
      </Pressable>
    </View>
  </View>
);

/* ----------------------------- составные --------------------------- */

/** Сравнение вариантов — то, ради чего в быту вообще нужен экран, а не текст. */
const comparisonTable: Renderer = ({ props, theme }) => {
  const items = Array.isArray(props['items'])
    ? (props['items'] as Array<{ title?: unknown; subtitle?: unknown; values?: unknown; recommended?: unknown }>)
    : [];
  const criteria = Array.isArray(props['criteria']) ? (props['criteria'] as unknown[]).map((c) => str(c)) : [];

  return (
    <View style={{ gap: theme.spacing(3) }}>
      {items.map((item, i) => {
        const values = Array.isArray(item.values) ? (item.values as unknown[]) : [];
        const recommended = bool(item.recommended);
        return (
          <View
            key={i}
            style={{
              borderWidth: 1,
              borderColor: recommended ? theme.colors.success : theme.colors.border,
              backgroundColor: recommended ? `${theme.colors.success}0D` : theme.colors.surface,
              borderRadius: theme.radius.md,
              padding: theme.spacing(3.5),
              gap: theme.spacing(2),
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(2) }}>
              <RNText style={{ flex: 1, color: theme.colors.text, fontWeight: '700', fontSize: theme.font.body }}>{str(item.title)}</RNText>
              {recommended ? (
                <RNText style={{ color: theme.colors.success, fontSize: theme.font.small, fontWeight: '700' }}>рекомендую</RNText>
              ) : null}
            </View>
            {str(item.subtitle) ? (
              <RNText style={{ color: theme.colors.textMuted, fontSize: theme.font.small }}>{str(item.subtitle)}</RNText>
            ) : null}
            {criteria.map((c, ci) => (
              <View key={ci} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing(2) }}>
                <RNText style={{ color: theme.colors.textMuted, fontSize: theme.font.small }}>{c}</RNText>
                <RNText style={{ color: theme.colors.text, fontSize: theme.font.small, fontWeight: '600' }}>{str(values[ci])}</RNText>
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
};

const stepper: Renderer = ({ props, theme }) => {
  const steps = Array.isArray(props['steps'])
    ? (props['steps'] as Array<{ title?: unknown; status?: unknown }>)
    : [];
  return (
    <View style={{ gap: theme.spacing(2) }}>
      {steps.map((s, i) => {
        const status = str(s.status, 'pending');
        const color =
          status === 'done' ? theme.colors.success : status === 'running' ? theme.colors.accent : status === 'failed' ? theme.colors.danger : theme.colors.border;
        return (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}>
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: color,
                backgroundColor: status === 'done' ? color : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <RNText style={{ fontSize: 11, color: status === 'done' ? theme.colors.surface : color, fontWeight: '800' }}>
                {status === 'done' ? '✓' : status === 'failed' ? '!' : String(i + 1)}
              </RNText>
            </View>
            <RNText
              style={{
                flex: 1,
                color: status === 'pending' ? theme.colors.textMuted : theme.colors.text,
                fontSize: theme.font.body,
              }}
            >
              {str(s.title)}
            </RNText>
          </View>
        );
      })}
    </View>
  );
};

const form: Renderer = ({ theme, children }) => <View style={{ gap: theme.spacing(3) }}>{children}</View>;

/* ------------------------------------------------------------------ */

export const REGISTRY: Record<ComponentType, Renderer> = {
  screen, scroll, stack, row, grid, section, card, divider, spacer,
  heading, text, label, badge, markdown,
  image, icon, avatar,
  list, listItem, checklist, table, keyValue, chart, progress, stat, timeline, calendar,
  textField, textArea, numberField, select, multiSelect, radioGroup, checkbox, toggle, slider, rating, datePicker, timePicker,
  button, buttonGroup, link,
  alert, emptyState, skeleton, confirmSheet,
  comparisonTable, stepper, form,
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
