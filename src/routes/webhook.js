const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { getLineItemsForDeal } = require('../services/hubspot');
const { decrementStock } = require('../services/stock');
require('dotenv').config();

const router = express.Router();

const CLOSED_WON_STAGES = new Set([
  'closedwon',
  'closed won',
  'closedWon',
]);

function validateHubSpotSignature(req) {
  const signature = req.headers['x-hubspot-signature'];
  if (!signature) return false;

  const body = JSON.stringify(req.body);
  const hash = crypto
    .createHash('sha256')
    .update(process.env.HUBSPOT_CLIENT_SECRET + body)
    .digest('hex');

  return hash === signature;
}

// POST /webhook/deal-won
router.post('/deal-won', async (req, res) => {
  // Validate signature
  if (!validateHubSpotSignature(req)) {
    console.warn('[webhook] Invalid HubSpot signature — rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // HubSpot sends an array of events
  const events = Array.isArray(req.body) ? req.body : [req.body];

  // Respond immediately to HubSpot (must be fast)
  res.status(200).json({ received: true });

  // Process asynchronously
  for (const event of events) {
    try {
      await processEvent(event);
    } catch (err) {
      console.error('[webhook] processEvent error:', err);
    }
  }
});

async function processEvent(event) {
  const { subscriptionType, portalId, objectId, propertyName, propertyValue } = event;

  // Only process dealstage changes
  if (subscriptionType !== 'deal.propertyChange' || propertyName !== 'dealstage') {
    return;
  }

  const stage = (propertyValue || '').toLowerCase().replace(/\s+/g, '');
  if (!CLOSED_WON_STAGES.has(stage) && stage !== 'closedwon') {
    return;
  }

  const portalIdStr = String(portalId);
  const dealId = String(objectId);

  // Check portal is installed
  const portalResult = await db.execute({
    sql: 'SELECT portal_id FROM portals WHERE portal_id = ?',
    args: [portalIdStr],
  });
  if (portalResult.rows.length === 0) {
    console.warn(`[webhook] Portal ${portalIdStr} not found — skipping deal ${dealId}`);
    return;
  }

  console.log(`[webhook] Deal ${dealId} closed won — decrementing stock for portal ${portalIdStr}`);

  let lineItems;
  try {
    lineItems = await getLineItemsForDeal(portalIdStr, dealId);
  } catch (err) {
    console.error(`[webhook] Failed to fetch line items for deal ${dealId}:`, err.message);
    return;
  }

  for (const item of lineItems) {
    const props = item.properties || {};
    const hsProductId = props.hs_product_id;
    const qty = parseInt(props.quantity, 10);

    if (!hsProductId || isNaN(qty) || qty <= 0) {
      continue;
    }

    await decrementStock(portalIdStr, hsProductId, qty, dealId);
  }

  console.log(`[webhook] Done processing deal ${dealId} — ${lineItems.length} line items`);
}

module.exports = router;
