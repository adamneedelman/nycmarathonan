import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';
import { getValidAccessToken } from '../../lib/strava-tokens.js';
import { fetchPlan, getWeekByNumber, isWeekReviewAvailableEastern } from '../../lib/plan-week.js';
import { fetchActivitiesInRange, round1 } from '../../lib/strava-activities.js';
import { COACH_SYSTEM_PROMPT, WEEKLY_REVIEW_PROMPT_ADDENDUM } from '../../lib/coach-prompt.js';

const redis = Redis.fromEnv();
const MODEL = 'claude-sonnet-4-6';

function reviewKey(week) {
  return `weekly-review:week-${week}`;
}
function actualsKey(week) {
  return `weekly-actuals:week-${week}`;
}

// Longest logged run per calendar date (mirrors the frontend's matching rule
// for days with more than one recorded activity).
function activitiesByDate(activities) {
  const map = new Map();
  activities.forEach((a) => {
    const existing = map.get(a.date);
    if (!existing || a.distance > existing.distance) map.set(a.date, a);
  });
  return map;
}

function formatDayLine(day, activity) {
  const planned = day.miles
    ? `${day.miles}mi planned @ ${day.pace || 'n/a'}, target HR ${day.hr || 'n/a'}`
    : 'Rest planned';
  if (!activity) {
    return `${day.dow} ${day.date}: ${planned}. Actual: none logged.`;
  }
  const hrBits = [];
  if (activity.average_heartrate) hrBits.push(`avg HR ${activity.average_heartrate}`);
  if (activity.max_heartrate) hrBits.push(`max HR ${activity.max_heartrate}`);
  const elev = activity.elevation_gain_ft ? `, ${activity.elevation_gain_ft}ft gain` : '';
  return `${day.dow} ${day.date}: ${planned}. Actual: ${activity.distance}mi @ ${activity.avg_pace || 'n/a'}/mi${hrBits.length ? `, ${hrBits.join(', ')}` : ''}${elev}.`;
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
  const dayLines = wk.days.map((d) => formatDayLine(d, byDate.get(d.dateIso) || null));
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
