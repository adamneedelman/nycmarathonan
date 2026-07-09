## Shorthand commands

- "MPR" in a request means: merge the pull request automatically once it's ready (checks pass, no conflicts). Do not stop to ask for confirmation before merging when the user includes MPR.

## Repo context

This repo hosts a marathon training PWA (index.html + plan-full.json) deployed to Vercel. Merges to main trigger an automatic Vercel production deploy.

`/api` holds Vercel serverless functions. `/api/strava/*` implements the Strava OAuth connect flow (authorize/callback/status/disconnect), backed by Upstash Redis via `/lib/strava-tokens.js`. `/api/strava/weekly-mileage` reads the current week's actual vs. planned mileage (current week resolved from plan-full.json's per-day dates via `/lib/plan-week.js`, in Eastern time). Full webhook subscription + activity ingestion is planned next and not yet built.

### Coach Claude Weekly Review

`/api/coach/weekly-review.js` (`GET ?week=N`) generates a holistic Sunday-evening training review for week N: plan vs. actual for the week, a season-to-date planned/actual mileage table, a look at the schedule ahead, and a marathon pace projection. It's lazy-generated with no cron job: a review is only produced the first time someone opens week N's page, and only once week N's Sunday has passed 6pm US Eastern (server-side sanity check backing the client's own 5pm-local-time availability check). The coach system prompt plus a weekly-review-specific addendum both live in `/lib/coach-prompt.js`.

Redis keys: `weekly-review:week-{N}` caches the generated review (immutable once written — the endpoint always checks this first and returns it if present, never regenerating). `weekly-actuals:week-{N}` caches each completed week's planned/actual mileage total so the season-to-date table doesn't require re-fetching Strava history on every later week's generation; only weeks missing from this cache trigger a Strava fetch.

The UI adds an inbox icon (upper-right header) with a red unread badge, opening a "Coach's Notes" list/detail view within `index.html`. Badge/unread state is tracked client-side via the `coachReviewLastRead` localStorage key (the last week number opened) — no server-side read tracking.
