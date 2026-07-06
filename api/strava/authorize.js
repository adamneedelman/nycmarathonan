import crypto from 'node:crypto';

const STATE_COOKIE = 'strava_oauth_state';

export default function handler(req, res) {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = process.env.STRAVA_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    res.status(500).send('Strava is not configured: missing STRAVA_CLIENT_ID or STRAVA_REDIRECT_URI.');
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader(
    'Set-Cookie',
    `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:read_all',
    state,
  });

  res.writeHead(302, { Location: `https://www.strava.com/oauth/authorize?${params.toString()}` });
  res.end();
}
