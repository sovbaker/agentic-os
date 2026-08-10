import type { ReactNode } from 'react';
import { Image, ScrollView, Text as RNText, TextInput, View } from 'react-native';
import type { ComponentType, IconName } from '@agentic-os/contracts';
import { Icon } from './Icon';
import { Tap } from './Tap';
import { TABULAR, TARGET, textStyle, toneColor, turnColor, type Theme, type Tone, type Turn } from './theme';

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
 *
 * ВАЖНО: рендереры вызываются как функции, а не как JSX-элементы, поэтому
 * хуков внутри них быть не может. Всё, что требует состояния или анимации,
 * живёт в настоящих компонентах — `Tap`, `Icon` — и используется отсюда.
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

const ICONS = new Set<string>([
  'check', 'close', 'plus', 'minus',
  'chevronLeft', 'chevronRight', 'chevronDown', 'arrowRight',
  'dot', 'ring', 'ringDashed', 'diamond', 'square',
  'clock', 'calendar', 'bell', 'flag', 'star',
  'doc', 'home', 'car', 'plane', 'pill', 'bag', 'search', 'mic',
]);

/** Имя вне закрытого набора не рисуется ничем: молчание честнее чужого знака. */
const iconName = (v: unknown, fallback: IconName): IconName =>
  typeof v === 'string' && ICONS.has(v) ? (v as IconName) : fallback;

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

const screen: Renderer = ({ props, theme, children }) => (
  <ScrollView
    style={{ flex: 1, backgroundColor: theme.colors.bg }}
    contentContainerStyle={{
      padding: theme.spacing(4),
      gap: theme.spacing(3),
      paddingBottom: theme.spacing(10),
    }}
    /*
     * Заголовок экрана объявлен на каждой спеке и раньше выбрасывался здесь.
     * Из-за этого у продукта не было ни шапки, ни указания местоположения —
     * а раз шапки нет, то и возврата некуда поместить. Он рисуется оболочкой,
     * но объявляется тут: скринридер должен слышать, куда он попал.
     */
    accessibilityLabel={str(props['title']) || undefined}
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
      // flex-start, а не center: строка с подсказкой и без неё вставали
      // на разной базовой линии, и это было видно на реестре.
      alignItems: str(props['align'], 'flex-start') as 'flex-start',
      flexWrap: bool(props['wrap']) ? 'wrap' : 'nowrap',
      gap: theme.spacing(num(props['gap'], 2)),
      justifyContent: str(props['justify'], 'flex-start') as 'flex-start',
    }}
  >
    {children}
  </View>
);

/**
 * Сетка.
 *
 * Раньше ширина считалась как `100/columns - 2%`, а зазор задавался пикселями
 * на родителе. При `gap ≥ 4` (16 px) сумма превышала ширину контейнера, и
 * сетка молча схлопывалась в одну колонку — экран приватности рендерился
 * четырьмя полноширинными блоками вместо 2×2, а фикстура с `gap: 2` дефект
 * не показывала. Проценты и пиксели больше не складываются: зазор живёт
 * внутренними отступами ячеек.
 */
const grid: Renderer = ({ props, theme, children }) => {
  const columns = Math.max(1, num(props['columns'], 2));
  const half = theme.spacing(num(props['gap'], 2)) / 2;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -half }}>
      {Array.isArray(children)
        ? children.map((child, i) => (
            <View key={i} style={{ width: `${100 / columns}%`, paddingHorizontal: half, paddingBottom: half * 2 }}>
              {child}
            </View>
          ))
        : children}
    </View>
  );
};

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
    <Tap onPress={() => fire('onPress')} label={str(props['title']) || undefined} quiet>
      {body}
    </Tap>
  );
};

const divider: Renderer = ({ theme }) => <View style={{ height: 1, backgroundColor: theme.colors.border }} />;

const spacer: Renderer = ({ props, theme }) => <View style={{ height: theme.spacing(num(props['size'], 2)) }} />;

/* ------------------------------ текст ------------------------------ */

const heading: Renderer = ({ props, theme }) => {
  const level = num(props['level'], 2);
  const step = level === 1 ? theme.font.h1 : level === 2 ? theme.font.h2 : theme.font.h3;
  return (
    <RNText
      accessibilityRole="header"
      style={textStyle(step, theme.colors.text, level === 3 ? { fontWeight: '700' } : undefined)}
    >
      {str(props['text'])}
    </RNText>
  );
};

const text: Renderer = ({ props, theme }) => (
  <RNText style={textStyle(theme.font.body, toneColor(theme, tone(props['tone'])))}>{str(props['text'])}</RNText>
);

const label: Renderer = ({ props, theme }) => (
  <RNText style={textStyle(theme.font.small, theme.colors.textMuted, { fontWeight: '600' })}>
    {str(props['text'])}
  </RNText>
);

const badge: Renderer = ({ props, theme }) => {
  const color = toneColor(theme, tone(props['tone']));
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing(1.5),
        paddingHorizontal: theme.spacing(2.5),
        paddingVertical: theme.spacing(1.5),
        borderRadius: theme.radius.sm,
        backgroundColor: `${color}1A`,
        borderWidth: 1,
        borderColor: `${color}40`,
      }}
    >
      {/* Значение никогда не передаётся одним цветом: у тона есть знак. */}
      {tone(props['tone']) !== 'default' ? (
        <Icon name={iconName(props['icon'], tone(props['tone']) === 'warning' ? 'clock' : 'dot')} size={14} color={color} />
      ) : null}
      <RNText style={textStyle(theme.font.small, color, { fontWeight: '700' })}>{str(props['text'])}</RNText>
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
                <View key={li} style={{ flexDirection: 'row', gap: theme.spacing(2), alignItems: 'flex-start' }}>
                  <View style={{ paddingTop: 6 }}>
                    <Icon name="dot" size={8} color={theme.colors.textMuted} />
                  </View>
                  <RNText style={[textStyle(theme.font.body, theme.colors.text), { flex: 1 }]}>
                    {line.replace(/^\s*[-*•]\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1')}
                  </RNText>
                </View>
              ))}
            </View>
          );
        }
        return (
          <RNText key={bi} style={textStyle(theme.font.body, theme.colors.text)}>
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
  const alt = str(props['alt']);
  if (!uri) return null;
  return (
    <Image
      source={{ uri }}
      accessible
      accessibilityLabel={alt || 'Изображение'}
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

const icon: Renderer = ({ props, theme }) => (
  <Icon
    name={iconName(props['name'], 'dot')}
    size={num(props['size'], 20)}
    color={toneColor(theme, tone(props['tone']))}
    filled={bool(props['filled'])}
  />
);

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
      accessible
      accessibilityLabel={name}
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

const list: Renderer = ({ theme, children }) => <View style={{ gap: theme.spacing(0.5) }}>{children}</View>;
const checklist: Renderer = ({ props, theme, children }) => {
  const done = num(props['done'], -1);
  const total = num(props['total'], -1);
  return (
    <View style={{ gap: theme.spacing(0.5) }}>
      {/* «2 из 6» — единственный дешёвый способ показать движение к цели. */}
      {done >= 0 && total > 0 ? (
        <RNText style={[textStyle(theme.font.micro, theme.colors.textMuted), TABULAR, { paddingBottom: theme.spacing(1) }]}>
          {done} из {total}
        </RNText>
      ) : null}
      {children}
    </View>
  );
};

const listItem: Renderer = ({ props, theme, fire, hasAction }) => {
  const checked = bool(props['checked']);
  const showCheckbox = 'checked' in props;
  const subtitle = str(props['subtitle']);
  const trailing = str(props['trailing']);
  const title = str(props['title']);

  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing(3), paddingVertical: theme.spacing(2) }}>
      {showCheckbox ? (
        <View
          style={{
            width: 24, height: 24, borderRadius: 12,
            borderWidth: 2,
            borderColor: checked ? theme.colors.success : theme.colors.border,
            backgroundColor: checked ? theme.colors.success : 'transparent',
            alignItems: 'center', justifyContent: 'center',
            marginTop: 1,
          }}
        >
          {checked ? <Icon name="check" size={16} color={theme.colors.surface} /> : null}
        </View>
      ) : null}

      <View style={{ flex: 1, gap: 2 }}>
        <RNText
          style={textStyle(theme.font.body, checked ? theme.colors.textMuted : theme.colors.text, {
            textDecorationLine: checked ? 'line-through' : 'none',
          })}
        >
          {title}
        </RNText>
        {subtitle ? <RNText style={textStyle(theme.font.small, theme.colors.textMuted)}>{subtitle}</RNText> : null}
      </View>

      {trailing ? <RNText style={[textStyle(theme.font.small, theme.colors.textMuted), TABULAR]}>{trailing}</RNText> : null}
    </View>
  );

  if (!hasAction('onPress')) return body;
  return (
    <Tap
      onPress={() => fire('onPress')}
      label={title}
      role={showCheckbox ? 'checkbox' : 'button'}
      {...(showCheckbox ? { checked } : {})}
    >
      {body}
    </Tap>
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
            <RNText key={i} style={[textStyle(theme.font.micro, theme.colors.textMuted), { flex: 1, padding: theme.spacing(2.5) }]}>
              {h}
            </RNText>
          ))}
        </View>
      ) : null}
      {body.map((r, ri) => (
        <View key={ri} style={{ flexDirection: 'row', borderTopWidth: ri === 0 && headers.length === 0 ? 0 : 1, borderTopColor: theme.colors.border }}>
          {r.map((cell, ci) => (
            <RNText key={ci} style={[textStyle(theme.font.small, theme.colors.text), TABULAR, { flex: 1, padding: theme.spacing(2.5) }]}>
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
        <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing(3), alignItems: 'flex-start' }}>
          <RNText style={[textStyle(theme.font.small, theme.colors.textMuted), { flex: 1 }]}>{str(p.key)}</RNText>
          <RNText style={[textStyle(theme.font.small, theme.colors.text, { fontWeight: '600' }), TABULAR, { flex: 1, textAlign: 'right' }]}>
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
        <View key={i} style={{ gap: 4 }} accessible accessibilityLabel={`${s.label}: ${s.value}`}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing(2) }}>
            {/* Ширина не фиксирована: при 200% кегля фиксированная колонка сталкивается. */}
            <RNText style={[textStyle(theme.font.small, theme.colors.textMuted), { flex: 1 }]}>{s.label}</RNText>
            <RNText style={[textStyle(theme.font.small, theme.colors.text, { fontWeight: '600' }), TABULAR]}>{s.value}</RNText>
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
  const labelText = str(props['label']);
  return (
    <View style={{ gap: 6 }} accessible accessibilityLabel={`${labelText} ${Math.round(value * 100)}%`}>
      {labelText ? <RNText style={textStyle(theme.font.small, theme.colors.textMuted)}>{labelText}</RNText> : null}
      <View style={{ height: 10, borderRadius: 5, backgroundColor: theme.colors.surfaceAlt, overflow: 'hidden' }}>
        <View style={{ width: `${value * 100}%`, height: '100%', backgroundColor: theme.colors.success }} />
      </View>
    </View>
  );
};

const stat: Renderer = ({ props, theme }) => (
  <View style={{ gap: 2 }}>
    <RNText style={textStyle(theme.font.small, theme.colors.textMuted)}>{str(props['label'])}</RNText>
    <RNText style={[textStyle(theme.font.h2, toneColor(theme, tone(props['tone']))), TABULAR]}>{str(props['value'])}</RNText>
    {str(props['hint']) ? <RNText style={textStyle(theme.font.micro, theme.colors.textMuted)}>{str(props['hint'])}</RNText> : null}
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
          <View style={{ alignItems: 'center', width: 12 }}>
            <View style={{ marginTop: 6 }}>
              <Icon name={bool(item.done) ? 'dot' : 'ring'} size={12} color={bool(item.done) ? theme.colors.success : theme.colors.border} />
            </View>
            {i < items.length - 1 ? <View style={{ width: 2, flex: 1, backgroundColor: theme.colors.border, marginTop: 4 }} /> : null}
          </View>
          <View style={{ flex: 1, paddingBottom: theme.spacing(1) }}>
            <RNText style={textStyle(theme.font.body, theme.colors.text)}>{str(item.title)}</RNText>
            {str(item.at) ? <RNText style={[textStyle(theme.font.micro, theme.colors.textMuted), TABULAR]}>{str(item.at)}</RNText> : null}
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
    return <RNText style={textStyle(theme.font.small, theme.colors.textMuted)}>Событий нет</RNText>;
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
          <RNText style={[textStyle(theme.font.small, theme.colors.accent, { fontWeight: '600' }), TABULAR, { minWidth: 92 }]}>
            {fmt(str(e.startsAt))}
          </RNText>
          <View style={{ flex: 1 }}>
            <RNText style={textStyle(theme.font.body, theme.colors.text)}>{str(e.title)}</RNText>
            {str(e.location) ? <RNText style={textStyle(theme.font.small, theme.colors.textMuted)}>{str(e.location)}</RNText> : null}
          </View>
        </View>
      ))}
    </View>
  );
};

/* --------------------------- агентность ---------------------------- */

/**
 * Четыре компонента про то единственное, чем продукт отличается от списка дел.
 *
 * Ось у всех одна — чей сейчас ход. Три состояния из четырёх намеренно
 * ахроматичны, цвет остаётся ровно одному — «твой ход», — и поэтому означает
 * что-то, а не украшает.
 */

function turnRow(theme: Theme, turn: Turn, icon: IconName, filled: boolean, children: ReactNode): ReactNode {
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing(3), alignItems: 'flex-start' }}>
      {/* Жёлоб очерёдности: марка хода и ничего больше. */}
      <View style={{ width: 20, alignItems: 'center', paddingTop: 3 }}>
        <Icon name={icon} size={18} color={turnColor(theme, turn)} filled={filled} />
      </View>
      <View style={{ flex: 1, gap: theme.spacing(1) }}>{children}</View>
    </View>
  );
}

/** «Я это сделал» — единица метрики TCFY и место, где закрывается задача. */
const agentDid: Renderer = ({ props, theme, fire, hasAction }) => {
  const title = str(props['title']);
  const at = str(props['at']);
  const undoUntil = str(props['undoUntil']);

  return turnRow(theme, 'agent', 'dot', true, (
    <>
      <RNText accessibilityLabel={`Сделано: ${title}`} style={textStyle(theme.font.h3, theme.colors.text)}>
        {title}
      </RNText>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3), flexWrap: 'wrap' }}>
        {at ? <RNText style={[textStyle(theme.font.micro, theme.colors.textMuted), TABULAR]}>{at}</RNText> : null}
        {/*
          Отмена не исчезает молча: пока она есть — это действие с честным
          сроком, когда истекла — приглушённая строка, а не пустота.
        */}
        {hasAction('onUndo') && undoUntil ? (
          <Tap onPress={() => fire('onUndo')} label={`Отменить: ${title}`} slop>
            <RNText style={textStyle(theme.font.micro, theme.colors.accent, { fontWeight: '700' })}>
              отменить · {undoUntil}
            </RNText>
          </Tap>
        ) : (
          <RNText style={textStyle(theme.font.micro, theme.colors.textMuted)}>отменить уже нельзя</RNText>
        )}
      </View>
    </>
  ));
};

/**
 * «Собираюсь сделать» — визуальная форма потолка доверия MVP.
 *
 * Показывает не «подтвердить действие?», а что именно изменится и что уйдёт
 * наружу. Дифф без перечня уходящего — это про поля формы, а не про
 * последствия.
 */
const agentIntent: Renderer = ({ props, theme, fire, hasAction }) => {
  const title = str(props['title']);
  const before = str(props['before']);
  const after = str(props['after']);
  const discloses = str(props['discloses']);

  return turnRow(theme, 'intent', 'ring', false, (
    <>
      <RNText style={textStyle(theme.font.h3, theme.colors.text)}>{title}</RNText>

      {before || after ? (
        <View style={{ gap: 2, paddingVertical: theme.spacing(1) }}>
          {before ? (
            <RNText style={textStyle(theme.font.small, theme.colors.textMuted, { textDecorationLine: 'line-through' })}>
              {before}
            </RNText>
          ) : null}
          {after ? <RNText style={textStyle(theme.font.small, theme.colors.text, { fontWeight: '600' })}>{after}</RNText> : null}
        </View>
      ) : null}

      {discloses ? (
        <View style={{ flexDirection: 'row', gap: theme.spacing(2), alignItems: 'flex-start' }}>
          <View style={{ paddingTop: 2 }}>
            <Icon name="doc" size={14} color={theme.colors.warning} />
          </View>
          <RNText style={[textStyle(theme.font.micro, theme.colors.warning), { flex: 1 }]}>Уйдёт наружу: {discloses}</RNText>
        </View>
      ) : null}

      {hasAction('onConfirm') ? (
        <View style={{ gap: theme.spacing(1.5), paddingTop: theme.spacing(1) }}>
          <Tap
            onPress={() => fire('onConfirm')}
            label={`Подтвердить: ${title}`}
            style={{
              backgroundColor: theme.colors.accent,
              borderRadius: theme.radius.md,
              paddingVertical: theme.spacing(3),
              paddingHorizontal: theme.spacing(4),
              alignItems: 'center',
            }}
          >
            <RNText style={textStyle(theme.font.body, theme.colors.accentText, { fontWeight: '600' })}>
              {str(props['confirmLabel'], 'Подтверждаю')}
            </RNText>
          </Tap>
          <RNText style={textStyle(theme.font.micro, theme.colors.textMuted)}>
            Пока не подтвердишь — ничего не отправляю
          </RNText>
        </View>
      ) : null}
    </>
  ));
};

/** «Жду ответа от X» — состояние между «взял» и «сделал», которого не было вовсе. */
const awaiting: Renderer = ({ props, theme, fire, hasAction }) => {
  const who = str(props['who'], 'ответа');
  const since = str(props['since']);
  const usually = str(props['usually']);

  return turnRow(theme, 'world', 'ringDashed', false, (
    <>
      <RNText style={textStyle(theme.font.h3, theme.colors.text)}>Жду ответа: {who}</RNText>
      <View style={{ flexDirection: 'row', gap: theme.spacing(3), flexWrap: 'wrap', alignItems: 'center' }}>
        {since ? <RNText style={[textStyle(theme.font.micro, theme.colors.textMuted), TABULAR]}>с {since}</RNText> : null}
        {usually ? <RNText style={textStyle(theme.font.micro, theme.colors.textMuted)}>обычно {usually}</RNText> : null}
        {hasAction('onNudge') ? (
          <Tap onPress={() => fire('onNudge')} label={`Напомнить: ${who}`} slop>
            <RNText style={textStyle(theme.font.micro, theme.colors.accent, { fontWeight: '700' })}>пнуть</RNText>
          </Tap>
        ) : null}
      </View>
    </>
  ));
};

/**
 * Атрибуция факта.
 *
 * В графе у каждого факта есть источник и уверенность, и до сих пор их
 * приходилось протаскивать строкой в подзаголовок. Два независимых канала:
 * КТО сказал и НАСКОЛЬКО уверенно — потому что модель различает семь
 * источников и непрерывную уверенность, а одна заливка кодирует одно.
 */
const sourceStamp: Renderer = ({ props, theme, fire, hasAction }) => {
  const source = str(props['source'], 'предположение');
  const confidence = Math.max(0, Math.min(1, num(props['confidence'], 0.5)));
  const segments = Math.max(1, Math.round(confidence * 3));
  const guessed = confidence < 0.5;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(2), flexWrap: 'wrap' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.5) }}>
        <Icon name={guessed ? 'ringDashed' : 'ring'} size={12} color={theme.colors.textMuted} filled={!guessed} />
        <RNText style={textStyle(theme.font.micro, theme.colors.textMuted)}>{source}</RNText>
      </View>
      <View
        style={{ flexDirection: 'row', gap: 2 }}
        accessible
        accessibilityLabel={`уверенность ${Math.round(confidence * 100)} процентов`}
      >
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={{
              width: 10, height: 3, borderRadius: 2,
              backgroundColor: i < segments ? theme.colors.textMuted : theme.colors.border,
            }}
          />
        ))}
      </View>
      {hasAction('onDispute') ? (
        <Tap onPress={() => fire('onDispute')} label="Это неверно" slop>
          <RNText style={textStyle(theme.font.micro, theme.colors.accent, { fontWeight: '700' })}>это неверно</RNText>
        </Tap>
      ) : null}
    </View>
  );
};

/* ------------------------------- ввод ------------------------------ */

function field(theme: Theme, children: ReactNode, labelText: string): ReactNode {
  return (
    <View style={{ gap: theme.spacing(1.5) }}>
      {/* Подпись всегда НАД полем и всегда есть: placeholder не подпись. */}
      {labelText ? (
        <RNText style={textStyle(theme.font.small, theme.colors.textMuted, { fontWeight: '600' })}>{labelText}</RNText>
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
    fontSize: theme.font.body.size,
    lineHeight: theme.font.body.lineHeight,
    minHeight: multiline ? 96 : TARGET,
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
      accessibilityLabel={str(props['label']) || str(props['placeholder'])}
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
      accessibilityLabel={str(props['label']) || str(props['placeholder'])}
      multiline
      onChangeText={(v) => fire('onChange', v)}
      onSubmitEditing={(e) => fire('onSubmit', e.nativeEvent.text)}
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
      accessibilityLabel={str(props['label']) || str(props['placeholder'])}
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
  onPick: (value: string) => void,
  role: 'checkbox' | 'radio' = 'radio'
): ReactNode {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(2) }}>
      {items.map((opt) => {
        const active = selected.includes(opt.value);
        return (
          <Tap
            key={opt.value}
            onPress={() => onPick(opt.value)}
            label={opt.label}
            role={role}
            checked={active}
            style={{
              paddingHorizontal: theme.spacing(3.5),
              paddingVertical: theme.spacing(2.5),
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: active ? theme.colors.accent : theme.colors.border,
              backgroundColor: active ? `${theme.colors.accent}1A` : theme.colors.surfaceAlt,
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing(1.5),
            }}
          >
            {/* Выбор кодируется не только цветом: у выбранного есть знак. */}
            {active ? <Icon name="check" size={14} color={theme.colors.accent} /> : null}
            <RNText style={textStyle(theme.font.small, active ? theme.colors.accent : theme.colors.text, { fontWeight: active ? '700' : '400' })}>
              {opt.label}
            </RNText>
          </Tap>
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
    chips(
      theme,
      options(props['options']),
      selected,
      (v) => fire('onChange', selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]),
      'checkbox'
    ),
    str(props['label'])
  );
};

const radioGroup: Renderer = ({ props, theme, fire }) => {
  const selected = str(props['value']);
  return field(
    theme,
    <View style={{ gap: theme.spacing(1) }}>
      {options(props['options']).map((opt) => {
        const active = opt.value === selected;
        return (
          <Tap
            key={opt.value}
            onPress={() => fire('onChange', opt.value)}
            label={opt.label}
            role="radio"
            checked={active}
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}
          >
            <View
              style={{
                width: 22, height: 22, borderRadius: 11,
                borderWidth: 2,
                borderColor: active ? theme.colors.accent : theme.colors.border,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              {active ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.accent }} /> : null}
            </View>
            <RNText style={[textStyle(theme.font.body, theme.colors.text), { flex: 1 }]}>{opt.label}</RNText>
          </Tap>
        );
      })}
    </View>,
    str(props['label'])
  );
};

const checkbox: Renderer = ({ props, theme, fire }) => {
  const checked = bool(props['value']);
  const labelText = str(props['label']);
  return (
    <Tap
      onPress={() => fire('onChange', !checked)}
      label={labelText}
      role="checkbox"
      checked={checked}
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}
    >
      {/*
        Форма та же, что у пункта чек-листа: одно понятие — одна форма.
        Раньше здесь был оранжевый квадрат, а в списке зелёный круг.
      */}
      <View
        style={{
          width: 24, height: 24, borderRadius: 12,
          borderWidth: 2,
          borderColor: checked ? theme.colors.success : theme.colors.border,
          backgroundColor: checked ? theme.colors.success : 'transparent',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        {checked ? <Icon name="check" size={16} color={theme.colors.surface} /> : null}
      </View>
      <RNText style={[textStyle(theme.font.body, theme.colors.text), { flex: 1 }]}>{labelText}</RNText>
    </Tap>
  );
};

const toggle: Renderer = ({ props, theme, fire }) => {
  const on = bool(props['value']);
  const labelText = str(props['label']);
  return (
    <Tap
      onPress={() => fire('onChange', !on)}
      label={labelText}
      role="switch"
      checked={on}
      style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}
    >
      <RNText style={[textStyle(theme.font.body, theme.colors.text), { flex: 1 }]}>{labelText}</RNText>
      <View
        style={{
          width: 48, height: 30, borderRadius: 15, padding: 3,
          backgroundColor: on ? theme.colors.success : theme.colors.surfaceAlt,
          borderWidth: 1,
          borderColor: on ? theme.colors.success : theme.colors.border,
          alignItems: on ? 'flex-end' : 'flex-start',
        }}
      >
        {/*
          Ручке нужна собственная граница: белая ручка на светлой дорожке
          давала контраст 1.15:1, то есть выключенный тумблер был невидим.
        */}
        <View
          style={{
            width: 22, height: 22, borderRadius: 11,
            backgroundColor: theme.colors.surface,
            borderWidth: 1, borderColor: on ? theme.colors.success : theme.colors.textMuted,
          }}
        />
      </View>
    </Tap>
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

  const stepper = (name: IconName, next: number, disabled: boolean, label: string): ReactNode => (
    <Tap
      disabled={disabled}
      onPress={() => fire('onChange', next)}
      label={label}
      style={{
        width: TARGET, height: TARGET,
        borderRadius: theme.radius.sm,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <Icon name={name} size={20} color={theme.colors.text} />
    </Tap>
  );

  return field(
    theme,
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}>
      {stepper('minus', Math.max(min, value - step), value <= min, 'Уменьшить')}
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: theme.colors.surfaceAlt, overflow: 'hidden' }}>
          <View style={{ width: `${ratio * 100}%`, height: '100%', backgroundColor: theme.colors.accent }} />
        </View>
        <RNText style={[textStyle(theme.font.small, theme.colors.text, { fontWeight: '600' }), TABULAR, { textAlign: 'center' }]}>
          {value}
          {str(props['unit']) ? ` ${str(props['unit'])}` : ''}
        </RNText>
      </View>
      {stepper('plus', Math.min(max, value + step), value >= max, 'Увеличить')}
    </View>,
    str(props['label'])
  );
};

const rating: Renderer = ({ props, theme, fire }) => {
  const value = num(props['value'], 0);
  const max = num(props['max'], 5);
  return field(
    theme,
    <View style={{ flexDirection: 'row', gap: theme.spacing(1) }}>
      {Array.from({ length: max }, (_, i) => (
        <Tap
          key={i}
          onPress={() => fire('onChange', i + 1)}
          label={`Оценка ${i + 1} из ${max}`}
          selected={i < value}
          style={{ width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="star" size={24} color={i < value ? theme.colors.warning : theme.colors.border} />
        </Tap>
      ))}
    </View>,
    str(props['label'])
  );
};

/** Выбор даты и времени — быстрыми вариантами. Нативный пикер требует dev build. */
const datePicker: Renderer = ({ props, theme, fire }) => {
  const custom = options(props['options']);
  const items =
    custom.length > 0
      ? custom
      : // Четыре варианта, а не шесть: больше четырёх — уже не выбор, а список.
        [0, 1, 7, 30].map((days) => {
          const d = new Date(Date.now() + days * 86_400_000);
          return {
            value: d.toISOString().slice(0, 10),
            label: days === 0 ? 'сегодня' : days === 1 ? 'завтра' : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(d),
          };
        });
  return field(theme, chips(theme, items, str(props['value']) ? [str(props['value'])] : [], (v) => fire('onChange', v)), str(props['label'], 'Дата'));
};

const timePicker: Renderer = ({ props, theme, fire }) => {
  const custom = options(props['options']);
  const items = custom.length > 0 ? custom : ['09:00', '13:00', '18:00', '21:00'].map((t) => ({ value: t, label: t }));
  return field(theme, chips(theme, items, str(props['value']) ? [str(props['value'])] : [], (v) => fire('onChange', v)), str(props['label'], 'Время'));
};

/* ----------------------------- действия ---------------------------- */

/**
 * Кнопка.
 *
 * Три состояния вместо одного. Раньше после выполнения кнопка не менялась и
 * оставалась активной: это приглашало второе нажатие и дублирующее действие,
 * а закрытие задачи выглядело как строка системного лога.
 */
const button: Renderer = ({ props, theme, fire }) => {
  const variant = str(props['variant'], 'primary');
  const state = str(props['state'], 'idle');
  const done = state === 'done';
  const pending = state === 'pending';
  const disabled = bool(props['disabled']) || done || pending;

  const primary = variant === 'primary' && !done;
  const danger = variant === 'danger' && !done;

  const bg = done ? `${theme.colors.success}1A` : danger ? theme.colors.danger : primary ? theme.colors.accent : 'transparent';
  const fg = done ? theme.colors.success : danger ? theme.colors.dangerText : primary ? theme.colors.accentText : theme.colors.text;
  const labelText = done ? str(props['doneLabel'], 'Готово') : pending ? str(props['pendingLabel'], 'Делаю…') : str(props['label'], 'Действие');

  return (
    <Tap
      disabled={disabled}
      onPress={() => fire('onPress')}
      label={labelText}
      style={{
        backgroundColor: bg,
        borderWidth: primary || danger ? 0 : 1,
        borderColor: done ? `${theme.colors.success}55` : theme.colors.border,
        borderRadius: theme.radius.md,
        paddingVertical: theme.spacing(3),
        paddingHorizontal: theme.spacing(5),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing(2),
        opacity: bool(props['disabled']) && !done ? 0.55 : 1,
      }}
    >
      {done ? <Icon name="check" size={18} color={theme.colors.success} /> : null}
      <RNText style={textStyle(theme.font.body, fg, { fontWeight: '600' })}>{labelText}</RNText>
    </Tap>
  );
};

const buttonGroup: Renderer = ({ theme, children }) => (
  <View style={{ flexDirection: 'row', gap: theme.spacing(2) }}>
    {Array.isArray(children) ? children.map((child, i) => <View key={i} style={{ flex: 1 }}>{child}</View>) : children}
  </View>
);

const link: Renderer = ({ props, theme, fire }) => {
  const labelText = str(props['label'], str(props['url']));
  return (
    <Tap onPress={() => fire('onPress')} label={labelText} role="link" style={{ alignSelf: 'flex-start' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.5) }}>
        <RNText style={textStyle(theme.font.body, theme.colors.accent, { fontWeight: '600' })}>{labelText}</RNText>
        <Icon name="arrowRight" size={16} color={theme.colors.accent} />
      </View>
    </Tap>
  );
};

/* --------------------------- обратная связь ------------------------ */

const alert: Renderer = ({ props, theme }) => {
  const t = tone(props['tone']) === 'default' ? 'warning' : tone(props['tone']);
  const color = toneColor(theme, t);
  return (
    <View
      accessibilityRole="alert"
      style={{
        flexDirection: 'row',
        gap: theme.spacing(2.5),
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: `${color}55`,
        backgroundColor: `${color}12`,
        padding: theme.spacing(3.5),
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name={t === 'success' ? 'check' : t === 'danger' ? 'close' : 'flag'} size={18} color={color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        {str(props['title']) ? (
          <RNText style={textStyle(theme.font.small, color, { fontWeight: '700' })}>{str(props['title'])}</RNText>
        ) : null}
        <RNText style={textStyle(theme.font.small, theme.colors.text)}>{str(props['text'])}</RNText>
      </View>
    </View>
  );
};

const emptyState: Renderer = ({ props, theme, children }) => (
  <View style={{ alignItems: 'center', gap: theme.spacing(2), paddingVertical: theme.spacing(8) }}>
    <Icon name={iconName(props['icon'], 'doc')} size={32} color={theme.colors.border} />
    <RNText style={textStyle(theme.font.h3, theme.colors.text)}>{str(props['title'], 'Пока пусто')}</RNText>
    {str(props['text']) ? (
      <RNText style={[textStyle(theme.font.small, theme.colors.textMuted), { textAlign: 'center' }]}>{str(props['text'])}</RNText>
    ) : null}
    {children}
  </View>
);

const skeleton: Renderer = ({ props, theme }) => {
  const lines = num(props['lines'], 3);
  return (
    <View style={{ gap: theme.spacing(2) }} accessible accessibilityLabel="Загружаю">
      {Array.from({ length: lines }, (_, i) => (
        <View
          key={i}
          style={{
            height: 14,
            borderRadius: 7,
            backgroundColor: theme.colors.surfaceAlt,
            width: i === lines - 1 ? '60%' : '100%',
          }}
        />
      ))}
    </View>
  );
};

/**
 * Лист подтверждения.
 *
 * Раньше «Удалить всё безвозвратно» и «Отправить сообщение мастеру?»
 * получали одинаковое тёплое «Подтверждаю»: подтверждение — это модель
 * безопасности продукта, и оно обязано нести сигнал о тяжести последствий.
 *
 * У опасного варианта отмена — визуально доминирующая, а подпись называет
 * действие глаголом: «Подтверждаю» не значит одного и того же под фразой
 * «восстановить будет нельзя».
 */
const confirmSheet: Renderer = ({ props, theme, fire }) => {
  const danger = tone(props['tone']) === 'danger';
  const confirmLabel = str(props['confirmLabel'], danger ? 'Удалить' : 'Подтверждаю');

  return (
    <View
      accessibilityRole="alert"
      style={{
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: danger ? theme.colors.danger : theme.colors.border,
        backgroundColor: theme.colors.surface,
        padding: theme.spacing(4),
        gap: theme.spacing(3),
      }}
    >
      <View style={{ flexDirection: 'row', gap: theme.spacing(2.5), alignItems: 'flex-start' }}>
        {danger ? (
          <View style={{ paddingTop: 2 }}>
            <Icon name="flag" size={18} color={theme.colors.danger} filled />
          </View>
        ) : null}
        <RNText style={[textStyle(theme.font.body, theme.colors.text, { fontWeight: '600' }), { flex: 1 }]}>
          {str(props['text'], 'Подтвердить действие?')}
        </RNText>
      </View>

      {/* У опасного действия порядок обратный: безопасный выбор идёт первым. */}
      <View style={{ flexDirection: danger ? 'column-reverse' : 'row', gap: theme.spacing(2) }}>
        <Tap
          onPress={() => fire('onConfirm')}
          label={confirmLabel}
          style={{
            flex: danger ? undefined : 1,
            backgroundColor: danger ? 'transparent' : theme.colors.accent,
            borderWidth: danger ? 1 : 0,
            borderColor: theme.colors.danger,
            borderRadius: theme.radius.md,
            paddingVertical: theme.spacing(3),
            alignItems: 'center',
          }}
        >
          <RNText style={textStyle(theme.font.body, danger ? theme.colors.danger : theme.colors.accentText, { fontWeight: '600' })}>
            {confirmLabel}
          </RNText>
        </Tap>
        <Tap
          onPress={() => fire('onCancel')}
          label={str(props['cancelLabel'], 'Отмена')}
          style={{
            flex: danger ? undefined : 1,
            backgroundColor: danger ? theme.colors.accent : 'transparent',
            borderWidth: danger ? 0 : 1,
            borderColor: theme.colors.border,
            borderRadius: theme.radius.md,
            paddingVertical: theme.spacing(3),
            alignItems: 'center',
          }}
        >
          <RNText style={textStyle(theme.font.body, danger ? theme.colors.accentText : theme.colors.text, { fontWeight: '600' })}>
            {str(props['cancelLabel'], 'Отмена')}
          </RNText>
        </Tap>
      </View>
    </View>
  );
};

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
              <RNText style={[textStyle(theme.font.h3, theme.colors.text), { flex: 1 }]}>{str(item.title)}</RNText>
              {recommended ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1) }}>
                  <Icon name="check" size={14} color={theme.colors.success} />
                  <RNText style={textStyle(theme.font.micro, theme.colors.success, { fontWeight: '700' })}>рекомендую</RNText>
                </View>
              ) : null}
            </View>
            {str(item.subtitle) ? (
              <RNText style={textStyle(theme.font.small, theme.colors.textMuted)}>{str(item.subtitle)}</RNText>
            ) : null}
            {criteria.map((c, ci) => (
              <View key={ci} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing(2) }}>
                <RNText style={[textStyle(theme.font.small, theme.colors.textMuted), { flex: 1 }]}>{c}</RNText>
                <RNText style={[textStyle(theme.font.small, theme.colors.text, { fontWeight: '600' }), TABULAR]}>{str(values[ci])}</RNText>
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
          status === 'done' ? theme.colors.success
          : status === 'running' ? theme.colors.accent
          : status === 'failed' ? theme.colors.danger
          : theme.colors.border;
        return (
          <View
            key={i}
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(3) }}
            accessible
            accessibilityLabel={`${str(s.title)}: ${status === 'done' ? 'готово' : status === 'failed' ? 'ошибка' : status === 'running' ? 'выполняется' : 'ожидает'}`}
          >
            <View
              style={{
                width: 26, height: 26, borderRadius: 13,
                borderWidth: 2, borderColor: color,
                backgroundColor: status === 'done' ? color : 'transparent',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              {status === 'done' ? (
                <Icon name="check" size={15} color={theme.colors.surface} />
              ) : status === 'failed' ? (
                <Icon name="close" size={14} color={color} />
              ) : (
                <RNText style={[textStyle(theme.font.micro, color, { fontWeight: '800' }), TABULAR]}>{i + 1}</RNText>
              )}
            </View>
            <RNText style={[textStyle(theme.font.body, status === 'pending' ? theme.colors.textMuted : theme.colors.text), { flex: 1 }]}>
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
  agentDid, agentIntent, awaiting, sourceStamp,
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
    <RNText style={textStyle(theme.font.small, theme.colors.textMuted)}>
      {str(props['__fallbackLabel'], 'Этот блок появится после обновления приложения')}
    </RNText>
    {children}
  </View>
);
