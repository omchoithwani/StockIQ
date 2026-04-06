const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { getLineItemsForDeal } = require('../services/hubspot');
const { decrementStock } = require('../services/stock');
require('dotenv').config();

const router = express.Router();

function validateHubSpotSignature(req) {
  const secret = process.env.HUBSPOT_CLIENT_SECRET;

  // v3 signature (X-HubSpot-Signature-V3)
  const sigV3 = req.headers['x-hubspot-signature-v3'];
  if (sigV3) {
    const timestamp = req.headers['x-hubspot-request-timestamp'];
    // Reject requests older than 5 minutes
    if (timestamp && Date.now() - parseInt(timestamp) > 300_000) return false;
    const body = JSON.stringify(req.body);
    const method = req.method.toUpperCase();
    const url = `${process.env.BASE_URL}${req.originalUrl}`;
    const source = `${method}${url}${body}${timestamp || ''}`;
    const hash = crypto.createHmac('sha256', secret).update(source).digest('base64');
    if (hash === sigV3) return true;
  }

  // v2 signature (X-HubSpot-Signature with version header)
  const sigVersion = req.headers['x-hubspot-signature-version'];
  const sig = req.headers['x-hubspot-signature'];

  if (sig && sigVersion === 'v2') {
    const body = JSON.stringify(req.body);
    const method = req.method.toUpperCase();
    const url = `${process.env.BASE_URL}${req.originalUrl}`;
    const hash = crypto.createHash('sha256').update(secret + method + url + body).digest('hex');
    if (hash === sig) return true;
  }

  // v1 signature (legacy)
  if (sig) {
    const body = JSON.stringify(req.body);
    const hash = crypto.createHash('sha256').update(secret + body).digest('hex');
    if (hash === sig) return true;
  }

  return false;
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
  // Log signature headers for debugging
  console.log('[webhook] sig headers:', JSON.stringify({
    sig: req.headers['x-hubspot-signature'],
    sigVersion: req.headers['x-hubspot-signature-version'],
    sigV3: req.headers['x-hubspot-signature-v3'],
    timestamp: req.headers['x-hubspot-request-timestamp'],
  }));

  // Temporarily bypass signature validation to confirm webhook flow
  const sigValid = validateHubSpotSignature(req);
  if (!sigValid) {
    console.warn('[webhook] Signature invalid but continuing for debug — fix before production');
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
