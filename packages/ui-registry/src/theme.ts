/**
 * Токены оформления.
 *
 * Модель не выбирает цвета и отступы — она выбирает компоненты и тон.
 * Иначе каждый сгенерированный экран выглядел бы как отдельное приложение,
 * и никакой привычки к интерфейсу не возникло бы.
 */

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
  };
  spacing: (n: number) => number;
  radius: { sm: number; md: number; lg: number };
  font: { h1: number; h2: number; h3: number; body: number; small: number };
}

const spacing = (n: number): number => n * 4;
const radius = { sm: 8, md: 12, lg: 20 };
const font = { h1: 26, h2: 19, h3: 16, body: 15, small: 13 };

export const lightTheme: Theme = {
  colors: {
    bg: '#F5F5F4',
    surface: '#FFFFFF',
    surfaceAlt: '#FAFAF9',
    border: '#E7E5E4',
    text: '#1C1917',
    textMuted: '#78716C',
    accent: '#C2410C',
    accentText: '#FFFFFF',
    success: '#15803D',
    warning: '#B45309',
    danger: '#B91C1C',
  },
  spacing,
  radius,
  font,
};

export const darkTheme: Theme = {
  colors: {
    bg: '#1C1917',
    surface: '#292524',
    surfaceAlt: '#231F1D',
    border: '#44403C',
    text: '#FAFAF9',
    textMuted: '#A8A29E',
    accent: '#FB923C',
    accentText: '#1C1917',
    success: '#4ADE80',
    warning: '#FBBF24',
    danger: '#F87171',
  },
  spacing,
  radius,
  font,
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
