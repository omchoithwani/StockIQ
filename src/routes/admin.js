const express = require('express');
const path = require('path');
const { db } = require('../db');

const router = express.Router();
const ADMIN_DIR = path.join(__dirname, '../../admin');

// Serve the shared plan-banner.js
router.get('/plan-banner.js', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'plan-banner.js'));
});

// Middleware: block expired trials from admin pages
async function checkPlan(req, res, next) {
  const portalId = req.query.portal_id;
  if (!portalId) return next();
  try {
    const result = await db.execute({
      sql: 'SELECT plan, trial_ends_at FROM accounts WHERE portal_id = ?',
      args: [portalId],
    });
    if (result.rows.length === 0) return next();
    const { plan, trial_ends_at } = result.rows[0];
    if (plan === 'trial' && trial_ends_at && Date.now() > trial_ends_at) {
      return res.redirect(`/account/billing?portal_id=${portalId}`);
    }
  } catch (_) {}
  next();
}

router.get('/products', checkPlan, (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'products.html'));
});

router.get('/restock', checkPlan, (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'restock.html'));
});

router.get('/movements', checkPlan, (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'movements.html'));
});

router.get('/settings', checkPlan, (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'settings.html'));
});

router.get('/reservations', checkPlan, (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'reservations.html'));
});

module.exports = router;
