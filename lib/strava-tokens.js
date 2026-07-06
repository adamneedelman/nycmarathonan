import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const TOKEN_KEY = 'strava:tokens';
const REFRESH_MARGIN_SECONDS = 5 * 60;

export async function getStoredTokens() {
  return redis.get(TOKEN_KEY);
}

export async function saveTokens(tokens) {
  await redis.set(TOKEN_KEY, tokens);
}

export async function clearTokens() {
  await redis.del(TOKEN_KEY);
}

async function refreshTokens(refreshToken) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Strava token refresh failed: ${res.status}`);
  }
  return res.json();
}

// Returns a valid access token, refreshing against Strava first if the
// current one is expired or within REFRESH_MARGIN_SECONDS of expiring.
export async function getValidAccessToken() {
  const tokens = await getStoredTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('Strava is not connected');
  }

  const now = Math.floor(Date.now() / 1000);
  if (tokens.expires_at - now > REFRESH_MARGIN_SECONDS) {
    return tokens.access_token;
  }

  const refreshed = await refreshTokens(tokens.refresh_token);
  const updated = {
    ...tokens,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    expires_at: refreshed.expires_at,
  };
  await saveTokens(updated);
  return updated.access_token;
}
