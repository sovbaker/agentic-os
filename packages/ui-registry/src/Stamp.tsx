import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, View } from 'react-native';
import { Icon } from './Icon';
import { DURATION, type Theme } from './theme';

/**
 * Марка хода — и единственный авторский момент движения во всём продукте.
 *
 * Когда ход закрывается (агент доделал или человек подтвердил), кольцо
 * становится диском: внутри контура из нуля вырастает заливка, чуть
 * переступая целевой размер и возвращаясь. Это «печать» — оттиск, который
 * ставят на исполненном.
 *
 * Момент один, потому что момент, который случается на каждом элементе,
 * перестаёт быть моментом. Ничего больше не влетает, списки не стаггерятся,
 * входных анимаций нет.
 *
 * Анимируются только transform и opacity, `useNativeDriver: true` — цвет
 * нативным драйвером не анимируется в принципе, и подменять его прозрачностью
 * оверлея здесь не нужно: заливка и есть содержание момента.
 */

interface StampProps {
  theme: Theme;
  /** Ход закрыт: кольцо превращается в диск. */
  done: boolean;
  size?: number;
  color: string;
  /** Цвет знака внутри диска. */
  inkColor: string;
  children?: ReactNode;
}

export function Stamp({ theme, done, size = 24, color, inkColor }: StampProps): ReactNode {
  const fill = useRef(new Animated.Value(done ? 1 : 0)).current;
  const wasDone = useRef(done);

  useEffect(() => {
    if (wasDone.current === done) return;
    wasDone.current = done;

    if (!done) {
      // Снятие отметки — не событие: возвращаемся молча и быстро.
      Animated.timing(fill, { toValue: 0, duration: DURATION.press, useNativeDriver: true }).start();
      return;
    }

    fill.setValue(0);
    Animated.sequence([
      Animated.timing(fill, {
        toValue: 1.06,
        duration: DURATION.moment * 0.7,
        easing: Easing.bezier(0.2, 0.7, 0.2, 1),
        useNativeDriver: true,
      }),
      Animated.timing(fill, {
        toValue: 1,
        duration: DURATION.moment * 0.3,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();
  }, [done, fill]);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.5,
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <Animated.View
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          transform: [{ scale: fill }],
        }}
      />
      {done ? (
        <Animated.View style={{ opacity: fill }}>
          <Icon name="check" size={size * 0.62} color={inkColor} />
        </Animated.View>
      ) : null}
    </View>
  );
}
