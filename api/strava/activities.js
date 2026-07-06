import { Redis } from '@upstash/redis';
import { getValidAccessToken } from '../../lib/strava-tokens.js';

const redis = Redis.fromEnv();
const CACHE_KEY = 'strava:activities:cache';
const CACHE_TTL_SECONDS = 10 * 60;
const METERS_PER_MILE = 1609.34;
const LOOKBACK_DAYS = 30;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function formatPace(secondsPerMile) {
  if (!Number.isFinite(secondsPerMile) || secondsPerMile <= 0) return null;
  const total = Math.round(secondsPerMile);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function transformActivity(a) {
  const distanceMiles = (a.distance || 0) / METERS_PER_MILE;
  const movingTime = a.moving_time || 0;
  const avgPaceSecPerMile = distanceMiles > 0 ? movingTime / distanceMiles : null;
  return {
    id: a.id,
    date: (a.start_date_local || a.start_date || '').slice(0, 10),
    distance: round1(distanceMiles),
    moving_time: movingTime,
    avg_pace: formatPace(avgPaceSecPerMile),
    average_heartrate: a.average_heartrate != null ? Math.round(a.average_heartrate) : null,
    max_heartrate: a.max_heartrate != null ? Math.round(a.max_heartrate) : null,
    name: a.name || '',
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      res.status(200).json({ connected: true, activities: cached });
      return;
    }
  } catch (err) {
    console.error('strava/activities: redis read failed:', err);
  }

  let accessToken;
  try {
    accessToken = await getValidAccessToken();
  } catch {
    res.status(200).json({ connected: false, activities: [] });
    return;
  }

  try {
    const after = Math.floor((Date.now() - LOOKBACK_DAYS * 86400000) / 1000);
    const params = new URLSearchParams({ after: String(after), per_page: '100' });

    const activitiesRes = await fetch(`https://www.strava.com/api/v3/athlete/activities?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!activitiesRes.ok) {
      throw new Error(`Strava activities request failed: ${activitiesRes.status}`);
    }

    const raw = await activitiesRes.json();
    const activities = raw.filter((a) => a.type === 'Run').map(transformActivity);

    try {
      await redis.set(CACHE_KEY, activities, { ex: CACHE_TTL_SECONDS });
    } catch (err) {
      console.error('strava/activities: redis write failed:', err);
    }

    res.status(200).json({ connected: true, activities });
  } catch (err) {
    console.error('strava/activities: failed to fetch Strava activities:', err);
    res.status(200).json({ connected: true, activities: [], error: true });
  }
}
