## Shorthand commands

- "MPR" in a request means: merge the pull request automatically once it's ready (checks pass, no conflicts). Do not stop to ask for confirmation before merging when the user includes MPR.

## Repo context

This repo hosts a marathon training PWA (index.html + plan-full.json) deployed to Vercel. Merges to main trigger an automatic Vercel production deploy.

`/api` holds Vercel serverless functions. `/api/strava/*` implements the Strava OAuth connect flow (authorize/callback/status/disconnect), backed by Upstash Redis via `/lib/strava-tokens.js`. `/api/strava/weekly-mileage` reads the current week's actual vs. planned mileage (current week resolved from plan-full.json's per-day dates via `/lib/plan-week.js`, in Eastern time). Full webhook subscription + activity ingestion is planned next and not yet built.
