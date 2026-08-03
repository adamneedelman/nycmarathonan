// Terrain and grade-adjusted effort metrics, derived from Strava activity streams.
//
// The activity summary gives total elevation gain and nothing else about the
// terrain: it can't tell a steady 200ft drag from the same 200ft taken as one
// wall, and Strava never exposes its own Grade Adjusted Pace through the API.
// Both matter for "how hard was that run really", so the streams get pulled
// once per activity and reduced to a handful of numbers here.
//
// Streams are immutable once an activity is uploaded, so every result is cached
// in Redis permanently under one index key. That makes this one extra Strava
// call per new run, against a limit of 1000/day. Nothing here throws into the
// caller: a streams outage should cost a blurb its terrain context, never block
// the blurb itself.

import { Redis } from '@upstash/redis';
import { HILLS_KEY } from './coach-cache.js';
import { formatPace } from './strava-activities.js';

const redis = Redis.fromEnv();

const METERS_PER_MILE = 1609.34;

// Minetti et al. (2002), J Appl Physiol: metabolic cost of running in J/kg/m as
// a function of gradient i (decimal, so 0.05 is a 5% climb). Flat costs 3.6.
const FLAT_COST = 3.6;
const costOfRunning = (i) =>
  155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;

// Minetti fitted from -45% to +45%, but the downhill half of that curve keeps
// getting cheaper long after real running stops getting easier; the treadmill
// protocol never captured the braking cost of a fast descent. Clamping the
// grade and flooring the multiplier stops one steep block from flattering a
// whole run. Neither bound is reachable on NYC terrain, they exist for trails
// and for GPS spikes.
const MIN_GRADE = -0.1;
const MAX_GRADE = 0.25;
const MIN_FACTOR = 0.7;

export function gradeFactor(gradePercent) {
  const i = Math.min(MAX_GRADE, Math.max(MIN_GRADE, (gradePercent || 0) / 100));
  return Math.max(MIN_FACTOR, costOfRunning(i) / FLAT_COST);
}

// A run counts as hilly at 40ft of gain per mile. Greenway miles run 10-20, a
// Central Park loop lands near 55-70, and the NYC course averages roughly 45.
export const HILLY_FT_PER_MILE = 40;

// Grades at or above this count as climbing for the time-share number.
const CLIMB_GRADE = 3;

// Sampling guards: a usable step is short and forward. Longer gaps are auto-pause
// or a dropped signal, and zero-distance steps are a stopped watch.
const MAX_SAMPLE_SECONDS = 20;

export async function fetchStreams(accessToken, activityId) {
  const params = new URLSearchParams({
    keys: 'time,distance,grade_smooth,moving',
    key_by_type: 'true',
  });
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/streams?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  // Manual entries and most treadmill uploads carry no streams at all.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Strava streams request failed: ${res.status}`);
  return res.json();
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

// Walks the stream sample by sample and accumulates an equivalent-flat time:
// for each step, the time it would have taken to cover that ground on the flat
// at the same metabolic cost. Total distance over that equivalent time is GAP.
export function computeHillMetrics(streams, summary = {}) {
  const time = streams?.time?.data;
  const distance = streams?.distance?.data;
  const grade = streams?.grade_smooth?.data;
  if (!Array.isArray(time) || !Array.isArray(distance) || !Array.isArray(grade)) return null;

  const moving = streams?.moving?.data;
  const n = Math.min(time.length, distance.length, grade.length);
  if (n < 2) return null;

  let movingSec = 0;
  let equivalentSec = 0;
  let meters = 0;
  let climbSec = 0;
  const grades = [];

  for (let k = 1; k < n; k++) {
    const dt = time[k] - time[k - 1];
    const dd = distance[k] - distance[k - 1];
    if (!(dt > 0) || dt > MAX_SAMPLE_SECONDS || !(dd > 0)) continue;
    if (Array.isArray(moving) && moving[k] === false) continue;

    const g = Number.isFinite(grade[k]) ? grade[k] : 0;
    movingSec += dt;
    meters += dd;
    equivalentSec += dt / gradeFactor(g);
    if (g >= CLIMB_GRADE) climbSec += dt;
    grades.push(g);
  }

  if (movingSec <= 0 || meters <= 0) return null;

  const miles = meters / METERS_PER_MILE;
  const rawPaceSec = movingSec / miles;
  const gapPaceSec = equivalentSec / miles;
  const gainFt = summary.elevation_gain_ft ?? null;
  const elevPerMile = gainFt != null && miles > 0 ? Math.round(gainFt / miles) : null;
  grades.sort((a, b) => a - b);

  return {
    gap_pace: formatPace(gapPaceSec),
    gap_pace_sec: Math.round(gapPaceSec),
    raw_pace_sec: Math.round(rawPaceSec),
    // Positive means the terrain cost time: GAP is faster than the clock.
    terrain_cost_sec: Math.round(rawPaceSec - gapPaceSec),
    elevation_gain_ft: gainFt,
    elev_per_mile: elevPerMile,
    climb_time_pct: Math.round((climbSec / movingSec) * 100),
    // p95 rather than the max, which on GPS data is almost always a spike.
    steep_grade_pct: Math.round((percentile(grades, 0.95) ?? 0) * 10) / 10,
    hilly: elevPerMile != null && elevPerMile >= HILLY_FT_PER_MILE,
  };
}

// { [activityId]: { date, distance, avg_hr, ...metrics } } under a single key,
// mirroring how coach notes are stored. A full block is roughly 120 runs, so
// read-modify-write on one JSON blob stays cheap and avoids a second key space.
export async function readHillIndex() {
  try {
    return (await redis.get(HILLS_KEY)) || {};
  } catch (err) {
    console.error('strava-streams: hill index read failed:', err);
    return {};
  }
}

async function writeHillRecord(activityId, record) {
  try {
    const index = (await redis.get(HILLS_KEY)) || {};
    index[String(activityId)] = record;
    await redis.set(HILLS_KEY, index);
  } catch (err) {
    console.error('strava-streams: hill index write failed:', err);
  }
}

// Returns the cached terrain record for an activity, computing and caching it
// on first sight. Returns null for anything without usable streams (treadmill,
// manual entry, combined multi-run days) rather than throwing.
export async function ensureHillMetrics(accessToken, activity, index = null) {
  if (!activity?.id) return null;
  const id = String(activity.id);
  // Multi-run days arrive as a composite id ("123-456") that Strava won't know.
  if (id.includes('-')) return null;

  const cached = index ? index[id] : (await readHillIndex())[id];
  if (cached) return cached;

  try {
    const streams = await fetchStreams(accessToken, id);
    const metrics = computeHillMetrics(streams, activity);
    if (!metrics) return null;

    const record = {
      ...metrics,
      date: activity.date || null,
      distance: activity.distance ?? null,
      avg_hr: activity.average_heartrate ?? null,
    };
    await writeHillRecord(id, record);
    if (index) index[id] = record;
    return record;
  } catch (err) {
    console.error(`strava-streams: metrics failed for activity ${id}:`, err);
    return null;
  }
}

// One-line terrain summary for a coach prompt. Returns null when the run was
// flat enough and even enough that saying anything would just be noise.
// Gain per mile below this is Greenway-flat: reporting it says nothing the
// pace and HR don't already say.
const NOTABLE_FT_PER_MILE = 25;

export function formatTerrainLine(metrics) {
  if (!metrics) return null;

  // Everything beyond the bare gain figure. If none of it fires and the route
  // was flat, the run has no terrain story and the coach shouldn't invent one.
  const detail = [];
  if (metrics.climb_time_pct >= 5) {
    detail.push(`${metrics.climb_time_pct}% of moving time on grades of 3% or steeper`);
  }
  if (metrics.steep_grade_pct >= 3) {
    detail.push(`sustained climbs around ${metrics.steep_grade_pct}%`);
  }
  if (metrics.gap_pace && Math.abs(metrics.terrain_cost_sec) >= 4) {
    const cost = metrics.terrain_cost_sec;
    detail.push(
      cost > 0
        ? `grade-adjusted pace ${metrics.gap_pace}/mi, so the terrain cost about ${cost} sec/mi versus the clock`
        : `grade-adjusted pace ${metrics.gap_pace}/mi, so the net descent gave back about ${Math.abs(cost)} sec/mi`
    );
  }

  const flat = (metrics.elev_per_mile ?? 0) < NOTABLE_FT_PER_MILE;
  if (!detail.length && flat) return null;

  const bits = [];
  if (metrics.elevation_gain_ft != null) {
    bits.push(
      `${metrics.elevation_gain_ft}ft gain${metrics.elev_per_mile != null ? ` (${metrics.elev_per_mile}ft/mi)` : ''}`
    );
  }
  bits.push(...detail);
  if (!bits.length) return null;
  return `Terrain: ${bits.join(', ')}.`;
}

// Chronological history of hilly runs for the weekly review's trend read.
export function hillHistoryLines(index, beforeDateIso = null) {
  return Object.values(index || {})
    .filter((r) => r && r.hilly && r.date && (!beforeDateIso || r.date <= beforeDateIso))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      const hr = r.avg_hr ? `avg HR ${r.avg_hr}` : 'no HR';
      return `${r.date}: ${r.distance ?? '?'}mi, ${r.elev_per_mile}ft/mi, actual ${formatPace(r.raw_pace_sec)}/mi, grade-adjusted ${r.gap_pace}/mi, ${hr}.`;
    });
}
