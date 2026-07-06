import { saveTokens } from '../../lib/strava-tokens.js';

const STATE_COOKIE = 'strava_oauth_state';

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function clearStateCookie(res) {
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function redirect(res, path) {
  res.writeHead(302, { Location: path });
  res.end();
}

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    clearStateCookie(res);
    redirect(res, `/?strava_error=${encodeURIComponent(error)}`);
    return;
  }

  const cookies = req.cookies || parseCookies(req.headers.cookie);
  const expectedState = cookies[STATE_COOKIE];
  clearStateCookie(res);

  if (!state || !expectedState || state !== expectedState) {
    redirect(res, `/?strava_error=${encodeURIComponent('invalid_state')}`);
    return;
  }

  if (!code) {
    redirect(res, `/?strava_error=${encodeURIComponent('missing_code')}`);
    return;
  }

  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`token exchange failed: ${tokenRes.status}`);
    }

    const data = await tokenRes.json();
    await saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      athlete_id: data.athlete?.id ?? null,
      athlete_firstname: data.athlete?.firstname ?? null,
    });

    redirect(res, '/?strava=connected');
  } catch (err) {
    console.error('Strava callback error:', err);
    redirect(res, `/?strava_error=${encodeURIComponent('token_exchange_failed')}`);
  }
}
