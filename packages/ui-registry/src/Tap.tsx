import { useCallback, useRef, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, type ViewStyle } from 'react-native';
import { DURATION, PRESS_SCALE, TARGET } from './theme';

/**
 * Единственный способ сделать что-либо нажимаемым в этом реестре.
 *
 * Три вещи, которые раньше забывались на каждом втором компоненте и теперь
 * не могут быть забыты, потому что живут здесь:
 *
 *  1. **Отклик.** Нажатие выражалось только `opacity: 0.7`. Прозрачность —
 *     это «элемент выключается», а не «интерфейс услышал палец». Геометрия
 *     читается телом: сжатие на 3% за 90 мс и спокойный возврат за 160.
 *  2. **Цель.** iOS требует 44×44 pt. Замер показал, что 9 из 13 элементов
 *     главного экрана были меньше; текстовые ссылки — 15 pt высотой.
 *     Здесь минимум либо расширяет саму цель, либо добавляет `hitSlop`,
 *     если элемент обязан остаться визуально мелким.
 *  3. **Голос.** Роль, подпись и состояние для VoiceOver. Без них чек-лист —
 *     главное взаимодействие каждой мини-аппы — объявляется как статический
 *     текст: не «флажок», не «не отмечено», не «дважды коснитесь».
 *
 * Хуки здесь законны, потому что это настоящий React-компонент. Рендереры
 * реестра вызываются как функции, поэтому хуков внутри них быть не может —
 * ещё одна причина, по которой нажатие обязано жить в одном месте.
 */

export interface TapProps {
  onPress: () => void;
  children: ReactNode;
  style?: ViewStyle;
  disabled?: boolean;
  /** Что произносит скринридер. Обязательно, если внутри нет текста. */
  label?: string;
  role?: 'button' | 'checkbox' | 'radio' | 'switch' | 'link' | 'menuitem';
  checked?: boolean;
  selected?: boolean;
  /**
   * Расширять цель невидимой областью вместо самого элемента. Нужно там,
   * где увеличить визуальный размер нельзя: строка списка, чип, ссылка.
   */
  slop?: boolean;
  /** Отключить сжатие: для крупных поверхностей вроде карточки оно дёргает. */
  quiet?: boolean;
}

export function Tap({
  onPress, children, style, disabled = false,
  label, role = 'button', checked, selected, slop = false, quiet = false,
}: TapProps): ReactNode {
  const scale = useRef(new Animated.Value(1)).current;

  const to = useCallback(
    (value: number, duration: number) => {
      if (quiet) return;
      Animated.timing(scale, {
        toValue: value,
        duration,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    },
    [quiet, scale]
  );

  const state: Record<string, boolean> = { disabled };
  if (checked !== undefined) state['checked'] = checked;
  if (selected !== undefined) state['selected'] = selected;

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        disabled={disabled}
        onPress={() => {
          onPress();
          // Скринридер не видит смены цвета: изменение состояния произносится.
          if (label) AccessibilityInfo.announceForAccessibility?.(label);
        }}
        onPressIn={() => to(PRESS_SCALE, DURATION.press)}
        onPressOut={() => to(1, DURATION.release)}
        accessible
        accessibilityRole={role}
        {...(label ? { accessibilityLabel: label } : {})}
        accessibilityState={state}
        hitSlop={slop ? { top: 8, bottom: 8, left: 8, right: 8 } : undefined}
        style={[{ minHeight: slop ? undefined : TARGET, justifyContent: 'center' }, style]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}
