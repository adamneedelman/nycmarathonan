## Shorthand commands

- "MPR" in a request means: merge the pull request automatically once it's ready (checks pass, no conflicts). Do not stop to ask for confirmation before merging when the user includes MPR.

## Repo context

This repo hosts a marathon training PWA (index.html + plan-full.json) deployed to Vercel. Merges to main trigger an automatic Vercel production deploy.

`/api` holds Vercel serverless functions. `/api/strava/*` implements the Strava OAuth connect flow (authorize/callback/status/disconnect), backed by Vercel KV via `/lib/strava-tokens.js`. Phase 2 (webhook subscription + activity ingestion) is planned next and not yet built.
