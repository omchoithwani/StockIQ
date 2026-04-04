const { db } = require('../db');

/**
 * Middleware that validates the portal_id param exists in our DB.
 * Attach it to any route that uses :portalId.
 */
async function requirePortal(req, res, next) {
  const portalId = req.params.portalId || req.query.portal_id;
  if (!portalId) {
    return res.status(400).json({ error: 'portal_id is required' });
  }

  try {
    const result = await db.execute({
      sql: 'SELECT portal_id FROM portals WHERE portal_id = ?',
      args: [portalId],
    });

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Portal not installed or not found' });
    }

    req.portalId = portalId;
    next();
  } catch (err) {
    console.error('[auth] requirePortal error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { requirePortal };
