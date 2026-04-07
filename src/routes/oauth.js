const express = require('express');
const axios = require('axios');
const { db } = require('../db');
require('dotenv').config();

const router = express.Router();

const SCOPES = [
  'crm.objects.deals.read',
  'crm.objects.line_items.read',
  'crm.objects.products.read',
  'crm.schemas.deals.read',
  'oauth',
].join(' ');

const TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const AUTH_URL = 'https://app.hubspot.com/oauth/authorize';

// GET /oauth/install
router.get('/install', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.HUBSPOT_CLIENT_ID,
    redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
    scope: SCOPES,
  });
  res.redirect(`${AUTH_URL}?${params.toString()}`);
});

// GET /oauth/callback
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing authorization code');
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.HUBSPOT_CLIENT_ID,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: process.env.HUBSPOT_REDIRECT_URI,
      code,
    });

    const tokenRes = await axios.post(TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in, hub_id } = tokenRes.data;
    const portalId = String(hub_id);
    const now = Date.now();
    const token_expires = now + expires_in * 1000;

    await db.execute({
      sql: `INSERT INTO portals (portal_id, access_token, refresh_token, token_expires, installed_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(portal_id) DO UPDATE SET
              access_token = excluded.access_token,
              refresh_token = excluded.refresh_token,
              token_expires = excluded.token_expires`,
      args: [portalId, access_token, refresh_token, token_expires, now],
    });

    // Check if this portal already has an account
    const existingAccount = await db.execute({
      sql: 'SELECT id FROM accounts WHERE portal_id = ?',
      args: [portalId],
    });

    if (existingAccount.rows.length > 0) {
      // Returning install — go straight to dashboard
      console.log(`[oauth] Portal ${portalId} reinstalled — existing account found`);
      res.redirect(`/admin/products?portal_id=${portalId}`);
    } else {
      // New install — send to signup to create account
      console.log(`[oauth] Portal ${portalId} new install — redirecting to signup`);
      res.redirect(`/account/signup?portal_id=${portalId}`);
    }
  } catch (err) {
    console.error('[oauth] callback error:', err.response?.data || err.message);
    res.status(500).send('OAuth error — check server logs');
  }
});

module.exports = router;
