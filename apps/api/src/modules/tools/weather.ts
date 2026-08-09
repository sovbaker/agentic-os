import { log } from '../../obs/log';

/**
 * Погода через Open-Meteo — единственный по-настоящему внешний вызов в S1.
 * Ключ не нужен, что удобно: инструмент работает сразу, без регистрации.
 *
 * Геокодинг вынесен в отдельный порт со статической таблицей: сервис
 * геокодирования в этом окружении недоступен, а зашивать сетевой вызов
 * в единственный путь — способ получить инструмент, который «иногда не
 * работает» без объяснений.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
  label: string;
}

export interface GeocodePort {
  lookup(city: string): Promise<Coordinates | null>;
}

const CITIES: Record<string, Coordinates> = {
  москва: { latitude: 55.7558, longitude: 37.6173, label: 'Москва' },
  'санкт-петербург': { latitude: 59.9311, longitude: 30.3609, label: 'Санкт-Петербург' },
  питер: { latitude: 59.9311, longitude: 30.3609, label: 'Санкт-Петербург' },
  новосибирск: { latitude: 55.0084, longitude: 82.9357, label: 'Новосибирск' },
  екатеринбург: { latitude: 56.8389, longitude: 60.6057, label: 'Екатеринбург' },
  казань: { latitude: 55.7963, longitude: 49.1088, label: 'Казань' },
  сочи: { latitude: 43.6028, longitude: 39.7342, label: 'Сочи' },
  тбилиси: { latitude: 41.7151, longitude: 44.8271, label: 'Тбилиси' },
  ереван: { latitude: 40.1792, longitude: 44.4991, label: 'Ереван' },
  рим: { latitude: 41.9028, longitude: 12.4964, label: 'Рим' },
  милан: { latitude: 45.4642, longitude: 9.19, label: 'Милан' },
  белград: { latitude: 44.7866, longitude: 20.4489, label: 'Белград' },
};

export class TableGeocode implements GeocodePort {
  async lookup(city: string): Promise<Coordinates | null> {
    return CITIES[city.trim().toLowerCase()] ?? null;
  }
}

/** Коды WMO — только те группы, что реально различимы в интерфейсе. */
function describe(code: number): string {
  if (code === 0) return 'ясно';
  if (code <= 3) return 'переменная облачность';
  if (code <= 48) return 'туман';
  if (code <= 57) return 'морось';
  if (code <= 67) return 'дождь';
  if (code <= 77) return 'снег';
  if (code <= 82) return 'ливень';
  if (code <= 86) return 'снегопад';
  return 'гроза';
}

export interface WeatherNow {
  place: string;
  temperature: number;
  description: string;
  observedAt: string;
}

export async function currentWeather(
  city: string,
  geocode: GeocodePort = new TableGeocode()
): Promise<WeatherNow | null> {
  const coords = await geocode.lookup(city);
  if (!coords) return null;

  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(coords.latitude));
    url.searchParams.set('longitude', String(coords.longitude));
    url.searchParams.set('current', 'temperature_2m,weather_code');
    url.searchParams.set('timezone', 'auto');

    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`weather ${res.status}`);

    const body = (await res.json()) as {
      current?: { time?: string; temperature_2m?: number; weather_code?: number };
    };
    const current = body.current;
    if (!current || typeof current.temperature_2m !== 'number') return null;

    return {
      place: coords.label,
      temperature: Math.round(current.temperature_2m),
      description: describe(current.weather_code ?? 0),
      observedAt: current.time ?? new Date().toISOString(),
    };
  } catch (err) {
    log.warn('погода недоступна', { error: (err as Error).message, city });
    return null;
  }
}
