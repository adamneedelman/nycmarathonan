import { Redis } from '@upstash/redis';
import { NOTES_KEY, blurbCacheKey, weeklyReviewKey, normalizeNotes, notesTextMap } from '../lib/coach-cache.js';
import { fetchPlan, resolveWeekForIsoDate } from '../lib/plan-week.js';

const redis = Redis.fromEnv();

// A saved note changes what Coach Claude should say about the run *and* about
// the week it sits in, so both cached pieces are dropped here. The day's blurb
// is regenerated as soon as the runner is looking at it; the week's review is
// regenerated the next time that week is opened.
async function invalidateWeeklyReview(activityDate) {
  if (!activityDate) return { reset: false, weekNumber: null };
  try {
    const plan = await fetchPlan();
    const weekNumber = resolveWeekForIsoDate(plan, activityDate);
    if (!weekNumber) return { reset: false, weekNumber: null };
    await redis.del(weeklyReviewKey(weekNumber));
    return { reset: true, weekNumber };
  } catch (err) {
    // The note itself is already saved; a failure here only means the week's
    // review keeps its existing text, so don't fail the request over it.
    console.error('coach-notes: weekly review invalidation failed:', err);
    return { reset: false, weekNumber: null };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const raw = (await redis.get(NOTES_KEY)) || {};
      res.status(200).json({ notes: notesTextMap(raw) });
    } catch (err) {
      console.error('coach-notes: redis read failed:', err);
      res.status(200).json({ notes: {} });
    }
    return;
  }

  if (req.method === 'POST') {
    const { activityId, note, activityDate } = req.body || {};
    if (!activityId) {
      res.status(400).json({ error: 'missing_activity_id' });
      return;
    }
    try {
      const notes = normalizeNotes((await redis.get(NOTES_KEY)) || {});
      const trimmed = typeof note === 'string' ? note.trim() : '';
      // Keep the date already on record if this save didn't carry one.
      const knownDate = notes[activityId] ? notes[activityId].date : null;
      if (trimmed) {
        notes[activityId] = { note: trimmed, date: activityDate || knownDate || null };
      } else {
        delete notes[activityId];
      }
      await redis.set(NOTES_KEY, notes);
      await redis.del(blurbCacheKey(activityId));
      const weekly = await invalidateWeeklyReview(activityDate || knownDate);
      res.status(200).json({
        ok: true,
        blurbReset: true,
        weeklyReviewReset: weekly.reset,
        weekNumber: weekly.weekNumber,
      });
    } catch (err) {
      console.error('coach-notes: redis write failed:', err);
      res.status(500).json({ error: 'write_failed' });
    }
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
