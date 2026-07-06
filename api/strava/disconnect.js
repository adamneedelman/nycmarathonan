import { getStoredTokens, clearTokens } from '../../lib/strava-tokens.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  try {
    const tokens = await getStoredTokens();
    if (tokens?.access_token) {
      try {
        await fetch('https://www.strava.com/oauth/deauthorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ access_token: tokens.access_token }).toString(),
        });
      } catch (revokeErr) {
        // Token may already be invalid on Strava's side; local tokens are
        // cleared below regardless so the app doesn't get stuck "connected".
        console.error('Strava deauthorize request failed:', revokeErr);
      }
    }
    await clearTokens();
    res.status(200).json({ connected: false });
  } catch (err) {
    console.error('Strava disconnect error:', err);
    res.status(500).json({ error: 'disconnect_failed' });
  }
}
