import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';
import { COACH_SYSTEM_PROMPT } from '../lib/coach-prompt.js';

const redis = Redis.fromEnv();
const MODEL = 'claude-sonnet-4-6';

// Default to NYC (runner's home base); override with env vars when traveling.
const WEATHER_LAT = process.env.WEATHER_LAT || '40.7128';
const WEATHER_LON = process.env.WEATHER_LON || '-74.0060';
const WEATHER_TZ = process.env.WEATHER_TZ || 'America/New_York';

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
  return `coach:blurb:v2:${activityId}`;
}

// Free, no-key daily forecast for the next workout's date via Open-Meteo.
// Returns null (and never throws) so a weather outage can't block the blurb.
async function fetchNextDayWeather(dateIso) {
  if (!dateIso) return null;
  try {
    const params = new URLSearchParams({
      latitude: WEATHER_LAT,
      longitude: WEATHER_LON,
      daily: 'weathercode,temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_probability_max,windspeed_10m_max',
      temperature_unit: 'fahrenheit',
      windspeed_unit: 'mph',
      timezone: WEATHER_TZ,
      start_date: dateIso,
      end_date: dateIso,
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const data = await res.json();
    const d = data.daily;
    if (!d || !Array.isArray(d.time) || !d.time.length) return null;
    return {
      condition: WEATHER_CODES[d.weathercode?.[0]] || null,
      hi: d.temperature_2m_max?.[0],
      lo: d.temperature_2m_min?.[0],
      feelsMax: d.apparent_temperature_max?.[0],
      precipProb: d.precipitation_probability_max?.[0],
      windMax: d.windspeed_10m_max?.[0],
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
      lines.push(`Next-day weather forecast: ${parts.join(', ')}.`);
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
