const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { requireAccount } = require('../middleware/accountAuth');
const path = require('path');

const router = express.Router();
const PAGES = path.join(__dirname, '../../admin');

const TRIAL_DAYS = 14;

// GET /account/signup
router.get('/signup', (req, res) => {
  res.sendFile(path.join(PAGES, 'signup.html'));
});

// GET /account/login
router.get('/login', (req, res) => {
  if (req.session?.accountId) return res.redirect('/account/dashboard');
  res.sendFile(path.join(PAGES, 'login.html'));
});

// GET /account/billing
router.get('/billing', requireAccount, (req, res) => {
  res.sendFile(path.join(PAGES, 'billing.html'));
});

// GET /account/dashboard — redirect to the portal admin
router.get('/dashboard', requireAccount, async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT portal_id FROM accounts WHERE id = ?',
    args: [req.session.accountId],
  });
  const portalId = result.rows[0]?.portal_id;
  if (portalId) return res.redirect(`/admin/products?portal_id=${portalId}`);
  res.redirect('/account/billing');
});

// POST /account/signup
router.post('/signup', async (req, res) => {
  const { name, email, password, portal_id } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    // Check email not already taken
    const existing = await db.execute({
      sql: 'SELECT id FROM accounts WHERE email = ?',
      args: [email.toLowerCase().trim()],
    });
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const now = Date.now();
    const trialEndsAt = now + TRIAL_DAYS * 24 * 60 * 60 * 1000;
    const id = uuidv4();

    await db.execute({
      sql: `INSERT INTO accounts (id, email, password_hash, name, portal_id, plan, trial_ends_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'trial', ?, ?, ?)`,
      args: [id, email.toLowerCase().trim(), passwordHash, name.trim(), portal_id || null, trialEndsAt, now, now],
    });

    req.session.accountId = id;
    req.session.accountName = name.trim();
    res.json({ ok: true, redirect: portal_id ? `/admin/products?portal_id=${portal_id}` : '/account/billing' });
  } catch (err) {
    console.error('[account] signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// POST /account/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const result = await db.execute({
      sql: 'SELECT * FROM accounts WHERE email = ?',
      args: [email.toLowerCase().trim()],
    });

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const account = result.rows[0];
    const valid = await bcrypt.compare(password, account.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await db.execute({
      sql: 'UPDATE accounts SET last_login_at = ? WHERE id = ?',
      args: [Date.now(), account.id],
    });

    req.session.accountId = account.id;
    req.session.accountName = account.name;

    const redirect = account.portal_id
      ? `/admin/products?portal_id=${account.portal_id}`
      : '/account/billing';

    res.json({ ok: true, redirect });
  } catch (err) {
    console.error('[account] login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /account/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /account/config — public config for frontend (PayPal client ID etc.)
router.get('/config', (req, res) => {
  res.json({ paypalClientId: process.env.PAYPAL_CLIENT_ID || '' });
});

// GET /account/me — return current account info (for billing page)
router.get('/me', requireAccount, async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT id, email, name, portal_id, plan, trial_ends_at, created_at FROM accounts WHERE id = ?',
    args: [req.session.accountId],
  });
  if (result.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
  res.json(result.rows[0]);
});

// POST /account/billing/activate — called after PayPal payment success
router.post('/billing/activate', requireAccount, async (req, res) => {
  const { plan, paypal_order_id, paypal_subscription_id } = req.body;
  const validPlans = ['monthly', 'yearly', 'lifetime'];
  if (!validPlans.includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  try {
    await db.execute({
      sql: `UPDATE accounts SET plan = ?, paypal_order_id = ?, paypal_subscription_id = ?, trial_ends_at = NULL, updated_at = ? WHERE id = ?`,
      args: [plan, paypal_order_id || null, paypal_subscription_id || null, Date.now(), req.session.accountId],
    });
    res.json({ ok: true, plan });
  } catch (err) {
    console.error('[account] activate error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
