## Shorthand commands

- "MPR" in a request means: merge the pull request automatically once it's ready (checks pass, no conflicts). Do not stop to ask for confirmation before merging when the user includes MPR.

## Repo context

This repo hosts a marathon training PWA (index.html + plan-full.json) deployed to Vercel. Merges to main trigger an automatic Vercel production deploy.

`/api` holds Vercel serverless functions. `/api/strava/*` implements the Strava OAuth connect flow (authorize/callback/status/disconnect), backed by Upstash Redis via `/lib/strava-tokens.js`. `/api/strava/weekly-mileage` reads the current week's actual vs. planned mileage (current week resolved from plan-full.json's per-day dates via `/lib/plan-week.js`, in Eastern time). Full webhook subscription + activity ingestion is planned next and not yet built.

### Coach Claude Weekly Review

`/api/coach/weekly-review.js` (`GET ?week=N`) generates a holistic Sunday-evening training review for week N: plan vs. actual for the week, a season-to-date planned/actual mileage table, a look at the schedule ahead, and a marathon pace projection. It's lazy-generated with no cron job: a review is only produced the first time someone opens week N's page, and only once week N's Sunday has passed 6pm US Eastern (server-side sanity check backing the client's own 5pm-local-time availability check). The coach system prompt plus a weekly-review-specific addendum both live in `/lib/coach-prompt.js`.

Redis keys: `weekly-review:week-{N}` caches the generated review — the endpoint always checks this first and returns it if present. It is stable rather than strictly immutable: saving or clearing a run note deletes the key for the week that run falls in, so the next open regenerates the review with the note included. `weekly-actuals:week-{N}` caches each completed week's planned/actual mileage total so the season-to-date table doesn't require re-fetching Strava history on every later week's generation; only weeks missing from this cache trigger a Strava fetch. A note never touches the actuals key, since mileage doesn't change.

Days with more than one logged run are combined (distance and time summed, pace recomputed from the total, HR weighted by moving time) by `combineDayRuns()` in both `/api/coach/weekly-review.js` and `index.html`, so the review's day lines add up to the weekly total it reports.

### Run notes

All Redis key builders and the notes record shape live in `/lib/coach-cache.js`; import them from there rather than re-declaring a key. The blurb key existed as two independent copies once — the writer was bumped to `v4` while the invalidator still deleted `v3`, so saving a note silently left the stale blurb in place and the feature looked dead.

`coach:notes:v1` maps activity id to `{ note, date }`. Bare-string values are the legacy shape and are still read (with a null date); `normalizeNotes()` handles both. The date matters because a day with two runs is keyed under a composite id (`"123-456"`) by the client and a single Strava id by the review — date is the only key both agree on, so the review matches notes by date and falls back to activity id.

Saving a note (`POST /api/coach-notes`) deletes `coach:blurb:v4:{activityId}` and the containing week's review, then the PWA immediately re-requests the day's blurb so the rewrite is visible without a reload.

The UI adds an inbox icon (upper-right header) with a red unread badge, opening a "Coach's Notes" list/detail view within `index.html`. Badge/unread state is tracked client-side via the `coachReviewLastRead` localStorage key (the last week number opened) — no server-side read tracking.
