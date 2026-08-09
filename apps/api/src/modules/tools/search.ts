import { log } from '../../obs/log';

/**
 * Порт поиска.
 *
 * Всё, что возвращает поиск, — недоверенный контент по определению:
 * страницу в интернете может написать кто угодно, в том числе с расчётом
 * на то, что её прочитает агент. Поэтому результат уходит в карантин,
 * а не в контекст с инструментами.
 */

export interface SearchResult {
  title: string;
  url?: string;
  snippet: string;
}

export interface SearchPort {
  readonly name: string;
  search(query: string, limit: number): Promise<SearchResult[]>;
}

/**
 * Детерминированный поиск для офлайна и тестов.
 *
 * Не «пока не подключили настоящий»: на нём воспроизводимо гоняются эвалы,
 * и результат прогона не зависит от того, что сегодня в выдаче.
 */
export class StubSearch implements SearchPort {
  readonly name = 'stub';

  private readonly canned: Array<{ match: RegExp; results: SearchResult[] }> = [
    {
      match: /(виз|документ|консульств|шенген)/i,
      results: [
        {
          title: 'Список документов на шенгенскую визу',
          url: 'https://example.org/schengen-docs',
          snippet:
            'Загранпаспорт должен быть действителен не менее трёх месяцев после окончания поездки. ' +
            'Потребуются две фотографии 35×45 мм, сделанные не ранее полугода назад. ' +
            'Медицинская страховка оформляется на весь срок пребывания с покрытием от 30 000 евро.',
        },
        {
          title: 'Сроки рассмотрения заявления',
          url: 'https://example.org/schengen-terms',
          snippet:
            'Стандартный срок рассмотрения составляет от 10 до 15 календарных дней. ' +
            'В высокий сезон запись в визовый центр стоит бронировать за месяц.',
        },
      ],
    },
    {
      match: /(подрядчик|ремонт|мастер|потолк)/i,
      results: [
        {
          title: 'Как выбирать подрядчика на ремонт',
          url: 'https://example.org/contractors',
          snippet:
            'Просите смету в письменном виде с разбивкой по материалам и работам. ' +
            'Фиксируйте сроки этапов в договоре и не платите более 30 процентов авансом.',
        },
      ],
    },
  ];

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const hit = this.canned.find((c) => c.match.test(query));
    const results = hit?.results ?? [
      {
        title: `Общая справка по запросу «${query.slice(0, 60)}»`,
        snippet: 'Подробные источники подключатся вместе с боевым поисковым провайдером.',
      },
    ];
    return results.slice(0, limit);
  }
}

/**
 * Боевой адаптер под произвольный JSON-API поиска (Brave, Serper и подобные).
 * Формат ответа задаётся минимальными допущениями, чтобы смена провайдера
 * не трогала ничего выше порта.
 */
export class HttpSearch implements SearchPort {
  readonly name = 'http';

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly fallback: SearchPort = new StubSearch()
  ) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(limit));

      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`search ${res.status}`);

      const body = (await res.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
        organic?: Array<{ title?: string; link?: string; snippet?: string }>;
      };

      const raw = body.web?.results ?? body.organic ?? [];
      const results = raw.slice(0, limit).map((r) => ({
        title: (('title' in r && r.title) || 'Без заголовка').slice(0, 160),
        ...(('url' in r && r.url) || ('link' in r && r.link)
          ? { url: (('url' in r && r.url) || ('link' in r && r.link)) as string }
          : {}),
        snippet: ((('description' in r && r.description) || ('snippet' in r && r.snippet)) || '').slice(0, 1200),
      }));

      return results.length > 0 ? results : this.fallback.search(query, limit);
    } catch (err) {
      // Деградация, а не отказ: задача продолжается без обогащения.
      log.warn('поиск недоступен, работаем на детерминированном адаптере', {
        error: (err as Error).message,
      });
      return this.fallback.search(query, limit);
    }
  }
}

export function createSearch(): SearchPort {
  const endpoint = process.env['SEARCH_API_URL'];
  const key = process.env['SEARCH_API_KEY'];
  if (endpoint && key) return new HttpSearch(endpoint, key);
  return new StubSearch();
}
