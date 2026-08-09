import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { Job, UIAction, UISpec } from '@agentic-os/contracts';
import { KITCHEN_SINK, Renderer, darkTheme, lightTheme } from '@agentic-os/ui-registry';
import { dispatchAction, registerDevice, setToken, streamTurn } from './src/api';
import { loadToken, saveToken } from './src/storage';
import { speech } from './src/speech/index';

/**
 * S0: сквозной контур «сказал → получил экран».
 *
 * Клиент намеренно тонкий: он рендерит серверный UISpec и отправляет намерения.
 * Что делает кнопка, знает сервер — поэтому поведение меняется без релиза,
 * а подменённый клиент не может выполнить ничего лишнего.
 */

interface PendingConfirm {
  action: Extract<UIAction, { kind: 'tool' }>;
  text: string;
}

const EXAMPLES = [
  'Надо оформить визу в Италию к октябрю, и я вечно про это забываю',
  'Хочу спланировать поездку в Грузию весной',
  'Нужно найти мастера по натяжным потолкам на кухню',
];

export default function App(): React.JSX.Element {
  const scheme = useColorScheme();
  const theme = scheme === 'dark' ? darkTheme : lightTheme;

  const [ready, setReady] = useState(false);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spec, setSpec] = useState<UISpec | null>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<Record<string, unknown>>({});
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  const session = useRef<{ stop: () => void } | null>(null);

  /**
   * Режим просмотра реестра: ?dev=registry в вебе. Нужен, чтобы снимать
   * скриншоты всех компонентов сразу — иначе часть из них никогда не
   * попадает на глаза до продакшена.
   */
  const devRegistry =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    window.location?.search?.includes('dev=registry');

  useEffect(() => {
    void (async () => {
      try {
        const existing = await loadToken();
        if (existing) {
          setToken(existing);
        } else {
          const { token } = await registerDevice({
            platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
            deviceName: Platform.OS,
          });
          setToken(token);
          await saveToken(token);
        }
        setReady(true);
      } catch (err) {
        setError(`Не удалось подключиться к серверу: ${(err as Error).message}`);
      }
    })();
  }, []);

  const submit = useCallback(async (text: string, source: 'text' | 'voice') => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    setInput('');
    setSpec(null);
    setData({});
    setState({});

    try {
      const { promise } = streamTurn(trimmed, source, (event) => {
        switch (event.type) {
          case 'status':
            setStatus(event.text);
            break;
          case 'job':
            setJob(event.job);
            break;
          case 'spec':
            setSpec(event.spec);
            break;
          case 'data':
            setData((prev) => ({ ...prev, [event.key]: event.value }));
            break;
          case 'message':
            setStatus(event.text);
            break;
          case 'error':
            setError(event.text);
            break;
          case 'done':
            setStatus(null);
            break;
        }
      });
      await promise;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [busy]);

  const runTool = useCallback(
    async (action: Extract<UIAction, { kind: 'tool' }>, confirmed: boolean) => {
      try {
        const res = await dispatchAction(action, {
          specId: spec?.id,
          jobId: job?.id,
          confirmed,
        });

        if (res.needsConfirmation) {
          setConfirm({ action, text: res.confirmationText ?? 'Подтвердить действие?' });
          return;
        }
        if (res.dataPatch) setData((prev) => ({ ...prev, ...res.dataPatch }));
        if (res.message) setStatus(res.message);
        if (!res.ok && !res.message) setError('Действие не выполнено');
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [spec?.id, job?.id]
  );

  const onAction = useCallback(
    (action: UIAction, payload?: unknown) => {
      switch (action.kind) {
        case 'tool':
          void runTool(action, false);
          break;
        case 'submit':
          void runTool({ kind: 'tool', tool: action.tool, args: {}, optimistic: false }, false);
          break;
        case 'setState':
          setState((prev) => ({ ...prev, [action.path]: payload ?? action.value }));
          break;
        case 'navigate':
          // Навигация появится вместе с лентой «Сегодня» в S3.
          setStatus(`Переход: ${action.target}`);
          break;
        case 'handoff':
          void Linking.openURL(action.url).catch(() => {
            if (action.fallbackUrl) void Linking.openURL(action.fallbackUrl);
          });
          break;
      }
    },
    [runTool]
  );

  const toggleVoice = useCallback(async () => {
    if (listening) {
      session.current?.stop();
      session.current = null;
      setListening(false);
      return;
    }
    if (!speech.isAvailable()) {
      setError('Голосовой ввод недоступен — набери текстом');
      return;
    }

    setError(null);
    setListening(true);
    session.current = await speech.start(
      (partial) => setInput(partial),
      (final) => {
        setListening(false);
        session.current = null;
        void submit(final, 'voice');
      },
      (message) => {
        setListening(false);
        session.current = null;
        setError(message);
      }
    );
  }, [listening, submit]);

  const styles = useMemo(() => makeStyles(theme), [theme]);

  if (!ready && !error) {
    return (
      <View style={[styles.center, { backgroundColor: theme.colors.bg }]}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={{ flex: 1 }}>
          {devRegistry ? (
            <Renderer spec={KITCHEN_SINK} data={{}} state={{}} theme={theme} onAction={onAction} />
          ) : spec ? (
            <Renderer spec={spec} data={data} state={state} theme={theme} onAction={onAction} />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Что тебя сейчас грузит?</Text>
              <Text style={styles.emptyHint}>
                Скажи или напиши — соберу под это экран и возьму дело на себя.
              </Text>
              <View style={{ gap: 8, marginTop: 8 }}>
                {EXAMPLES.map((example) => (
                  <Pressable
                    key={example}
                    onPress={() => void submit(example, 'text')}
                    style={styles.example}
                  >
                    <Text style={styles.exampleText}>{example}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>

        {status || error ? (
          <View style={[styles.banner, error ? styles.bannerError : null]}>
            {busy && !error ? <ActivityIndicator size="small" color={theme.colors.textMuted} /> : null}
            <Text style={[styles.bannerText, error ? { color: theme.colors.danger } : null]}>
              {error ?? status}
            </Text>
          </View>
        ) : null}

        {confirm ? (
          <View style={styles.confirm}>
            <Text style={styles.confirmText}>{confirm.text}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                style={[styles.confirmBtn, styles.confirmPrimary]}
                onPress={() => {
                  const pending = confirm;
                  setConfirm(null);
                  void runTool(pending.action, true);
                }}
              >
                <Text style={{ color: theme.colors.accentText, fontWeight: '600' }}>Подтверждаю</Text>
              </Pressable>
              <Pressable style={styles.confirmBtn} onPress={() => setConfirm(null)}>
                <Text style={{ color: theme.colors.text }}>Отмена</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.composer}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={listening ? 'Слушаю…' : 'Напиши задачу'}
            placeholderTextColor={theme.colors.textMuted}
            style={styles.input}
            editable={!busy}
            onSubmitEditing={() => void submit(input, 'text')}
            returnKeyType="send"
          />
          <Pressable
            onPress={() => void toggleVoice()}
            style={[styles.iconBtn, listening ? styles.iconBtnActive : null]}
            accessibilityLabel="Голосовой ввод"
          >
            <Text style={{ fontSize: 18 }}>{listening ? '⏹' : '🎙'}</Text>
          </Pressable>
          <Pressable
            onPress={() => void submit(input, 'text')}
            disabled={busy || input.trim() === ''}
            style={[styles.sendBtn, busy || input.trim() === '' ? { opacity: 0.4 } : null]}
          >
            <Text style={{ color: theme.colors.accentText, fontWeight: '700' }}>→</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(theme: typeof lightTheme) {
  return {
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' } as const,
    empty: {
      flex: 1,
      justifyContent: 'center',
      padding: theme.spacing(6),
      gap: theme.spacing(3),
    } as const,
    emptyTitle: {
      fontSize: theme.font.h1,
      fontWeight: '700',
      color: theme.colors.text,
    } as const,
    emptyHint: {
      fontSize: theme.font.body,
      color: theme.colors.textMuted,
      lineHeight: theme.font.body * 1.45,
    } as const,
    example: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.md,
      padding: theme.spacing(3.5),
    } as const,
    exampleText: { color: theme.colors.text, fontSize: theme.font.small } as const,
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing(2),
      paddingHorizontal: theme.spacing(5),
      paddingVertical: theme.spacing(2.5),
    } as const,
    bannerError: { backgroundColor: `${theme.colors.danger}12` } as const,
    bannerText: { color: theme.colors.textMuted, fontSize: theme.font.small, flex: 1 } as const,
    confirm: {
      margin: theme.spacing(4),
      padding: theme.spacing(4),
      borderRadius: theme.radius.lg,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.border,
      gap: theme.spacing(3),
    } as const,
    confirmText: { color: theme.colors.text, fontSize: theme.font.body } as const,
    confirmBtn: {
      paddingVertical: theme.spacing(2.5),
      paddingHorizontal: theme.spacing(4),
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    } as const,
    confirmPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent } as const,
    composer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing(2),
      padding: theme.spacing(3),
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
    } as const,
    input: {
      flex: 1,
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing(3.5),
      paddingVertical: theme.spacing(3),
      color: theme.colors.text,
      fontSize: theme.font.body,
    } as const,
    iconBtn: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.colors.border,
    } as const,
    iconBtnActive: { backgroundColor: `${theme.colors.danger}22`, borderColor: theme.colors.danger } as const,
    sendBtn: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.accent,
    } as const,
  };
}
