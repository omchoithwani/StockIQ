const express = require('express');
const { requirePortal } = require('../middleware/auth');
const { getDealPipelinesAndStages } = require('../services/hubspot');
const { db } = require('../db');

const router = express.Router();

// GET /api/settings/:portalId — return current settings + all pipeline stages
router.get('/:portalId', requirePortal, async (req, res) => {
  try {
    const [settingsResult, stages] = await Promise.all([
      db.execute({
        sql: 'SELECT * FROM portal_settings WHERE portal_id = ?',
        args: [req.portalId],
      }),
      getDealPipelinesAndStages(req.portalId),
    ]);

    const row = settingsResult.rows[0];
    const triggerStages = row ? JSON.parse(row.trigger_stages) : [];

    res.json({ triggerStages, stages });
  } catch (err) {
    console.error('[settings] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/:portalId — save trigger stages
router.post('/:portalId', requirePortal, async (req, res) => {
  const { triggerStages } = req.body;
  if (!Array.isArray(triggerStages)) {
    return res.status(400).json({ error: 'triggerStages must be an array' });
  }

  const now = Date.now();
  try {
    await db.execute({
      sql: `INSERT INTO portal_settings (portal_id, trigger_stages, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(portal_id) DO UPDATE SET
              trigger_stages = excluded.trigger_stages,
              updated_at = excluded.updated_at`,
      args: [req.portalId, JSON.stringify(triggerStages), now],
    });
    res.json({ ok: true, triggerStages });
  } catch (err) {
    console.error('[settings] POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
