import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';
import { COACH_SYSTEM_PROMPT } from '../lib/coach-prompt.js';

const redis = Redis.fromEnv();
const MODEL = 'claude-sonnet-4-6';

// Default to zip 10011 (Chelsea, Manhattan); override with env vars when traveling.
const WEATHER_LAT = process.env.WEATHER_LAT || '40.7420';
const WEATHER_LON = process.env.WEATHER_LON || '-74.0000';
const WEATHER_TZ = process.env.WEATHER_TZ || 'America/New_York';
// Local hours of the runner's usual morning window; the forecast focuses here.
const WEATHER_RUN_HOURS = (process.env.WEATHER_RUN_HOURS || '8,9')
  .split(',')
  .map((h) => parseInt(h.trim(), 10))
  .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);

// Human label for the run window, e.g. [8,9] -> "8-9am".
const RUN_WINDOW_LABEL = (() => {
  if (!WEATHER_RUN_HOURS.length) return null;
  const lo = Math.min(...WEATHER_RUN_HOURS);
  const hi = Math.max(...WEATHER_RUN_HOURS);
  const mer = (h) => (h < 12 ? 'am' : 'pm');
  const h12 = (h) => (h % 12 === 0 ? 12 : h % 12);
  if (lo === hi) return `${h12(lo)}${mer(lo)}`;
  if (mer(lo) === mer(hi)) return `${h12(lo)}-${h12(hi)}${mer(hi)}`;
  return `${h12(lo)}${mer(lo)}-${h12(hi)}${mer(hi)}`;
})();

// Open-Meteo WMO weather codes → short human-readable conditions.
const WEATHER_CODES = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'light rain showers', 81: 'rain showers', 82: 'heavy rain showers',
  85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail',
  99: 'thunderstorm with hail',
};

function cacheKey(activityId) {
  return `coach:blurb:v3:${activityId}`;
}

// Free, no-key Open-Meteo forecast for the next workout's date, summarized over
// the runner's morning run window (hourly data, local time). Returns null (and
// never throws) so a weather outage can't block the blurb.
async function fetchNextDayWeather(dateIso) {
  if (!dateIso || !WEATHER_RUN_HOURS.length) return null;
  try {
    const params = new URLSearchParams({
      latitude: WEATHER_LAT,
      longitude: WEATHER_LON,
      hourly: 'weathercode,temperature_2m,apparent_temperature,precipitation_probability,windspeed_10m',
      temperature_unit: 'fahrenheit',
      windspeed_unit: 'mph',
      timezone: WEATHER_TZ,
      start_date: dateIso,
      end_date: dateIso,
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const data = await res.json();
    const h = data.hourly;
    if (!h || !Array.isArray(h.time) || !h.time.length) return null;

    // Rows matching the run-window hours (e.g. "...T08:00", "...T09:00") in local time.
    const idxs = WEATHER_RUN_HOURS
      .map((hr) => h.time.findIndex((t) => t.endsWith(`T${String(hr).padStart(2, '0')}:00`)))
      .filter((i) => i >= 0);
    if (!idxs.length) return null;

    const pick = (arr) => idxs.map((i) => arr?.[i]).filter((v) => v != null);
    const temps = pick(h.temperature_2m);
    const feels = pick(h.apparent_temperature);
    const precip = pick(h.precipitation_probability);
    const winds = pick(h.windspeed_10m);
    const codes = pick(h.weathercode);

    // Report the wettest hour's condition so rain in the window isn't hidden.
    let condIdx = 0;
    if (precip.length && precip.length === codes.length) {
      condIdx = precip.reduce((best, p, i) => (p > precip[best] ? i : best), 0);
    }

    return {
      condition: codes.length ? WEATHER_CODES[codes[condIdx]] || null : null,
      lo: temps.length ? Math.min(...temps) : undefined,
      hi: temps.length ? Math.max(...temps) : undefined,
      feelsMax: feels.length ? Math.max(...feels) : undefined,
      precipProb: precip.length ? Math.max(...precip) : undefined,
      windMax: winds.length ? Math.max(...winds) : undefined,
    };
  } catch (err) {
    console.error('coach-analysis: weather fetch failed:', err);
    return null;
  }
}

function buildUserMessage(activity, plannedWorkout, nextWorkout, weather) {
  const lines = [
    `Planned workout: ${plannedWorkout.type || 'n/a'} (${plannedWorkout.kind || 'n/a'}), ${plannedWorkout.miles ?? 'n/a'} mi, target pace ${plannedWorkout.pace || 'n/a'}, target HR ${plannedWorkout.hr || 'n/a'}. Week ${plannedWorkout.week ?? 'n/a'}, ${plannedWorkout.phase || 'n/a'} phase.`,
  ];
  if (plannedWorkout.focus) {
    lines.push(`Workout notes: ${plannedWorkout.focus}`);
  }
  const hrBits = [];
  if (activity.average_heartrate) hrBits.push(`avg HR ${activity.average_heartrate}`);
  if (activity.max_heartrate) hrBits.push(`max HR ${activity.max_heartrate}`);
  lines.push(
    `Actual run: ${activity.distance} mi, avg pace ${activity.avg_pace || 'n/a'}/mi${hrBits.length ? `, ${hrBits.join(', ')}` : ''}.`
  );
  if (nextWorkout) {
    const nw = nextWorkout;
    const isRest = !nw.miles;
    if (isRest) {
      lines.push(`Next day (${nw.dow || 'n/a'}): rest day.`);
    } else {
      lines.push(
        `Next day (${nw.dow || 'n/a'}): ${nw.type || 'n/a'} (${nw.kind || 'n/a'}), ${nw.miles ?? 'n/a'} mi, target pace ${nw.pace || 'n/a'}, target HR ${nw.hr || 'n/a'}.${nw.focus ? ` Notes: ${nw.focus}` : ''}`
      );
    }
  }
  if (weather) {
    const parts = [];
    if (weather.condition) parts.push(weather.condition);
    if (weather.lo != null && weather.hi != null) parts.push(`${Math.round(weather.lo)}-${Math.round(weather.hi)}°F`);
    else if (weather.hi != null) parts.push(`high ${Math.round(weather.hi)}°F`);
    if (weather.feelsMax != null) parts.push(`feels like up to ${Math.round(weather.feelsMax)}°F`);
    if (weather.precipProb != null) parts.push(`${weather.precipProb}% chance of precip`);
    if (weather.windMax != null) parts.push(`wind up to ${Math.round(weather.windMax)} mph`);
    if (parts.length) {
      const label = RUN_WINDOW_LABEL ? ` for the runner's ${RUN_WINDOW_LABEL} run window` : '';
      lines.push(`Next-day forecast${label}: ${parts.join(', ')}.`);
    }
  }
  lines.push('Give your coaching take on this run.');
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { activityId, activity, plannedWorkout, nextWorkout } = req.body || {};
  if (!activityId || !activity || !plannedWorkout) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }

  try {
    const cached = await redis.get(cacheKey(activityId));
    if (cached) {
      res.status(200).json({ blurb: cached, cached: true });
      return;
    }
  } catch (err) {
    console.error('coach-analysis: redis read failed:', err);
  }

  try {
    // Only pull a forecast when the next day is an actual run.
    const weather = nextWorkout && nextWorkout.miles
      ? await fetchNextDayWeather(nextWorkout.dateIso)
      : null;

    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: COACH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(activity, plannedWorkout, nextWorkout, weather) }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const blurb = textBlock ? textBlock.text.trim() : '';
    if (!blurb) {
      throw new Error('empty response from Anthropic');
    }

    try {
      await redis.set(cacheKey(activityId), blurb);
    } catch (err) {
      console.error('coach-analysis: redis write failed:', err);
    }

    res.status(200).json({ blurb, cached: false });
  } catch (err) {
    console.error('coach-analysis: failed to generate blurb:', err);
    res.status(200).json({ blurb: null, error: true });
  }
}
