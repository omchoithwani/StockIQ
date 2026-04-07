const express = require('express');
const { requirePortal } = require('../middleware/auth');
const { getDealPipelinesAndStages } = require('../services/hubspot');
const { sendTestAlert } = require('../services/alerts');
const { db } = require('../db');

const router = express.Router();

// GET /api/settings/:portalId
router.get('/:portalId', requirePortal, async (req, res) => {
  try {
    const [settingsResult, stages] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM portal_settings WHERE portal_id = ?', args: [req.portalId] }),
      getDealPipelinesAndStages(req.portalId),
    ]);

    const row = settingsResult.rows[0];
    const triggerStages = row ? JSON.parse(row.trigger_stages) : [];
    const reservationProbability = row ? (row.reservation_probability ?? 80) : 80;
    const alertEmail = row?.alert_email || '';
    const alertFromEmail = row?.alert_from_email || '';
    const resendApiKey = row?.resend_api_key ? '••••••••' : ''; // mask the key
    const slackWebhookUrl = row?.slack_webhook_url || '';

    res.json({ triggerStages, reservationProbability, alertEmail, alertFromEmail, resendApiKey, slackWebhookUrl, stages });
  } catch (err) {
    console.error('[settings] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/:portalId
router.post('/:portalId', requirePortal, async (req, res) => {
  const { triggerStages, reservationProbability, alertEmail, alertFromEmail, resendApiKey, slackWebhookUrl } = req.body;

  if (!Array.isArray(triggerStages)) {
    return res.status(400).json({ error: 'triggerStages must be an array' });
  }

  const prob = reservationProbability !== undefined ? parseInt(reservationProbability, 10) : 80;
  if (isNaN(prob) || prob < 0 || prob > 100) {
    return res.status(400).json({ error: 'reservationProbability must be 0–100' });
  }

  const now = Date.now();

  // Only update resend_api_key if a real value is sent (not the masked placeholder)
  const isNewApiKey = resendApiKey && !resendApiKey.includes('•');

  try {
    // Fetch existing to preserve api key if not changed
    const existing = await db.execute({ sql: 'SELECT resend_api_key FROM portal_settings WHERE portal_id = ?', args: [req.portalId] });
    const existingKey = existing.rows[0]?.resend_api_key || null;
    const finalApiKey = isNewApiKey ? resendApiKey : existingKey;

    await db.execute({
      sql: `INSERT INTO portal_settings
              (portal_id, trigger_stages, reservation_probability, alert_email, alert_from_email, resend_api_key, slack_webhook_url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(portal_id) DO UPDATE SET
              trigger_stages = excluded.trigger_stages,
              reservation_probability = excluded.reservation_probability,
              alert_email = excluded.alert_email,
              alert_from_email = excluded.alert_from_email,
              resend_api_key = excluded.resend_api_key,
              slack_webhook_url = excluded.slack_webhook_url,
              updated_at = excluded.updated_at`,
      args: [req.portalId, JSON.stringify(triggerStages), prob, alertEmail || null, alertFromEmail || null, finalApiKey, slackWebhookUrl || null, now],
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/:portalId/test-alerts
router.post('/:portalId/test-alerts', requirePortal, async (req, res) => {
  try {
    const results = await sendTestAlert(req.portalId);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
