import { Pressable, ScrollView, Text, View } from 'react-native';
import type { Archetype, FeedCard } from './api';
import type { lightTheme } from '@agentic-os/ui-registry';

/**
 * Лента «Сегодня» — главный экран, а не чат.
 *
 * Чат как главный экран означает, что вся инициатива на пользователе,
 * а значит удержания не будет: продукт нужно открывать, чтобы он был полезен.
 * Лента полезна до того, как её о чём-то попросили.
 */

type Theme = typeof lightTheme;

const KIND_STYLE: Record<FeedCard['kind'], { glyph: string; tone: 'accent' | 'warning' | 'success' | 'muted' }> = {
  need_decision: { glyph: '🙋', tone: 'accent' },
  deadline: { glyph: '⏳', tone: 'warning' },
  did_for_you: { glyph: '✅', tone: 'success' },
  morning_brief: { glyph: '☀️', tone: 'muted' },
  discovery: { glyph: '💡', tone: 'muted' },
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
}: HomeScreenProps): React.JSX.Element {
  const empty = cards.length === 0;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      contentContainerStyle={{ padding: theme.spacing(4), gap: theme.spacing(4), paddingBottom: theme.spacing(10) }}
    >
      <View style={{ gap: theme.spacing(1) }}>
        <Text style={{ fontSize: theme.font.h1, fontWeight: '700', color: theme.colors.text }}>{greeting}</Text>
        <Text style={{ fontSize: theme.font.body, color: theme.colors.textMuted }}>
          {empty ? 'Что тебя сейчас грузит?' : 'Вот что важно прямо сейчас'}
        </Text>
      </View>

      {cards.map((card, i) => {
        const style = KIND_STYLE[card.kind];
        const color =
          style.tone === 'accent' ? theme.colors.accent
          : style.tone === 'warning' ? theme.colors.warning
          : style.tone === 'success' ? theme.colors.success
          : theme.colors.textMuted;

        return (
          <Pressable
            key={`${card.kind}-${i}`}
            onPress={() => onCard(card)}
            style={({ pressed }) => ({
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderLeftWidth: 3,
              borderLeftColor: color,
              padding: theme.spacing(4),
              gap: theme.spacing(1),
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing(2) }}>
              <Text style={{ fontSize: 16 }}>{style.glyph}</Text>
              <Text style={{ flex: 1, fontSize: theme.font.body, fontWeight: '600', color: theme.colors.text }}>
                {card.title}
              </Text>
            </View>
            <Text style={{ fontSize: theme.font.small, color: theme.colors.textMuted, lineHeight: theme.font.small * 1.4 }}>
              {card.body}
            </Text>
          </Pressable>
        );
      })}

      {empty ? (
        <View style={{ gap: theme.spacing(2) }}>
          {examples.map((example) => (
            <Pressable
              key={example}
              onPress={() => onExample(example)}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.md,
                padding: theme.spacing(3.5),
              }}
            >
              <Text style={{ color: theme.colors.text, fontSize: theme.font.small }}>{example}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/*
        Архетипы: три тапа вместо анкеты. Опровергать легче, чем заполнять,
        поэтому факты кладутся с низкой уверенностью и как предположения.
      */}
      {archetypes.length > 0 ? (
        <View style={{ gap: theme.spacing(2.5) }}>
          <Text style={{ fontSize: theme.font.small, color: theme.colors.textMuted, fontWeight: '600' }}>
            Что из этого про тебя?
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing(2) }}>
            {archetypes.map((a) => {
              const active = chosenArchetypes.includes(a.id);
              return (
                <Pressable
                  key={a.id}
                  onPress={() => onToggleArchetype(a.id)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing(1.5),
                    paddingHorizontal: theme.spacing(3),
                    paddingVertical: theme.spacing(2.5),
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: active ? theme.colors.accent : theme.colors.border,
                    backgroundColor: active ? `${theme.colors.accent}1A` : theme.colors.surface,
                  }}
                >
                  <Text>{a.glyph}</Text>
                  <Text style={{ color: active ? theme.colors.accent : theme.colors.text, fontSize: theme.font.small }}>
                    {a.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <Pressable onPress={onOpenLifeMap}>
        <Text style={{ color: theme.colors.accent, fontSize: theme.font.small }}>Что я о тебе знаю →</Text>
      </Pressable>

      {inboxAddress ? (
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: theme.font.small, color: theme.colors.textMuted, fontWeight: '600' }}>
            Пересылай сюда чеки и подтверждения
          </Text>
          {/* Обход restricted scope: пользователь сам решает, что мы видим. */}
          <Text style={{ fontSize: theme.font.small, color: theme.colors.text }}>{inboxAddress}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
