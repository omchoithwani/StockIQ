const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { getLineItemsForDeal } = require('../services/hubspot');
const { decrementStock } = require('../services/stock');
require('dotenv').config();

const router = express.Router();

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

/**
 * Returns the set of trigger stage IDs configured for this portal.
 * Falls back to matching 'closedwon' by name if nothing is configured.
 */
async function getTriggerStages(portalId) {
  const result = await db.execute({
    sql: 'SELECT trigger_stages FROM portal_settings WHERE portal_id = ?',
    args: [portalId],
  });

  if (result.rows.length === 0 || !result.rows[0].trigger_stages) {
    return null; // no config — use fallback
  }

  const stages = JSON.parse(result.rows[0].trigger_stages);
  return stages.length > 0 ? new Set(stages) : null;
}

function isFallbackClosedWon(stageValue) {
  const normalised = (stageValue || '').toLowerCase().replace(/[\s_-]/g, '');
  return normalised === 'closedwon';
}

// POST /webhook/deal-won
router.post('/deal-won', async (req, res) => {
  if (!validateHubSpotSignature(req)) {
    console.warn('[webhook] Invalid HubSpot signature — rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];

  // Respond immediately — HubSpot requires a fast response
  res.status(200).json({ received: true });

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

  if (subscriptionType !== 'deal.propertyChange' || propertyName !== 'dealstage') {
    return;
  }

  const portalIdStr = String(portalId);
  const dealId = String(objectId);
  const stageValue = propertyValue || '';

  // Check portal is installed
  const portalResult = await db.execute({
    sql: 'SELECT portal_id FROM portals WHERE portal_id = ?',
    args: [portalIdStr],
  });
  if (portalResult.rows.length === 0) {
    console.warn(`[webhook] Portal ${portalIdStr} not found — skipping deal ${dealId}`);
    return;
  }

  // Check if this stage should trigger a decrement
  const triggerStages = await getTriggerStages(portalIdStr);

  let shouldTrigger;
  if (triggerStages) {
    // User has configured specific stages — match by stage ID
    shouldTrigger = triggerStages.has(stageValue);
  } else {
    // No config yet — fall back to matching 'closedwon' by name
    shouldTrigger = isFallbackClosedWon(stageValue);
  }

  if (!shouldTrigger) {
    return;
  }

  console.log(`[webhook] Deal ${dealId} moved to trigger stage "${stageValue}" — decrementing stock for portal ${portalIdStr}`);

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
