const METERS_PER_MILE = 1609.34;
const FEET_PER_METER = 3.28084;
const PER_PAGE = 200;
const MAX_PAGES = 10;

export function round1(n) {
  return Math.round(n * 10) / 10;
}

export function formatPace(secondsPerMile) {
  if (!Number.isFinite(secondsPerMile) || secondsPerMile <= 0) return null;
  const total = Math.round(secondsPerMile);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function transformActivity(a) {
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
    elevation_gain_ft: a.total_elevation_gain != null ? Math.round(a.total_elevation_gain * FEET_PER_METER) : null,
    name: a.name || '',
  };
}

// Paginated fetch of Run activities from Strava within [afterEpochSec, beforeEpochSec],
// returned as compact transformed records (no raw streams/splits).
export async function fetchActivitiesInRange(accessToken, afterEpochSec, beforeEpochSec) {
  let all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      after: String(afterEpochSec),
      before: String(beforeEpochSec),
      per_page: String(PER_PAGE),
      page: String(page),
    });
    const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Strava activities request failed: ${res.status}`);
    }
    const batch = await res.json();
    all = all.concat(batch);
    if (batch.length < PER_PAGE) break;
  }
  return all.filter((a) => a.type === 'Run').map(transformActivity);
}
