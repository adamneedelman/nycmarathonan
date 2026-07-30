import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';
import { getValidAccessToken } from '../../lib/strava-tokens.js';
import { fetchPlan, getWeekByNumber, isWeekReviewAvailableEastern } from '../../lib/plan-week.js';
import { fetchActivitiesInRange, round1, formatPace } from '../../lib/strava-activities.js';
import { COACH_SYSTEM_PROMPT, WEEKLY_REVIEW_PROMPT_ADDENDUM } from '../../lib/coach-prompt.js';
import { NOTES_KEY, weeklyReviewKey as reviewKey, weeklyActualsKey as actualsKey, noteLookups } from '../../lib/coach-cache.js';

const redis = Redis.fromEnv();
const MODEL = 'claude-sonnet-4-6';

// The runner's own notes on individual runs ("did strides at the end", "knee
// felt tight"). Matched by date first, since a day with two logged runs is one
// activity here but a composite id on the client. Never throws: a notes outage
// should cost the review its colour, not block it.
async function fetchNoteLookups() {
  try {
    return noteLookups((await redis.get(NOTES_KEY)) || {});
  } catch (err) {
    console.error('weekly-review: notes read failed:', err);
    return { byDate: new Map(), byActivityId: new Map() };
  }
}

function noteForDay(notes, dateIso, activity) {
  return notes.byDate.get(dateIso)
    || (activity ? notes.byActivityId.get(String(activity.id)) : null)
    || null;
}

// Every run logged on one calendar date, combined into a single day record:
// distance and time summed, pace recomputed from the combined total, HR
// averaged weighted by moving time, max HR taken across the runs. Mirrors
// combineDayRuns() in index.html so a double-run day reads the same here as it
// does in the app.
//
// This previously kept only the day's longest run, which left the day lines
// short of the weekly total computed below from every activity: on a day with
// a 2.5mi and a 1.4mi run the model was told the day was 2.5mi while the
// week's total counted all 3.9mi of it.
function combineDayRuns(runs) {
  if (runs.length === 1) return runs[0];
  const distance = round1(runs.reduce((s, r) => s + (r.distance || 0), 0));
  const movingTime = runs.reduce((s, r) => s + (r.moving_time || 0), 0);
  const hrRuns = runs.filter((r) => r.average_heartrate != null && r.moving_time);
  const hrWeight = hrRuns.reduce((s, r) => s + r.moving_time, 0);
  const maxHrs = runs.map((r) => r.max_heartrate).filter((v) => v != null);
  const elevs = runs.map((r) => r.elevation_gain_ft).filter((v) => v != null);
  return {
    // Same composite-id formula the client uses, so an id-keyed note still matches.
    id: runs.map((r) => r.id).sort().join('-'),
    date: runs[0].date,
    distance,
    moving_time: movingTime,
    avg_pace: formatPace(distance > 0 ? movingTime / distance : null),
    average_heartrate: hrWeight > 0
      ? Math.round(hrRuns.reduce((s, r) => s + r.average_heartrate * r.moving_time, 0) / hrWeight)
      : null,
    max_heartrate: maxHrs.length ? Math.max(...maxHrs) : null,
    elevation_gain_ft: elevs.length ? elevs.reduce((s, v) => s + v, 0) : null,
    name: runs.map((r) => r.name).filter(Boolean).join(' + '),
  };
}

function activitiesByDate(activities) {
  const runsByDate = new Map();
  activities.forEach((a) => {
    const runs = runsByDate.get(a.date);
    if (runs) runs.push(a); else runsByDate.set(a.date, [a]);
  });
  const map = new Map();
  runsByDate.forEach((runs, date) => map.set(date, combineDayRuns(runs)));
  return map;
}

function formatDayLine(day, activity, note) {
  const planned = day.miles
    ? `${day.miles}mi planned @ ${day.pace || 'n/a'}, target HR ${day.hr || 'n/a'}`
    : 'Rest planned';
  const noteBit = note ? ` Runner's note on this day: ${note}` : '';
  if (!activity) {
    return `${day.dow} ${day.date}: ${planned}. Actual: none logged.${noteBit}`;
  }
  const hrBits = [];
  if (activity.average_heartrate) hrBits.push(`avg HR ${activity.average_heartrate}`);
  if (activity.max_heartrate) hrBits.push(`max HR ${activity.max_heartrate}`);
  const elev = activity.elevation_gain_ft ? `, ${activity.elevation_gain_ft}ft gain` : '';
  return `${day.dow} ${day.date}: ${planned}. Actual: ${activity.distance}mi @ ${activity.avg_pace || 'n/a'}/mi${hrBits.length ? `, ${hrBits.join(', ')}` : ''}${elev}.${noteBit}`;
}

function formatFullDayLine(day) {
  if (!day.miles) return `${day.dow} ${day.date}: Rest.`;
  return `${day.dow} ${day.date}: ${day.type} (${day.kind}), ${day.miles}mi, pace ${day.pace || 'n/a'}, HR ${day.hr || 'n/a'}. ${day.focus || ''}`.trim();
}

function weekOneLiner(week) {
  const longRun = week.days.find((d) => d.kind === 'long');
  const label = week.label ? ` — ${week.label}` : '';
  const longBit = longRun ? `, long run ${longRun.miles}mi` : '';
  return `Week ${week.week} (${week.phase}): ${week.totalMiles}mi planned${longBit}${label}.`;
}

// Reads a completed week's actual mileage total from cache; only falls back
// to a Strava fetch when that week hasn't been cached yet.
async function getWeekActualTotal(plan, weekNumber, accessToken) {
  const cached = await redis.get(actualsKey(weekNumber));
  if (cached && typeof cached.actualMiles === 'number') return cached;

  const wk = getWeekByNumber(plan, weekNumber);
  const after = Math.floor(wk.startEpochMs / 1000) - 1;
  const before = Math.floor(wk.endEpochMs / 1000) + 1;
  const activities = await fetchActivitiesInRange(accessToken, after, before);
  const actualMiles = round1(activities.reduce((sum, a) => sum + a.distance, 0));
  const result = { weekNumber, phase: wk.phase, plannedMiles: wk.totalMiles, actualMiles };
  await redis.set(actualsKey(weekNumber), result);
  return result;
}

function buildUserMessage({ wk, dayLines, seasonTable, remainingOneLiners, nextWeekLines, isRaceWeek }) {
  const parts = [
    `This Week: Week ${wk.weekNumber} (${wk.phase})${wk.label ? ` — ${wk.label}` : ''}, ${wk.totalMiles}mi planned.`,
    dayLines.join('\n'),
    '',
    'Season-to-date, planned vs. actual mileage by week (computed - trust these numbers exactly):',
    seasonTable.map((r) => `Week ${r.weekNumber} (${r.phase}): planned ${r.plannedMiles}mi, actual ${r.actualMiles}mi`).join('\n'),
  ];

  if (isRaceWeek) {
    parts.push('', 'This is the final week of the plan - race week. There is no schedule beyond this.');
  } else {
    parts.push('', 'Remaining schedule (compact):', remainingOneLiners.join('\n'));
    if (nextWeekLines) {
      parts.push('', 'Next week in full detail:', nextWeekLines.join('\n'));
    }
  }

  parts.push('', 'Write the weekly review now.');
  return parts.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const weekNumber = Number(req.query?.week);

  let plan;
  try {
    plan = await fetchPlan();
  } catch (err) {
    console.error('weekly-review: failed to load plan:', err);
    res.status(500).json({ error: 'plan_unavailable' });
    return;
  }

  const totalWeeks = plan.meta.weeks;
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > totalWeeks) {
    res.status(400).json({ error: 'invalid_week' });
    return;
  }

  const wk = getWeekByNumber(plan, weekNumber);
  if (!wk) {
    res.status(400).json({ error: 'invalid_week' });
    return;
  }

  if (!isWeekReviewAvailableEastern(plan, weekNumber)) {
    res.status(400).json({ error: 'not_yet_available' });
    return;
  }

  try {
    const cached = await redis.get(reviewKey(weekNumber));
    if (cached) {
      res.status(200).json({ ...cached, cached: true });
      return;
    }
  } catch (err) {
    console.error('weekly-review: redis read failed:', err);
  }

  let accessToken;
  try {
    accessToken = await getValidAccessToken();
  } catch {
    res.status(503).json({ error: 'strava_not_connected' });
    return;
  }

  let thisWeekActivities;
  try {
    const after = Math.floor(wk.startEpochMs / 1000) - 1;
    const before = Math.floor(wk.endEpochMs / 1000) + 1;
    thisWeekActivities = await fetchActivitiesInRange(accessToken, after, before);
  } catch (err) {
    console.error('weekly-review: Strava fetch failed:', err);
    res.status(502).json({ error: 'strava_fetch_failed' });
    return;
  }

  const byDate = activitiesByDate(thisWeekActivities);
  const notes = await fetchNoteLookups();
  const dayLines = wk.days.map((d) => {
    const activity = byDate.get(d.dateIso) || null;
    return formatDayLine(d, activity, noteForDay(notes, d.dateIso, activity));
  });
  const actualMilesThisWeek = round1(thisWeekActivities.reduce((sum, a) => sum + a.distance, 0));

  const thisWeekActuals = { weekNumber, phase: wk.phase, plannedMiles: wk.totalMiles, actualMiles: actualMilesThisWeek };
  try {
    await redis.set(actualsKey(weekNumber), thisWeekActuals);
  } catch (err) {
    console.error('weekly-review: failed to cache weekly actuals:', err);
  }

  const seasonTable = [];
  try {
    for (let k = 1; k < weekNumber; k++) {
      seasonTable.push(await getWeekActualTotal(plan, k, accessToken));
    }
  } catch (err) {
    console.error('weekly-review: failed to backfill season-to-date actuals:', err);
    res.status(502).json({ error: 'strava_fetch_failed' });
    return;
  }
  seasonTable.push(thisWeekActuals);

  const isRaceWeek = weekNumber === totalWeeks;
  const remainingOneLiners = isRaceWeek
    ? []
    : plan.weeks.filter((w) => w.week > weekNumber).map(weekOneLiner);
  const nextWeekPlan = isRaceWeek ? null : getWeekByNumber(plan, weekNumber + 1);
  const nextWeekLines = nextWeekPlan ? nextWeekPlan.days.map(formatFullDayLine) : null;

  const userMessage = buildUserMessage({ wk, dayLines, seasonTable, remainingOneLiners, nextWeekLines, isRaceWeek });

  let reviewText;
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: COACH_SYSTEM_PROMPT + '\n\n' + WEEKLY_REVIEW_PROMPT_ADDENDUM,
      messages: [{ role: 'user', content: userMessage }],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    reviewText = textBlock ? textBlock.text.trim() : '';
    if (!reviewText) throw new Error('empty response from Anthropic');
  } catch (err) {
    console.error('weekly-review: Anthropic call failed:', err);
    res.status(502).json({ error: 'generation_failed' });
    return;
  }

  const record = {
    review: reviewText,
    weekNumber,
    plannedMiles: wk.totalMiles,
    actualMiles: actualMilesThisWeek,
    generatedAt: new Date().toISOString(),
  };

  try {
    await redis.set(reviewKey(weekNumber), record);
  } catch (err) {
    console.error('weekly-review: failed to cache review:', err);
  }

  res.status(200).json({ ...record, cached: false });
}
