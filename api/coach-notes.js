import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const NOTES_KEY = 'coach:notes:v1';

function blurbCacheKey(activityId) {
  return `coach:blurb:v3:${activityId}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const notes = (await redis.get(NOTES_KEY)) || {};
      res.status(200).json({ notes });
    } catch (err) {
      console.error('coach-notes: redis read failed:', err);
      res.status(200).json({ notes: {} });
    }
    return;
  }

  if (req.method === 'POST') {
    const { activityId, note } = req.body || {};
    if (!activityId) {
      res.status(400).json({ error: 'missing_activity_id' });
      return;
    }
    try {
      const notes = (await redis.get(NOTES_KEY)) || {};
      const trimmed = typeof note === 'string' ? note.trim() : '';
      if (trimmed) {
        notes[activityId] = trimmed;
      } else {
        delete notes[activityId];
      }
      await redis.set(NOTES_KEY, notes);
      // A note changes what Coach Claude should say about this run, so drop
      // any previously cached blurb for it and let the next view regenerate.
      await redis.del(blurbCacheKey(activityId));
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('coach-notes: redis write failed:', err);
      res.status(500).json({ error: 'write_failed' });
    }
    return;
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
