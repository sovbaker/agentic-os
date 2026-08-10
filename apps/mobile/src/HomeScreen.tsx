import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { IconName } from '@agentic-os/contracts';
import { Icon, Tap, textStyle, type lightTheme } from '@agentic-os/ui-registry';
import type { Archetype, FeedCard } from './api';

/**
 * Лента «Сегодня» — главный экран, а не чат.
 *
 * Чат как главный экран означает, что вся инициатива на пользователе,
 * а значит удержания не будет: продукт нужно открывать, чтобы он был полезен.
 * Лента полезна до того, как её о чём-то попросили.
 *
 * Второе правило этого экрана: первый запуск показывает ОДНО решение.
 * Раньше здесь было девять вариантов с одинаковым оформлением — примеры фраз
 * и чипы архетипов выглядели одинаковыми белыми прямоугольниками, и за пять
 * секунд было непонятно, что делать первым. Всё, что не «скажи, что нужно»,
 * появляется после первой закрытой задачи, когда у человека есть причина
 * помочь нам его понять.
 */

type Theme = typeof lightTheme;

const KIND: Record<FeedCard['kind'], { icon: IconName; tone: 'accent' | 'warning' | 'success' | 'muted' }> = {
  need_decision: { icon: 'diamond', tone: 'accent' },
  deadline: { icon: 'clock', tone: 'warning' },
  did_for_you: { icon: 'check', tone: 'success' },
  morning_brief: { icon: 'calendar', tone: 'muted' },
  discovery: { icon: 'star', tone: 'muted' },
};

export interface HomeScreenProps {
  theme: Theme;
  greeting: string;
  cards: FeedCard[];
  examples: readonly string[];
  archetypes: Archetype[];
  chosenArchetypes: string[];
  inboxAddress: string | null;
  onExample: (text: string) => void;
  onCard: (card: FeedCard) => void;
  onToggleArchetype: (id: string) => void;
  onOpenLifeMap: () => void;
  onOpenPrivacy: () => void;
}

export function HomeScreen({
  theme,
  greeting,
  cards,
  examples,
  archetypes,
  chosenArchetypes,
  inboxAddress,
  onExample,
  onCard,
  onToggleArchetype,
  onOpenLifeMap,
  onOpenPrivacy,
}: HomeScreenProps): React.JSX.Element {
  const empty = cards.length === 0;
  const [moreOpen, setMoreOpen] = useState(false);

  // Спрашивать «что из этого про тебя?» на девяностый день — значит показать,
  // что ответ никуда не делся. Чипы уходят, как только на них ответили.
  const askArchetypes = !empty && archetypes.length > 0 && chosenArchetypes.length === 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4), paddingBottom: theme.spacing(8) }}
    >
      <View style={{ gap: theme.spacing(1) }}>
        <Text accessibilityRole="header" style={textStyle(theme.font.h1, theme.colors.text)}>
          {greeting}
        </Text>
        <Text style={textStyle(theme.font.body, theme.colors.textMuted)}>
          {empty ? 'Что тебя сейчас грузит?' : 'Вот что важно прямо сейчас'}
        </Text>
      </View>

      {cards.map((card, i) => {
        const style = KIND[card.kind];
        const color =
          style.tone === 'accent' ? theme.colors.accent
          : style.tone === 'warning' ? theme.colors.warning
          : style.tone === 'success' ? theme.colors.success
          : theme.colors.textMuted;

        const surface = {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: theme.colors.border,
          padding: theme.spacing(4),
          gap: theme.spacing(1.5),
        } as const;

        const inner = (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing(2.5) }}>
              {/*
                Знак вместо цветной кромки слева: полоса толще 1px на карточке —
                приём, который ничего не сообщает, а эмодзи был самым громким
                и самым бессодержательным пикселем экрана.
              */}
              <View style={{ paddingTop: 2 }}>
                <Icon name={style.icon} size={18} color={color} />
              </View>
              <View style={{ flex: 1, gap: theme.spacing(1) }}>
                <Text style={textStyle(theme.font.h3, theme.colors.text)}>{card.title}</Text>
                <Text style={textStyle(theme.font.small, theme.colors.textMuted)}>{card.body}</Text>
              </View>
              {card.specId ? <Icon name="chevronRight" size={16} color={theme.colors.textMuted} /> : null}
          </View>
        );

        /*
         * Карточка без назначения не нажимается. Раньше нажималось всё, а
         * обработчик копировал текст карточки в серый баннер — отклик обещал
         * дверь, которой нет, и это худший вид неработающего интерфейса.
         */
        return card.specId ? (
          <Tap key={`${card.kind}-${i}`} onPress={() => onCard(card)} label={card.title} quiet style={surface}>
            {inner}
          </Tap>
        ) : (
          <View key={`${card.kind}-${i}`} style={surface}>
            {inner}
          </View>
        );
      })}

      {empty ? (
        <View style={{ gap: theme.spacing(2) }}>
          {examples.map((example) => (
            <Tap
              key={example}
              onPress={() => onExample(example)}
              label={example}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.control,
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.md,
                paddingHorizontal: theme.spacing(3.5),
                paddingVertical: theme.spacing(3),
              }}
            >
              <Text style={textStyle(theme.font.small, theme.colors.text)}>{example}</Text>
            </Tap>
          ))}
        </View>
      ) : null}

      {/*
        Архетипы: три тапа вместо анкеты. Опровергать легче, чем заполнять,
        поэтому факты кладутся с низкой уверенностью и как предположения.
      */}
      {askArchetypes ? (
        <View style={{ gap: theme.spacing(2.5) }}>
          <Text style={textStyle(theme.font.small, theme.colors.textMuted, { fontWeight: '600' })}>
            Что из этого про тебя?
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(2) }}>
            {archetypes.map((a) => {
              const active = chosenArchetypes.includes(a.id);
              return (
                <Tap
                  key={a.id}
                  onPress={() => onToggleArchetype(a.id)}
                  label={a.label}
                  role="checkbox"
                  checked={active}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing(2),
                    paddingHorizontal: theme.spacing(3),
                    paddingVertical: theme.spacing(2),
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: active ? theme.colors.accent : theme.colors.control,
                    backgroundColor: active ? `${theme.colors.accent}1A` : theme.colors.surface,
                  }}
                >
                  <Icon name={active ? 'check' : (a.icon as IconName)} size={16} color={active ? theme.colors.accent : theme.colors.textMuted} />
                  <Text style={textStyle(theme.font.small, active ? theme.colors.accent : theme.colors.text)}>
                    {a.label}
                  </Text>
                </Tap>
              );
            })}
          </View>
        </View>
      ) : null}

      {/*
        Всё служебное — за одним раскрытием. Адрес для пересылки и экраны про
        данные нужны на второй неделе, а не на нулевой секунде.
      */}
      <View style={{ gap: theme.spacing(2) }}>
        <Tap onPress={() => setMoreOpen((v) => !v)} label="Ещё" selected={moreOpen} style={{ alignSelf: 'flex-start' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.5) }}>
            <Text style={textStyle(theme.font.small, theme.colors.textMuted, { fontWeight: '600' })}>Ещё</Text>
            <Icon name={moreOpen ? 'chevronDown' : 'chevronRight'} size={14} color={theme.colors.textMuted} />
          </View>
        </Tap>

        {moreOpen ? (
          <View style={{ gap: theme.spacing(1) }}>
            <Tap onPress={onOpenLifeMap} label="Что я о тебе знаю" style={{ alignSelf: 'flex-start' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(2) }}>
                <Text style={textStyle(theme.font.body, theme.colors.text, { textDecorationLine: 'underline' })}>
                  Что я о тебе знаю
                </Text>
                <Icon name="chevronRight" size={16} color={theme.colors.textMuted} />
              </View>
            </Tap>

            <Tap onPress={onOpenPrivacy} label="Данные и приватность" style={{ alignSelf: 'flex-start' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(2) }}>
                <Text style={textStyle(theme.font.body, theme.colors.text, { textDecorationLine: 'underline' })}>
                  Данные и приватность
                </Text>
                <Icon name="chevronRight" size={16} color={theme.colors.textMuted} />
              </View>
            </Tap>

            {inboxAddress ? (
              <View style={{ gap: 4, paddingTop: theme.spacing(2) }}>
                <Text style={textStyle(theme.font.small, theme.colors.textMuted, { fontWeight: '600' })}>
                  Пересылай сюда чеки и подтверждения
                </Text>
                {/* Обход restricted scope: пользователь сам решает, что мы видим. */}
                {/* Адрес — реквизит, поэтому машинописью. Объяснение — речь. */}
                <Text selectable style={textStyle(theme.font.micro, theme.colors.text)}>
                  {inboxAddress}
                </Text>
                <Text style={textStyle(theme.font.caption, theme.colors.textMuted)}>
                  Из письма я возьму только факты — срок, сумму, номер. Само письмо останется отдельно.
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
