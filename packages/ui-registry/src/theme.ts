import type { TextStyle } from 'react-native';

/**
 * Токены оформления.
 *
 * Модель не выбирает цвета, отступы и кегли — она выбирает компоненты и тон.
 * Иначе каждый сгенерированный экран выглядел бы как отдельное приложение,
 * и никакой привычки к интерфейсу не возникло бы.
 *
 * Токены — не украшение, а единственное место, где дизайн переживает
 * генерацию: экран, которого никто не видел, соберётся правильно только
 * если правильность заложена здесь.
 */

/* ------------------------------------------------------------------ */
/* Типографика                                                         */
/* ------------------------------------------------------------------ */

export interface TypeStep {
  size: number;
  lineHeight: number;
  weight: TextStyle['fontWeight'];
  tracking: number;
}

/**
 * Шкала.
 *
 * Прежняя (26/19/16/15/13) имела шаги 1.19 / 1.13 / 1.07 — на глаз это одна
 * ступень, размазанная на пять. Здесь шаги 1.36 / 1.29 / 1.21, то есть
 * различимые; `body` поднят до 17 — это Body в iOS, а 15 читался мелким
 * ровно там, где продукт просит доверия.
 *
 * `micro` — служебная ступень: время, засечки, атрибуция источника. Никогда
 * не несёт содержания и никогда не стоит над заголовком.
 */
export const type_ = {
  h1: { size: 30, lineHeight: 34, weight: '700', tracking: -0.5 },
  h2: { size: 22, lineHeight: 28, weight: '700', tracking: -0.2 },
  /** Заголовок строки: тот же кегль, что и текст, но другой вес. */
  h3: { size: 17, lineHeight: 22, weight: '600', tracking: 0 },
  body: { size: 17, lineHeight: 25, weight: '400', tracking: 0 },
  small: { size: 14, lineHeight: 19, weight: '400', tracking: 0 },
  micro: { size: 12, lineHeight: 16, weight: '600', tracking: 0.3 },
} as const satisfies Record<string, TypeStep>;

export type TypeName = keyof typeof type_;

/**
 * Стиль текста из ступени. Один вызов вместо четырёх свойств в каждом
 * компоненте — иначе интерлиньяж забывается, и он действительно был забыт
 * на 75% узлов.
 */
export function textStyle(step: TypeStep, color: string, over?: Partial<TextStyle>): TextStyle {
  return {
    fontSize: step.size,
    lineHeight: step.lineHeight,
    fontWeight: step.weight,
    letterSpacing: step.tracking,
    color,
    ...over,
  };
}

/** Числа в колонке обязаны иметь одинаковую ширину цифр. */
export const TABULAR: TextStyle = { fontVariant: ['tabular-nums'] };

/* ------------------------------------------------------------------ */
/* Размеры и движение                                                  */
/* ------------------------------------------------------------------ */

/** Минимальная цель касания. iOS HIG: 44×44 pt, без исключений. */
export const TARGET = 44;

/**
 * Длительности. Всё, что дольше 300 мс на обратной связи, читается как
 * задержка, а не как движение.
 */
export const DURATION = {
  press: 90,
  release: 160,
  enter: 220,
  /** Единственный авторский момент: закрытие дела. */
  moment: 300,
} as const;

/** Насколько нажатие сжимает элемент. Меньше — не чувствуется, больше — дёргает. */
export const PRESS_SCALE = 0.97;

export interface Theme {
  colors: {
    bg: string;
    surface: string;
    surfaceAlt: string;
    border: string;
    text: string;
    textMuted: string;
    accent: string;
    accentText: string;
    success: string;
    warning: string;
    danger: string;
    dangerText: string;
  };
  spacing: (n: number) => number;
  radius: { sm: number; md: number; lg: number };
  font: typeof type_;
}

const spacing = (n: number): number => n * 4;
const radius = { sm: 6, md: 10, lg: 14 };

export const lightTheme: Theme = {
  colors: {
    bg: '#F5F5F4',
    surface: '#FFFFFF',
    surfaceAlt: '#FAFAF9',
    border: '#D6D3D1',
    text: '#1C1917',
    /*
     * Было #78716C — 4.40:1 на фоне страницы, то есть провал AA на тексте,
     * который несёт половину интерфейса. Замерено, а не оценено на глаз.
     */
    textMuted: '#615B55',
    accent: '#C2410C',
    accentText: '#FFFFFF',
    success: '#15803D',
    /* Было #B45309 — 4.04:1 на собственной подложке бейджа срока. */
    warning: '#92400E',
    danger: '#B91C1C',
    dangerText: '#FFFFFF',
  },
  spacing,
  radius,
  font: type_,
};

export const darkTheme: Theme = {
  colors: {
    bg: '#1C1917',
    surface: '#292524',
    surfaceAlt: '#231F1D',
    border: '#57534E',
    text: '#FAFAF9',
    textMuted: '#A8A29E',
    accent: '#FB923C',
    accentText: '#1C1917',
    success: '#4ADE80',
    warning: '#FBBF24',
    /*
     * Было #F87171 — мягкий лососевый, который читался МЕНЕЕ тревожно, чем
     * оранжевый primary: иерархия переворачивалась в самый ответственный
     * момент продукта. Первая попытка (#F04438) насыщеннее, но давала на
     * поверхности 4.04:1 — то есть чинила иерархию, ломая читаемость.
     * Здесь и то и другое: 5.43:1 на поверхности при более красном тоне.
     */
    danger: '#FF6B5E',
    dangerText: '#1C1917',
  },
  spacing,
  radius,
  font: type_,
};

export type Tone = 'default' | 'muted' | 'success' | 'warning' | 'danger';

export function toneColor(theme: Theme, tone: Tone | undefined): string {
  switch (tone) {
    case 'muted': return theme.colors.textMuted;
    case 'success': return theme.colors.success;
    case 'warning': return theme.colors.warning;
    case 'danger': return theme.colors.danger;
    default: return theme.colors.text;
  }
}

/**
 * Чей сейчас ход.
 *
 * Ось, вокруг которой построены компоненты агентности. Три состояния из
 * четырёх намеренно ахроматичны: цвет остаётся ровно одному — «твой ход», —
 * и потому означает что-то, а не украшает.
 */
export type Turn = 'agent' | 'intent' | 'world' | 'user';

export function turnColor(theme: Theme, turn: Turn): string {
  return turn === 'user' ? theme.colors.accent : theme.colors.textMuted;
}
