import { getStoredTokens } from '../../lib/strava-tokens.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const tokens = await getStoredTokens();
    if (!tokens || !tokens.access_token) {
      res.status(200).json({ connected: false });
      return;
    }
    res.status(200).json({
      connected: true,
      athlete_id: tokens.athlete_id ?? null,
      athlete_firstname: tokens.athlete_firstname ?? null,
    });
  } catch (err) {
    console.error('Strava status error:', err);
    res.status(500).json({ connected: false, error: 'status_check_failed' });
  }
}
