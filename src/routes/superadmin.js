const express = require('express');
const { db } = require('../db');
const { requireSuperAdmin } = require('../middleware/accountAuth');
const path = require('path');

const router = express.Router();
const PAGES = path.join(__dirname, '../../admin');

// GET /superadmin/login
router.get('/login', (req, res) => {
  if (req.session?.isSuperAdmin) return res.redirect('/superadmin');
  res.sendFile(path.join(PAGES, 'superadmin-login.html'));
});

// POST /superadmin/login
router.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.SUPERADMIN_PASSWORD;
  if (!adminPassword) return res.redirect('/superadmin/login?error=not_configured');
  if (password !== adminPassword) return res.redirect('/superadmin/login?error=invalid');
  req.session.isSuperAdmin = true;
  req.session.save((err) => {
    if (err) return res.redirect('/superadmin/login?error=session');
    res.redirect('/superadmin');
  });
});

// POST /superadmin/logout
router.post('/logout', (req, res) => {
  req.session.isSuperAdmin = false;
  res.json({ ok: true });
});

// GET /superadmin — dashboard page
router.get('/', requireSuperAdmin, (req, res) => {
  res.sendFile(path.join(PAGES, 'superadmin.html'));
});

// GET /superadmin/api/accounts — list all accounts with usage
router.get('/api/accounts', requireSuperAdmin, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT
        a.id,
        a.email,
        a.name,
        a.portal_id,
        a.plan,
        a.trial_ends_at,
        a.paypal_subscription_id,
        a.paypal_order_id,
        a.last_login_at,
        a.created_at,
        -- Usage score components
        (SELECT COUNT(*) FROM products p WHERE p.portal_id = a.portal_id) as product_count,
        (SELECT COUNT(*) FROM stock_movements sm WHERE sm.portal_id = a.portal_id AND sm.created_at > (strftime('%s','now') - 2592000) * 1000) as movements_30d,
        (SELECT COUNT(*) FROM reservations r WHERE r.portal_id = a.portal_id) as reservation_count,
        (SELECT COUNT(*) FROM portals po WHERE po.portal_id = a.portal_id) as portal_installed
      FROM accounts a
      ORDER BY a.created_at DESC
    `);

    const accounts = result.rows.map(a => ({
      ...a,
      usage_score: Math.round(
        (a.product_count || 0) * 1 +
        (a.movements_30d || 0) * 2 +
        (a.reservation_count || 0) * 1
      ),
    }));

    res.json(accounts);
  } catch (err) {
    console.error('[superadmin] list accounts:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /superadmin/api/accounts/:id — update plan or trial date
router.patch('/api/accounts/:id', requireSuperAdmin, async (req, res) => {
  const { plan, trial_ends_at } = req.body;
  const validPlans = ['trial', 'monthly', 'yearly', 'lifetime', 'cancelled'];

  if (plan && !validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  try {
    const sets = [];
    const args = [];

    if (plan) { sets.push('plan = ?'); args.push(plan); }
    if (trial_ends_at !== undefined) {
      sets.push('trial_ends_at = ?');
      args.push(trial_ends_at ? Number(trial_ends_at) : null);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    sets.push('updated_at = ?');
    args.push(Date.now());
    args.push(req.params.id);

    await db.execute({
      sql: `UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`,
      args,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /superadmin/api/stats — top-level numbers
router.get('/api/stats', requireSuperAdmin, async (req, res) => {
  try {
    const [accounts, active, trial, paid, portals] = await Promise.all([
      db.execute('SELECT COUNT(*) as n FROM accounts'),
      db.execute("SELECT COUNT(*) as n FROM accounts WHERE last_login_at > ?", [Date.now() - 7 * 86400000]),
      db.execute("SELECT COUNT(*) as n FROM accounts WHERE plan = 'trial'"),
      db.execute("SELECT COUNT(*) as n FROM accounts WHERE plan IN ('monthly','yearly','lifetime')"),
      db.execute('SELECT COUNT(*) as n FROM portals'),
    ]);

    res.json({
      total_accounts: accounts.rows[0].n,
      active_7d: active.rows[0].n,
      on_trial: trial.rows[0].n,
      paid: paid.rows[0].n,
      total_portals: portals.rows[0].n,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
