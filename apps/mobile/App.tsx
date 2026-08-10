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
import { useFonts } from 'expo-font';
/*
 * Импорт по точному пути, а не из корня пакета: корневой индекс тянет все
 * начертания семейства, и в сборку уезжали 50 файлов вместо пяти.
 */
import Bitter_700Bold from '@expo-google-fonts/bitter/700Bold/Bitter_700Bold.ttf';
import Bitter_600SemiBold from '@expo-google-fonts/bitter/600SemiBold/Bitter_600SemiBold.ttf';
import IBMPlexSans_400Regular from '@expo-google-fonts/ibm-plex-sans/400Regular/IBMPlexSans_400Regular.ttf';
import IBMPlexSans_600SemiBold from '@expo-google-fonts/ibm-plex-sans/600SemiBold/IBMPlexSans_600SemiBold.ttf';
import IBMPlexMono_500Medium from '@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf';
import type { Job, UIAction, UISpec } from '@agentic-os/contracts';
import { Icon, KITCHEN_SINK, REGISTRY, Renderer, TARGET, Tap, darkTheme, lightTheme, textStyle } from '@agentic-os/ui-registry';
import {
  applyArchetypes,
  dispatchAction,
  fetchFeed,
  fetchLifeMap,
  fetchOnboarding,
  fetchMiniApp,
  fetchPrivacy,
  registerDevice,
  registerPushToken,
  setToken,
  streamTurn,
  type Archetype,
  type FeedCard,
} from './src/api';
import { HomeScreen } from './src/HomeScreen';
import { pushTokens } from './src/push/index';
import { loadScreen, saveScreen } from './src/session';
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
  /** Необратимое отличается не только словами: у него другая геометрия. */
  danger: boolean;
}

const EXAMPLES = [
  'Надо оформить визу в Италию к октябрю, и я вечно про это забываю',
  'Хочу спланировать поездку в Грузию весной',
  'Нужно найти мастера по натяжным потолкам на кухню',
];


/**
 * Лист подтверждения оболочки.
 *
 * Раньше в продукте было два разных листа — этот и реестровый — с разной
 * геометрией и одинаковым оранжевым «Подтверждаю» и на напоминание, и на
 * необратимое удаление. Здесь рисует реестр: одно понятие — одна форма.
 */
function ConfirmSheet({
  theme, text, danger, onConfirm, onCancel,
}: {
  theme: typeof lightTheme;
  text: string;
  danger: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const node = REGISTRY.confirmSheet({
    props: danger
      ? { text, tone: 'danger', confirmLabel: 'Да, удалить', cancelLabel: 'Оставить' }
      : { text },
    theme,
    children: null,
    fire: (name) => (name === 'onConfirm' ? onConfirm() : onCancel()),
    hasAction: () => true,
  });
  return <>{node}</>;
}

export default function App(): React.JSX.Element {
  const scheme = useColorScheme();
  const theme = scheme === 'dark' ? darkTheme : lightTheme;

  /**
   * Гарнитуры мира «Оттиск»: Bitter — голос печатного журнала, IBM Plex Sans —
   * речь помощника, IBM Plex Mono — реквизит. Все три с кириллицей и OFL.
   *
   * Контракт холодного старта: до загрузки показываем пустую бумагу нужного
   * цвета, а не текст системным гротеском. Системный гротеск как дисплейный
   * голос — не запасной вариант, а провал: он мгновенно возвращает продукт
   * к состоянию «любое приложение».
   */
  const [fontsReady] = useFonts({
    Bitter_700Bold,
    Bitter_600SemiBold,
    IBMPlexSans_400Regular,
    IBMPlexSans_600SemiBold,
    IBMPlexMono_500Medium,
  });

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
  const [greeting, setGreeting] = useState('Привет');
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [archetypes, setArchetypes] = useState<Archetype[]>([]);
  const [chosenArchetypes, setChosenArchetypes] = useState<string[]>([]);
  const [inboxAddress, setInboxAddress] = useState<string | null>(null);

  /**
   * Стек экранов.
   *
   * Раньше `setSpec(null)` существовал ровно в одном месте — внутри `submit()`, —
   * поэтому каждый серверный экран был дверью в одну сторону: уйти можно было
   * только набрав новую задачу, что уничтожало мини-аппу, в которой человек
   * работал, и восстановить её было нечем. Возврат — не украшение, а условие
   * того, что задачу вообще можно закрыть.
   */
  const [history, setHistory] = useState<Array<{ spec: UISpec; data: Record<string, unknown>; jobId: string | null }>>([]);

  /**
   * Задача, к которой относится открытый экран.
   *
   * Мини-аппа, открытая из ленты, живёт своей жизнью — но её действия
   * («ответить на вопрос», «подтвердить намерение») адресованы конкретной
   * задаче. Без этого `task.answer` из переоткрытого экрана падал бы,
   * даже когда текст ответа доезжает.
   */
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  const session = useRef<{ stop: () => void } | null>(null);

  /**
   * Успел ли человек что-то открыть сам, пока с сервера ехал прошлый экран.
   * Восстановление не имеет права перебить то, что пользователь уже делает.
   */
  const touched = useRef(false);

  const openScreen = useCallback(
    (next: UISpec, nextData: Record<string, unknown>, nextJobId: string | null = null) => {
      touched.current = true;
      setHistory((prev) => (spec ? [...prev, { spec, data, jobId: currentJobId }] : prev));
      setSpec(next);
      setData(nextData);
      setCurrentJobId(nextJobId);
      setState({});
    },
    [spec, data, currentJobId]
  );

  const goBack = useCallback(() => {
    setHistory((prev) => {
      const last = prev[prev.length - 1];
      if (last) {
        setSpec(last.spec);
        setData(last.data);
        setCurrentJobId(last.jobId);
      } else {
        setSpec(null);
        setData({});
        setCurrentJobId(null);
      }
      setState({});
      return prev.slice(0, -1);
    });
  }, []);

  /**
   * Запоминаем, где человек остановился.
   *
   * Пишется указатель, а не экран: содержимое живёт на сервере, и хранить
   * его копию значит однажды показать её вместо настоящего состояния.
   */
  useEffect(() => {
    if (!ready) return;
    void saveScreen(spec ? { specId: spec.id, jobId: currentJobId } : null);
  }, [ready, spec, currentJobId]);

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

        // Экран, на котором человека прервали. Не блокирует появление
        // ленты: если сеть медленная, лучше показать хоть что-то и
        // подставить мини-аппу, когда она доедет.
        void restoreScreen();

        // Лента и онбординг грузятся параллельно: ни одно из них
        // не должно блокировать появление экрана.
        void refreshFeed();
        void fetchOnboarding()
          .then((o) => {
            setArchetypes(o.archetypes);
            setInboxAddress(o.inboxAddress);
          })
          .catch(() => {});
        void pushTokens.register().then((t) => (t ? registerPushToken(t) : undefined)).catch(() => {});
      } catch (err) {
        setError(`Не удалось подключиться к серверу: ${(err as Error).message}`);
      }
    })();
  }, []);

  /**
   * Возврат на прерванный экран.
   *
   * Спека берётся с сервера по идентификатору, а не из локальной копии:
   * задача за это время могла сдвинуться, и показать вчерашнее состояние
   * хуже, чем не показать ничего. Экрана нет (ушёл срок, это была
   * эфемерная страница вроде приватности) — просто остаёмся на ленте.
   */
  const restoreScreen = useCallback(async () => {
    const saved = await loadScreen();
    if (!saved) return;

    try {
      const { spec: restored, data: restoredData } = await fetchMiniApp(saved.specId);
      if (touched.current) return;

      setSpec(restored);
      setData(restoredData);
      setCurrentJobId(saved.jobId);
    } catch {
      await saveScreen(null);
    }
  }, []);

  const refreshFeed = useCallback(async () => {
    try {
      const data = await fetchFeed();
      setGreeting(data.greeting);
      setCards(data.cards);
    } catch {
      // Пустая лента лучше экрана с ошибкой: продукт остаётся рабочим.
    }
  }, []);

  const submit = useCallback(async (text: string, source: 'text' | 'voice') => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    touched.current = true;
    setBusy(true);
    setError(null);
    setInput('');
    // Новая задача — новая ветка: прошлые экраны остаются достижимы возвратом.
    setHistory((prev) => (spec ? [...prev, { spec, data, jobId: currentJobId }] : prev));
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
            setCurrentJobId(event.job.id);
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
            void refreshFeed();
            break;
        }
      });
      await promise;
    } catch {
      // Пользователю не нужен текст исключения: ему нужно, что делать дальше.
      setError('Связь с сервером прервалась. Задача не потеряна — попробуй ещё раз.');
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [busy, spec, data, currentJobId]);

  const runTool = useCallback(
    async (
      action: Extract<UIAction, { kind: 'tool' }>,
      confirmed: boolean,
      payload?: unknown
    ) => {
      try {
        /*
         * Полезная нагрузка узла — часть аргументов, а не отдельная сущность.
         * Раньше `fire` её передавал, а оболочка выбрасывала: поле ввода
         * отправляло `task.answer` с пустыми аргументами, и ответ человека
         * на уточняющий вопрос терялся между экраном и сервером.
         */
        const args = typeof payload === 'string' ? { ...action.args, text: payload } : action.args;

        const res = await dispatchAction(
          { ...action, args },
          {
            specId: spec?.id,
            jobId: job?.id ?? currentJobId ?? undefined,
            confirmed,
          }
        );

        if (res.needsConfirmation) {
          const text = res.confirmationText ?? 'Подтвердить действие?';
          setConfirm({
            action: { ...action, args },
            text,
            danger: /удал|безвозвратн|нельзя восстанов/i.test(text),
          });
          return;
        }
        if (res.dataPatch) setData((prev) => ({ ...prev, ...res.dataPatch }));
        if (res.message) setStatus(res.message);
        if (!res.ok && !res.message) {
          setError('Не получилось выполнить. Проверь связь и попробуй ещё раз.');
        }
      } catch {
        setError('Не получилось выполнить. Проверь связь и попробуй ещё раз.');
      }
    },
    [spec?.id, job?.id, currentJobId]
  );

  /**
   * Открыть сохранённую мини-аппу по идентификатору.
   *
   * То, чего не хватало ленте: карточка сообщала о деле, но не вела к нему,
   * и вернуться к вчерашнему чек-листу можно было только перенабрав фразу.
   */
  const openMiniApp = useCallback(
    async (id: string, jobId: string | null = null) => {
      try {
        const screen = await fetchMiniApp(id);
        openScreen(screen.spec, screen.data, jobId);
      } catch {
        setError('Не удалось открыть — попробуй ещё раз.');
      }
    },
    [openScreen]
  );

  const onAction = useCallback(
    (action: UIAction, payload?: unknown) => {
      switch (action.kind) {
        case 'tool':
          void runTool(action, false, payload);
          break;
        case 'submit':
          void runTool({ kind: 'tool', tool: action.tool, args: {}, optimistic: false }, false, payload);
          break;
        case 'setState':
          setState((prev) => ({ ...prev, [action.path]: payload ?? action.value }));
          break;
        case 'navigate':
          // Возврат к ленте — это возврат, а не отдельный экран.
          if (action.target === 'feed') {
            setHistory([]);
            setSpec(null);
            setData({});
          } else if (action.id) {
            void openMiniApp(action.id);
          }
          break;
        case 'handoff':
          void Linking.openURL(action.url).catch(() => {
            if (action.fallbackUrl) void Linking.openURL(action.fallbackUrl);
          });
          break;
      }
    },
    [runTool, openMiniApp]
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

  if (!fontsReady) {
    // Пустая бумага, а не спиннер и не текст чужой гарнитурой.
    return <View style={{ flex: 1, backgroundColor: theme.colors.bg }} />;
  }

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
        {/*
          Шапка. Заголовок объявлен на каждой спеке и раньше выбрасывался
          рендерером — вместе с ним у продукта не было и места для возврата.
        */}
        {spec && !devRegistry ? (
          <View style={styles.header}>
            <Tap onPress={goBack} label="Назад" style={styles.headerBack}>
              <Icon name="chevronLeft" size={22} color={theme.colors.text} />
            </Tap>
            {/*
              Заголовок в шапке — указатель местоположения, а не второй
              заголовок экрана: приглушённый и мелкий, чтобы не спорить
              с крупным заголовком в содержании.
            */}
            <Text numberOfLines={1} style={[textStyle(theme.font.caption, theme.colors.textMuted, { fontWeight: '600' }), { flex: 1 }]}>
              {spec.title}
            </Text>
          </View>
        ) : null}

        <View style={{ flex: 1 }}>
          {devRegistry ? (
            <Renderer spec={KITCHEN_SINK} data={{}} state={{}} theme={theme} onAction={onAction} />
          ) : spec ? (
            <Renderer spec={spec} data={data} state={state} theme={theme} onAction={onAction} />
          ) : (
            <HomeScreen
              theme={theme}
              greeting={greeting}
              cards={cards}
              examples={EXAMPLES}
              archetypes={archetypes}
              chosenArchetypes={chosenArchetypes}
              inboxAddress={inboxAddress}
              onExample={(text) => void submit(text, 'text')}
              onCard={(card) => (card.specId ? void openMiniApp(card.specId, card.jobId) : setStatus(card.body))}
              onToggleArchetype={(id) => {
                const next = chosenArchetypes.includes(id)
                  ? chosenArchetypes.filter((c) => c !== id)
                  : [...chosenArchetypes, id];
                setChosenArchetypes(next);
                void applyArchetypes(next);
              }}
              onOpenLifeMap={() => {
                void fetchLifeMap()
                  .then((map) => openScreen(map.spec, map.data))
                  .catch(() => setError('Карта не загрузилась. Попробуй ещё раз.'));
              }}
              onOpenPrivacy={() => {
                void fetchPrivacy()
                  .then((screen) => openScreen(screen.spec, screen.data))
                  .catch(() => setError('Экран не загрузился. Попробуй ещё раз.'));
              }}
            />
          )}
        </View>

        {/*
          Значение не передаётся одним цветом: у ошибки есть знак и роль.
          Скринридер раньше не объявлял ни успех, ни отказ — область живая.
        */}
        {status || error ? (
          <View
            style={[styles.banner, error ? styles.bannerError : null]}
            accessibilityLiveRegion="polite"
            accessibilityRole={error ? 'alert' : undefined}
          >
            {busy && !error ? <ActivityIndicator size="small" color={theme.colors.textMuted} /> : null}
            {error ? <Icon name="close" size={16} color={theme.colors.danger} /> : null}
            <Text style={[styles.bannerText, error ? { color: theme.colors.danger } : null]}>
              {error ?? status}
            </Text>
            {error ? (
              <Tap onPress={() => setError(null)} label="Закрыть сообщение" slop>
                <Text style={textStyle(theme.font.caption, theme.colors.textMuted, { fontWeight: '700' })}>скрыть</Text>
              </Tap>
            ) : null}
          </View>
        ) : null}

        {/*
          Подтверждение — модальное, с затемнением.
          Раньше лист висел строкой над композером, экран под ним оставался
          живым, и второе действие молча перетирало ожидающее. Опасность
          отличается не только словами: об этом знает реестр, а не оболочка,
          поэтому лист здесь один и тот же, что на серверных экранах.
        */}
        {confirm ? (
          <View style={styles.scrim}>
            <View style={styles.sheet}>
              <ConfirmSheet
                theme={theme}
                text={confirm.text}
                danger={confirm.danger}
                onConfirm={() => {
                  const pending = confirm;
                  setConfirm(null);
                  void runTool(pending.action, true);
                }}
                onCancel={() => setConfirm(null)}
              />
            </View>
          </View>
        ) : null}

        <View style={styles.composer}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={listening ? 'Слушаю…' : 'Напиши задачу'}
            placeholderTextColor={theme.colors.textMuted}
            accessibilityLabel="Что нужно сделать"
            style={styles.input}
            editable={!busy}
            onSubmitEditing={() => void submit(input, 'text')}
            returnKeyType="send"
          />
          <Tap
            onPress={() => void toggleVoice()}
            label={listening ? 'Остановить запись' : 'Голосовой ввод'}
            style={{ ...styles.iconBtn, ...(listening ? styles.iconBtnActive : {}) }}
          >
            <Icon name={listening ? 'square' : 'mic'} size={20} color={listening ? theme.colors.danger : theme.colors.text} filled={listening} />
          </Tap>
          <Tap
            onPress={() => void submit(input, 'text')}
            disabled={busy || input.trim() === ''}
            label="Отправить"
            /*
              Выключенное состояние выражается заливкой контейнера, а не
              прозрачностью содержимого. Прежние opacity 0.4 давали стрелке
              контраст 1.98:1 — и это было состоянием по умолчанию на каждой
              загрузке любого экрана.
            */
            style={{
              ...styles.sendBtn,
              backgroundColor: busy || input.trim() === '' ? theme.colors.surfaceAlt : theme.colors.accent,
              borderWidth: busy || input.trim() === '' ? 1 : 0,
              borderColor: theme.colors.control,
            }}
          >
            <Icon
              name="arrowRight"
              size={20}
              color={busy || input.trim() === '' ? theme.colors.textMuted : theme.colors.accentText}
            />
          </Tap>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(theme: typeof lightTheme) {
  return {
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' } as const,
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing(1),
      paddingHorizontal: theme.spacing(2),
      paddingVertical: theme.spacing(1),
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.bg,
    } as const,
    headerBack: { width: TARGET, alignItems: 'center', justifyContent: 'center' } as const,
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing(2),
      paddingHorizontal: theme.spacing(5),
      paddingVertical: theme.spacing(2.5),
    } as const,
    bannerError: { backgroundColor: `${theme.colors.danger}12` } as const,
    bannerText: {
      color: theme.colors.textMuted,
      fontSize: theme.font.small.size,
      lineHeight: theme.font.small.lineHeight,
      flex: 1,
    } as const,
    /* Затемнение: экран под листом не должен принимать нажатия. */
    scrim: {
      position: 'absolute',
      top: 0, bottom: 0, left: 0, right: 0,
      backgroundColor: '#00000066',
      justifyContent: 'flex-end',
    } as const,
    sheet: { padding: theme.spacing(4) } as const,
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
      /*
        Без minWidth: 0 поле перестаёт сжиматься на 229 px, и строка
        композера требует 357 px — на экране 320 px это 25 px переполнения
        на КАЖДОМ экране, потому что композер постоянный.
      */
      minWidth: 0,
      flexShrink: 1,
      backgroundColor: theme.colors.surfaceAlt,
      borderWidth: 1,
      borderColor: theme.colors.control,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing(3.5),
      paddingVertical: theme.spacing(3),
      color: theme.colors.text,
      fontSize: theme.font.body.size,
      lineHeight: theme.font.body.lineHeight,
      minHeight: TARGET,
    } as const,
    iconBtn: {
      width: TARGET,
      height: TARGET,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.colors.control,
    } as const,
    iconBtnActive: { backgroundColor: `${theme.colors.danger}22`, borderColor: theme.colors.danger } as const,
    sendBtn: {
      width: TARGET,
      height: TARGET,
      borderRadius: theme.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.accent,
    } as const,
  };
}
