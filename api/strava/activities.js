import { Redis } from '@upstash/redis';
import { getValidAccessToken } from '../../lib/strava-tokens.js';
import { transformActivity } from '../../lib/strava-activities.js';

const redis = Redis.fromEnv();
const CACHE_KEY = 'strava:activities:cache:v2';
const CACHE_TTL_SECONDS = 10 * 60;
const LOOKBACK_DAYS = 30;

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
