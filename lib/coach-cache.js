// Shared Redis key builders and the notes record shape for Coach Claude.
//
// These live in one place because the blurb cache key previously existed as
// two independent copies - the writer bumped it to v4 while the invalidator
// still deleted v3, so saving a note silently left the old blurb in place.
// Every endpoint that touches these keys imports them from here.

export const NOTES_KEY = 'coach:notes:v1';

export function blurbCacheKey(activityId) {
  return `coach:blurb:v4:${activityId}`;
}

export function weeklyReviewKey(week) {
  return `weekly-review:week-${week}`;
}

export function weeklyActualsKey(week) {
  return `weekly-actuals:week-${week}`;
}

// Notes were originally stored as bare strings keyed by activity id. They now
// carry the run's date too, which the weekly review needs: on days with more
// than one logged run the client keys the note under a composite id
// ("123-456"), while the review collapses the day to a single Strava activity
// whose raw id would never match. Date is the one key both sides agree on.
//
// Legacy string entries stay readable and simply have a null date.
export function normalizeNotes(raw) {
  const out = {};
  Object.entries(raw || {}).forEach(([activityId, value]) => {
    if (typeof value === 'string') {
      const note = value.trim();
      if (note) out[activityId] = { note, date: null };
    } else if (value && typeof value.note === 'string') {
      const note = value.note.trim();
      if (note) out[activityId] = { note, date: value.date || null };
    }
  });
  return out;
}

// Flat { activityId: "note text" } view, which is all the PWA needs.
export function notesTextMap(raw) {
  const out = {};
  Object.entries(normalizeNotes(raw)).forEach(([activityId, rec]) => {
    out[activityId] = rec.note;
  });
  return out;
}

// Lookups for the weekly review: by run date (preferred) and by activity id
// (the fallback that keeps pre-existing notes working).
export function noteLookups(raw) {
  const normalized = normalizeNotes(raw);
  const byDate = new Map();
  const byActivityId = new Map();
  Object.entries(normalized).forEach(([activityId, rec]) => {
    byActivityId.set(String(activityId), rec.note);
    if (rec.date) byDate.set(rec.date, rec.note);
  });
  return { byDate, byActivityId };
}
