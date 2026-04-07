const express = require('express');
const axios = require('axios');
const { db } = require('../db');

const router = express.Router();

const SLACK_AUTH_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

// GET /slack/connect?portal_id=xxx — redirect user to Slack OAuth
router.get('/connect', (req, res) => {
  const portalId = req.query.portal_id;
  if (!portalId) return res.status(400).send('Missing portal_id');

  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) return res.status(500).send('Slack integration not configured on this server.');

  const redirectUri = `${process.env.BASE_URL}/slack/callback`;
  const state = Buffer.from(JSON.stringify({ portalId })).toString('base64');

  const url = new URL(SLACK_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'incoming-webhook');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);

  res.redirect(url.toString());
});

// GET /slack/callback — Slack redirects here after user approves
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/admin/settings?error=slack_denied`);
  }

  let portalId;
  try {
    portalId = JSON.parse(Buffer.from(state, 'base64').toString()).portalId;
  } catch {
    return res.status(400).send('Invalid state');
  }

  try {
    const response = await axios.post(
      SLACK_TOKEN_URL,
      new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: `${process.env.BASE_URL}/slack/callback`,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const data = response.data;
    if (!data.ok) throw new Error(data.error);

    const webhookUrl = data.incoming_webhook?.url;
    const channelName = data.incoming_webhook?.channel || 'unknown';

    await db.execute({
      sql: `INSERT INTO portal_settings (portal_id, trigger_stages, updated_at, slack_webhook_url, slack_channel_name, slack_enabled)
            VALUES (?, '[]', ?, ?, ?, 1)
            ON CONFLICT(portal_id) DO UPDATE SET
              slack_webhook_url = excluded.slack_webhook_url,
              slack_channel_name = excluded.slack_channel_name,
              slack_enabled = 1,
              updated_at = excluded.updated_at`,
      args: [portalId, Date.now(), webhookUrl, channelName],
    });

    console.log(`[slack] Connected portal ${portalId} to channel ${channelName}`);
    res.redirect(`/admin/settings?portal_id=${portalId}&slack=connected`);
  } catch (err) {
    console.error('[slack] OAuth callback error:', err.message);
    res.redirect(`/admin/settings?portal_id=${portalId}&slack=error`);
  }
});

// POST /slack/disconnect — remove Slack connection for a portal
router.post('/disconnect', async (req, res) => {
  const portalId = req.query.portal_id || req.body.portal_id;
  if (!portalId) return res.status(400).json({ error: 'Missing portal_id' });

  await db.execute({
    sql: `UPDATE portal_settings SET slack_webhook_url = NULL, slack_channel_name = NULL, slack_enabled = 0, updated_at = ? WHERE portal_id = ?`,
    args: [Date.now(), portalId],
  });

  res.json({ ok: true });
});

module.exports = router;
