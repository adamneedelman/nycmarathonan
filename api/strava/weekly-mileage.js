import { getValidAccessToken } from '../../lib/strava-tokens.js';
import { fetchPlan, resolveCurrentWeek } from '../../lib/plan-week.js';

const METERS_PER_MILE = 1609.34;

function round1(n) {
  return Math.round(n * 10) / 10;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  let weekNumber;
  let plannedMiles;
  let startEpochMs;
  let endEpochMs;

  try {
    const plan = await fetchPlan();
    ({ weekNumber, plannedMiles, startEpochMs, endEpochMs } = resolveCurrentWeek(plan));
  } catch (err) {
    console.error('weekly-mileage: failed to resolve plan week:', err);
    res.status(500).json({ error: 'plan_unavailable' });
    return;
  }

  const plannedMilesRounded = round1(plannedMiles);

  let accessToken;
  try {
    accessToken = await getValidAccessToken();
  } catch {
    res.status(200).json({
      actual_miles: null,
      planned_miles: plannedMilesRounded,
      week_number: weekNumber,
      connected: false,
    });
    return;
  }

  try {
    const after = Math.floor(startEpochMs / 1000) - 1;
    const before = Math.floor(endEpochMs / 1000) + 1;
    const params = new URLSearchParams({ after: String(after), before: String(before), per_page: '200' });

    const activitiesRes = await fetch(`https://www.strava.com/api/v3/athlete/activities?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!activitiesRes.ok) {
      throw new Error(`Strava activities request failed: ${activitiesRes.status}`);
    }

    const activities = await activitiesRes.json();
    const totalMeters = activities
      .filter((a) => a.type === 'Run')
      .reduce((sum, a) => sum + (a.distance || 0), 0);

    res.status(200).json({
      actual_miles: round1(totalMeters / METERS_PER_MILE),
      planned_miles: plannedMilesRounded,
      week_number: weekNumber,
      connected: true,
    });
  } catch (err) {
    console.error('weekly-mileage: failed to fetch Strava activities:', err);
    res.status(200).json({
      actual_miles: null,
      planned_miles: plannedMilesRounded,
      week_number: weekNumber,
      connected: true,
    });
  }
}
