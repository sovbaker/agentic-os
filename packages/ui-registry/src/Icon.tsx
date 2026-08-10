import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';
import type { IconName } from '@agentic-os/contracts';

/**
 * Иконки.
 *
 * Раньше их роль исполняли эмодзи: сервер присылал глиф, клиент печатал его
 * текстом. Это чужой рисунок, чужая метрика и цвет, которым нельзя управлять;
 * на светлом фоне полноцветные эмодзи оказывались самыми громкими пикселями
 * экрана и несли меньше всего смысла.
 *
 * Здесь набор закрыт так же, как реестр компонентов: сервер присылает имя,
 * форма живёт в бинаре. Подсунуть произвольный символ физически нельзя.
 *
 * Формы собраны из View — прямоугольников, кругов и поворотов. Это ограничивает
 * словарь простыми знаками, и это осознанная цена: набор без нативной
 * зависимости сегодня лучше, чем красивый набор после пересборки dev-client.
 * Штрих один на всю систему и масштабируется от размера.
 */

interface IconProps {
  name: IconName;
  size?: number;
  color: string;
  /** Заливка вместо контура — для отмеченных и завершённых состояний. */
  filled?: boolean;
}

const bar = (color: string, w: number, h: number, style?: ViewStyle): ViewStyle => ({
  position: 'absolute',
  width: w,
  height: h,
  borderRadius: Math.min(w, h) / 2,
  backgroundColor: color,
  ...style,
});

export function Icon({ name, size = 20, color, filled = false }: IconProps): ReactNode {
  const s = size;
  const stroke = Math.max(1.5, Math.round(s / 11));
  const box: ViewStyle = { width: s, height: s, alignItems: 'center', justifyContent: 'center' };

  switch (name) {
    case 'check':
      return (
        <View style={box}>
          <View style={bar(color, s * 0.34, stroke, { transform: [{ translateX: -s * 0.16 }, { translateY: s * 0.1 }, { rotate: '45deg' }] })} />
          <View style={bar(color, s * 0.58, stroke, { transform: [{ translateX: s * 0.08 }, { translateY: -s * 0.02 }, { rotate: '-45deg' }] })} />
        </View>
      );

    case 'close':
      return (
        <View style={box}>
          <View style={bar(color, s * 0.72, stroke, { transform: [{ rotate: '45deg' }] })} />
          <View style={bar(color, s * 0.72, stroke, { transform: [{ rotate: '-45deg' }] })} />
        </View>
      );

    case 'plus':
      return (
        <View style={box}>
          <View style={bar(color, s * 0.62, stroke)} />
          <View style={bar(color, stroke, s * 0.62)} />
        </View>
      );

    case 'minus':
      return <View style={box}><View style={bar(color, s * 0.62, stroke)} /></View>;

    case 'chevronLeft':
    case 'chevronRight':
    case 'chevronDown': {
      // Одна форма на три направления: галочка из двух штрихов, повёрнутая целиком.
      const rotate = name === 'chevronLeft' ? '0deg' : name === 'chevronRight' ? '180deg' : '-90deg';
      return (
        <View style={box}>
          <View style={{ transform: [{ rotate }], width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
            <View style={bar(color, s * 0.4, stroke, { transform: [{ translateY: -s * 0.14 }, { rotate: '-45deg' }] })} />
            <View style={bar(color, s * 0.4, stroke, { transform: [{ translateY: s * 0.14 }, { rotate: '45deg' }] })} />
          </View>
        </View>
      );
    }

    case 'arrowRight':
      return (
        <View style={box}>
          <View style={bar(color, s * 0.62, stroke)} />
          <View style={bar(color, s * 0.3, stroke, { transform: [{ translateX: s * 0.19 }, { translateY: -s * 0.1 }, { rotate: '45deg' }] })} />
          <View style={bar(color, s * 0.3, stroke, { transform: [{ translateX: s * 0.19 }, { translateY: s * 0.1 }, { rotate: '-45deg' }] })} />
        </View>
      );

    case 'dot':
      return <View style={box}><View style={{ width: s * 0.44, height: s * 0.44, borderRadius: s * 0.22, backgroundColor: color }} /></View>;

    case 'ring':
      return (
        <View style={box}>
          <View
            style={{
              width: s * 0.72, height: s * 0.72, borderRadius: s * 0.36,
              borderWidth: stroke, borderColor: color,
              backgroundColor: filled ? color : 'transparent',
            }}
          />
        </View>
      );

    case 'ringDashed':
      // Ожидание мира: кольцо с разрывом сверху. Пунктир в RN рисуется
      // ненадёжно, а разрыв читается как «ещё не замкнулось».
      return (
        <View style={box}>
          <View
            style={{
              width: s * 0.72, height: s * 0.72, borderRadius: s * 0.36,
              borderWidth: stroke, borderColor: color, borderTopColor: 'transparent',
              transform: [{ rotate: '45deg' }],
            }}
          />
        </View>
      );

    case 'diamond':
      return (
        <View style={box}>
          <View
            style={{
              width: s * 0.5, height: s * 0.5,
              borderWidth: filled ? 0 : stroke, borderColor: color,
              backgroundColor: filled ? color : 'transparent',
              transform: [{ rotate: '45deg' }],
            }}
          />
        </View>
      );

    case 'square':
      return (
        <View style={box}>
          <View
            style={{
              width: s * 0.62, height: s * 0.62, borderRadius: stroke,
              borderWidth: filled ? 0 : stroke, borderColor: color,
              backgroundColor: filled ? color : 'transparent',
            }}
          />
        </View>
      );

    case 'star':
      // Восьмиконечная искра из двух квадратов: звезду пятиугольной формы
      // прямоугольниками честно не собрать, а искра читается однозначно.
      return (
        <View style={box}>
          <View style={{ position: 'absolute', width: s * 0.26, height: s * 0.72, borderRadius: s * 0.1, backgroundColor: color }} />
          <View style={{ position: 'absolute', width: s * 0.72, height: s * 0.26, borderRadius: s * 0.1, backgroundColor: color }} />
          <View style={{ position: 'absolute', width: s * 0.2, height: s * 0.6, borderRadius: s * 0.08, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
          <View style={{ position: 'absolute', width: s * 0.6, height: s * 0.2, borderRadius: s * 0.08, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
        </View>
      );

    case 'clock':
      return (
        <View style={box}>
          <View style={{ width: s * 0.8, height: s * 0.8, borderRadius: s * 0.4, borderWidth: stroke, borderColor: color }} />
          <View style={bar(color, stroke, s * 0.24, { transform: [{ translateY: -s * 0.12 }] })} />
          <View style={bar(color, s * 0.2, stroke, { transform: [{ translateX: s * 0.1 }] })} />
        </View>
      );

    case 'calendar':
      return (
        <View style={box}>
          <View style={{ width: s * 0.78, height: s * 0.7, borderRadius: stroke * 1.5, borderWidth: stroke, borderColor: color, marginTop: s * 0.06 }} />
          <View style={bar(color, s * 0.78, stroke * 1.4, { top: s * 0.28 })} />
          <View style={bar(color, stroke, s * 0.16, { top: s * 0.02, left: s * 0.28 })} />
          <View style={bar(color, stroke, s * 0.16, { top: s * 0.02, right: s * 0.28 })} />
        </View>
      );

    case 'bell':
      return (
        <View style={box}>
          <View style={{ width: s * 0.56, height: s * 0.56, borderTopLeftRadius: s * 0.28, borderTopRightRadius: s * 0.28, borderWidth: stroke, borderBottomWidth: 0, borderColor: color, marginBottom: s * 0.14 }} />
          <View style={bar(color, s * 0.74, stroke, { bottom: s * 0.24 })} />
          <View style={bar(color, s * 0.18, stroke, { bottom: s * 0.12 })} />
        </View>
      );

    case 'flag':
      return (
        <View style={box}>
          <View style={bar(color, stroke, s * 0.78, { left: s * 0.22 })} />
          <View style={{ position: 'absolute', left: s * 0.3, top: s * 0.12, width: s * 0.44, height: s * 0.3, borderWidth: stroke, borderColor: color, backgroundColor: filled ? color : 'transparent' }} />
        </View>
      );

    case 'doc':
      return (
        <View style={box}>
          <View style={{ width: s * 0.62, height: s * 0.8, borderRadius: stroke, borderWidth: stroke, borderColor: color }} />
          <View style={bar(color, s * 0.3, stroke, { top: s * 0.3 })} />
          <View style={bar(color, s * 0.3, stroke, { top: s * 0.46 })} />
        </View>
      );

    case 'home':
      return (
        <View style={box}>
          <View style={{ width: s * 0.5, height: s * 0.5, borderWidth: stroke, borderColor: color, transform: [{ rotate: '45deg' }], marginBottom: s * 0.22 }} />
          <View style={{ position: 'absolute', bottom: s * 0.1, width: s * 0.56, height: s * 0.36, borderWidth: stroke, borderTopWidth: 0, borderColor: color, backgroundColor: 'transparent' }} />
        </View>
      );

    case 'car':
      return (
        <View style={box}>
          <View style={{ width: s * 0.82, height: s * 0.34, borderRadius: s * 0.1, borderWidth: stroke, borderColor: color, marginBottom: s * 0.1 }} />
          <View style={{ position: 'absolute', top: s * 0.16, width: s * 0.5, height: s * 0.22, borderTopLeftRadius: s * 0.1, borderTopRightRadius: s * 0.1, borderWidth: stroke, borderBottomWidth: 0, borderColor: color }} />
          <View style={{ position: 'absolute', bottom: s * 0.12, left: s * 0.16, width: s * 0.18, height: s * 0.18, borderRadius: s * 0.09, backgroundColor: color }} />
          <View style={{ position: 'absolute', bottom: s * 0.12, right: s * 0.16, width: s * 0.18, height: s * 0.18, borderRadius: s * 0.09, backgroundColor: color }} />
        </View>
      );

    case 'plane':
      return (
        <View style={box}>
          <View style={{ transform: [{ rotate: '-45deg' }], width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
            <View style={bar(color, stroke * 1.2, s * 0.8)} />
            <View style={bar(color, s * 0.62, stroke * 1.2, { transform: [{ translateY: -s * 0.06 }] })} />
            <View style={bar(color, s * 0.26, stroke * 1.2, { transform: [{ translateY: s * 0.26 }] })} />
          </View>
        </View>
      );

    case 'pill':
      return (
        <View style={box}>
          <View style={{ width: s * 0.34, height: s * 0.78, borderRadius: s * 0.17, borderWidth: stroke, borderColor: color, transform: [{ rotate: '45deg' }] }} />
          <View style={bar(color, s * 0.34, stroke, { transform: [{ rotate: '45deg' }] })} />
        </View>
      );

    case 'bag':
      return (
        <View style={box}>
          <View style={{ width: s * 0.74, height: s * 0.5, borderRadius: stroke, borderWidth: stroke, borderColor: color, marginTop: s * 0.2 }} />
          <View style={{ position: 'absolute', top: s * 0.1, width: s * 0.32, height: s * 0.2, borderTopLeftRadius: s * 0.06, borderTopRightRadius: s * 0.06, borderWidth: stroke, borderBottomWidth: 0, borderColor: color }} />
        </View>
      );

    case 'search':
      return (
        <View style={box}>
          <View style={{ width: s * 0.56, height: s * 0.56, borderRadius: s * 0.28, borderWidth: stroke, borderColor: color, marginBottom: s * 0.16, marginRight: s * 0.16 }} />
          <View style={bar(color, s * 0.28, stroke, { bottom: s * 0.14, right: s * 0.1, transform: [{ rotate: '45deg' }] })} />
        </View>
      );

    case 'mic':
      return (
        <View style={box}>
          <View style={{ width: s * 0.3, height: s * 0.46, borderRadius: s * 0.15, backgroundColor: color, marginBottom: s * 0.2 }} />
          <View style={{ position: 'absolute', bottom: s * 0.16, width: s * 0.54, height: s * 0.26, borderBottomLeftRadius: s * 0.27, borderBottomRightRadius: s * 0.27, borderWidth: stroke, borderTopWidth: 0, borderColor: color }} />
          <View style={bar(color, stroke, s * 0.12, { bottom: s * 0.04 })} />
        </View>
      );
  }
}
