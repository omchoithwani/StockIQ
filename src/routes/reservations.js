const express = require('express');
const { requirePortal } = require('../middleware/auth');
const { getAllReservations, getReservationsForDeal } = require('../services/reservations');

const router = express.Router();

// GET /api/reservations/:portalId — all active reservations for a portal
router.get('/:portalId', requirePortal, async (req, res) => {
  try {
    const reservations = await getAllReservations(req.portalId);
    res.json(reservations);
  } catch (err) {
    console.error('[reservations] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reservations/:portalId/deal/:dealId — reservations for a specific deal
router.get('/:portalId/deal/:dealId', requirePortal, async (req, res) => {
  try {
    const reservations = await getReservationsForDeal(req.portalId, req.params.dealId);
    res.json(reservations);
  } catch (err) {
    console.error('[reservations] GET deal error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
