import type { TextStyle } from 'react-native';

/**
 * Токены оформления. Мир — «Оттиск».
 *
 * Вся графика отвечает на один вопрос: ЧЕЙ СЕЙЧАС ХОД. Закрытый ход агента
 * вдавлен в бумагу как оттиск, объявленное намерение стоит контуром
 * («набрано, но не отпечатано»), ожидание мира дано разомкнутым кольцом,
 * и только ход человека имеет цвет.
 *
 * Это не метафора: ось совпадает с состоянием задачи на сервере
 * (`JobStatus`), поэтому марка хода есть чистая функция поля, а не результат
 * композиции конкретного экрана. Экран, которого никто не видел, соберётся
 * правильно сам — а тудушнику этот мир не подойдёт физически: у него нет
 * чужих ходов, и жёлоб очерёдности выродится в колонку чекбоксов.
 *
 * Модель не выбирает цвета, отступы и кегли — она выбирает компоненты и тон.
 * Токены — единственное место, где дизайн переживает генерацию.
 */

/* ------------------------------------------------------------------ */
/* Типографика                                                         */
/* ------------------------------------------------------------------ */

/**
 * Три голоса, и каждый закреплён за своим делом.
 *
 * Bitter — плитный брусковый, голос печатного журнала операций: заголовки
 * экрана и блока. IBM Plex Sans — речь помощника и интерфейс. IBM Plex Mono —
 * реквизит: время, сроки, суммы, атрибуция. Разделение жёсткое, потому что
 * иначе оно не переживёт генерацию: рендерер исполняет его сам, без надежды
 * на ревью каждой спеки.
 *
 * Все три — SIL OFL, все три покрывают кириллицу (проверено по таблице cmap,
 * а не по обещанию на странице шрифта).
 */
export const FONTS = {
  displayBold: 'Bitter_700Bold',
  displaySemi: 'Bitter_600SemiBold',
  sans: 'IBMPlexSans_400Regular',
  sansSemi: 'IBMPlexSans_600SemiBold',
  mono: 'IBMPlexMono_500Medium',
} as const;

export interface TypeStep {
  size: number;
  lineHeight: number;
  weight: TextStyle['fontWeight'];
  tracking: number;
  family: string;
}

/**
 * Шкала.
 *
 * Прежняя (26/19/16/15/13) имела шаги 1.19 / 1.13 / 1.07 — на глаз это одна
 * ступень, размазанная на пять. Здесь 32/24/17/16/14/12: шаги 1.33 / 1.41 /
 * 1.06(смена гарнитуры и веса) / 1.14 / 1.17.
 *
 * `h3` и `body` близки по кеглю намеренно: это не две ступени размера, а два
 * голоса — заголовок строки набран полужирным гротеском, текст обычным.
 *
 * `micro` — служебная ступень моноширинным: время, сроки, реквизит,
 * атрибуция источника. Никогда не несёт содержания и никогда не стоит над
 * заголовком.
 */
export const type_ = {
  h1: { size: 32, lineHeight: 36, weight: '700', tracking: -0.4, family: FONTS.displayBold },
  h2: { size: 24, lineHeight: 30, weight: '600', tracking: -0.2, family: FONTS.displaySemi },
  h3: { size: 17, lineHeight: 23, weight: '600', tracking: 0, family: FONTS.sansSemi },
  body: { size: 16, lineHeight: 24, weight: '400', tracking: 0, family: FONTS.sans },
  small: { size: 14, lineHeight: 20, weight: '400', tracking: 0, family: FONTS.sans },
  /**
   * Реквизит: время, сроки, суммы, номера, атрибуция. Только моноширинным
   * и только то, что действительно является реквизитом — иначе моноширинный
   * превращается в костюм «технично», а это прямой запрет craft-floor.
   */
  micro: { size: 12, lineHeight: 16, weight: '500', tracking: 0.2, family: FONTS.mono },
  /** Короткая речь мелким кеглем: подписи, оговорки, пояснения под действием. */
  caption: { size: 13, lineHeight: 18, weight: '400', tracking: 0, family: FONTS.sans },
} as const satisfies Record<string, TypeStep>;

export type TypeName = keyof typeof type_;

/**
 * Стиль текста из ступени. Один вызов вместо пяти свойств в каждом
 * компоненте — иначе интерлиньяж и гарнитура забываются, и интерлиньяж
 * действительно был забыт на 75% узлов.
 */
export function textStyle(step: TypeStep, color: string, over?: Partial<TextStyle>): TextStyle {
  return {
    fontFamily: step.family,
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

export const DURATION = {
  /** «Нажим пера»: быстрый вход, спокойный возврат. */
  press: 90,
  release: 160,
  enter: 220,
  /** Единственный авторский момент во всём продукте — «печать». */
  moment: 260,
  momentFade: 320,
} as const;

/**
 * Насколько нажатие сжимает элемент. 0.985, а не 0.97: в мире бумаги нажатие
 * — это нажим, а не проваливание кнопки.
 */
export const PRESS_SCALE = 0.985;

export interface Theme {
  colors: {
    bg: string;
    surface: string;
    /** Вдавленное: поля ввода, дорожки шкал. */
    surfaceAlt: string;
    /** Горячее: блок, который чего-то хочет от человека. Фон = «твой ход». */
    surfaceHot: string;
    /** Линейка контейнера. Тихая: контейнер не интерактивен. */
    border: string;
    /** Контур интерактивного. Обязан держать 3:1 — это требование, не вкус. */
    control: string;
    borderHot: string;
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

/**
 * Радиусы мелкие и их три: 2 (марки хода, штампы), 6 (чипы, поля, кнопки),
 * 14 (блок агентности). Прежний `lg: 20` на карточке и есть «пузырь
 * приложения», из-за которого экраны неотличимы от любого тудушника.
 */
const radius = { sm: 2, md: 6, lg: 14 };

/**
 * Светлая тема — сцена «день, на ходу, экран под прямым светом».
 * Бумага не белая, чтобы белые поверхности читались как приподнятые.
 *
 * Ступень грунта bg↔surface = 1.22. Она намеренно тихая, и поэтому границу
 * держит линейка, а не тень: в мире без теней граница И ЕСТЬ граница.
 */
export const lightTheme: Theme = {
  colors: {
    bg: '#E3DFD2',
    surface: '#F7F5EF',
    surfaceAlt: '#DAD4C4',
    surfaceHot: '#EFD9CB',
    border: '#B5AE9C',
    /* 4.55:1 на поверхности, 3.72 на бумаге, 3.36 на вдавленном — проходит
       3:1 на всех трёх грунтах, а не только на самом светлом. */
    control: '#786F5D',
    borderHot: '#9A5533',
    text: '#1A1C1B',
    textMuted: '#5C5B52',
    accent: '#A82D14',
    accentText: '#FBF9F4',
    /* Успех ахроматичен: три состояния очерёдности из четырёх без цвета,
       и «сделано» читается оттиском и зачёркиванием, а не зелёным. */
    success: '#1A1C1B',
    warning: '#6E5314',
    danger: '#7A1E0E',
    dangerText: '#FBF9F4',
  },
  spacing,
  radius,
  font: type_,
};

/** Тёмная — сцена «вечер, один». Не чистый чёрный, белый тёплый. */
export const darkTheme: Theme = {
  colors: {
    bg: '#131316',
    surface: '#1F2024',
    surfaceAlt: '#282A2F',
    surfaceHot: '#3A2622',
    border: '#52555E',
    control: '#7A808B',
    borderHot: '#B26A53',
    text: '#EDEAE1',
    textMuted: '#9A968C',
    accent: '#FF6B4A',
    accentText: '#17171A',
    success: '#EDEAE1',
    warning: '#C9A24A',
    danger: '#FF8A6B',
    dangerText: '#17171A',
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
 * Чей сейчас ход — ось всего мира.
 *
 * Три состояния из четырёх ахроматичны. Цвет принадлежит ровно одному —
 * «твой ход», — и потому означает что-то, а не украшает. Это же правило
 * запрещает красить акцентом заголовки, ссылки «подробнее» и пустые
 * состояния: если на экране от человека ничего не ждут, акцента там нет.
 */
export type Turn = 'agent' | 'intent' | 'world' | 'user';

export function turnColor(theme: Theme, turn: Turn): string {
  return turn === 'user' ? theme.colors.accent : theme.colors.textMuted;
}
