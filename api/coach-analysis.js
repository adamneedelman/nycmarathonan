import { Redis } from '@upstash/redis';
import Anthropic from '@anthropic-ai/sdk';
import { COACH_SYSTEM_PROMPT } from '../lib/coach-prompt.js';

const redis = Redis.fromEnv();
const MODEL = 'claude-sonnet-4-6';

function cacheKey(activityId) {
  return `coach:blurb:${activityId}`;
}

function buildUserMessage(activity, plannedWorkout) {
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
    `Actual run: ${activity.distance} mi, avg pace ${activity.avg_pace || 'n/a'}/mi${hrBits.length ? `, ${hrBits.join(', ')}` : ''}. Strava activity name: "${activity.name || ''}".`
  );
  lines.push('Give your coaching take on this run.');
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const { activityId, activity, plannedWorkout } = req.body || {};
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
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: COACH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(activity, plannedWorkout) }],
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
