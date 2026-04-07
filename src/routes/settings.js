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
    res.json({
      triggerStages: row ? JSON.parse(row.trigger_stages) : [],
      reservationProbability: row?.reservation_probability ?? 80,
      alertEmailEnabled: !!(row?.alert_email_enabled),
      alertEmail: row?.alert_email || '',
      slackEnabled: !!(row?.slack_enabled),
      slackChannelName: row?.slack_channel_name || null,
      slackConfigured: !!process.env.SLACK_CLIENT_ID,
      resendConfigured: !!process.env.RESEND_API_KEY,
      stages,
    });
  } catch (err) {
    console.error('[settings] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/:portalId
router.post('/:portalId', requirePortal, async (req, res) => {
  const { triggerStages, reservationProbability, alertEmailEnabled, alertEmail } = req.body;

  if (!Array.isArray(triggerStages)) return res.status(400).json({ error: 'triggerStages must be an array' });

  const prob = reservationProbability !== undefined ? parseInt(reservationProbability, 10) : 80;
  if (isNaN(prob) || prob < 0 || prob > 100) return res.status(400).json({ error: 'reservationProbability must be 0–100' });

  const now = Date.now();
  try {
    await db.execute({
      sql: `INSERT INTO portal_settings (portal_id, trigger_stages, reservation_probability, alert_email_enabled, alert_email, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(portal_id) DO UPDATE SET
              trigger_stages = excluded.trigger_stages,
              reservation_probability = excluded.reservation_probability,
              alert_email_enabled = excluded.alert_email_enabled,
              alert_email = excluded.alert_email,
              updated_at = excluded.updated_at`,
      args: [req.portalId, JSON.stringify(triggerStages), prob, alertEmailEnabled ? 1 : 0, alertEmail || null, now],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/:portalId/slack-toggle — enable/disable Slack without disconnecting
router.post('/:portalId/slack-toggle', requirePortal, async (req, res) => {
  const { enabled } = req.body;
  await db.execute({
    sql: 'UPDATE portal_settings SET slack_enabled = ?, updated_at = ? WHERE portal_id = ?',
    args: [enabled ? 1 : 0, Date.now(), req.portalId],
  });
  res.json({ ok: true });
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
