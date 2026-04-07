const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { getLineItemsForDeal, getStageProbability } = require('../services/hubspot');
const { decrementStock } = require('../services/stock');
const {
  reserveForDeal,
  releaseReservations,
  convertReservationsToSale,
  getReservationThreshold,
} = require('../services/reservations');
require('dotenv').config();

const router = express.Router();

function validateHubSpotSignature(req) {
  const secret = process.env.HUBSPOT_CLIENT_SECRET;
  const sig = req.headers['x-hubspot-signature'];
  const sigVersion = req.headers['x-hubspot-signature-version'];
  const sigV3 = req.headers['x-hubspot-signature-v3'];
  const timestamp = req.headers['x-hubspot-request-timestamp'];

  // v3 signature
  if (sigV3 && timestamp) {
    if (Date.now() - parseInt(timestamp) > 300_000) return false;
    const body = JSON.stringify(req.body);
    const method = req.method.toUpperCase();
    const url = `${process.env.BASE_URL}${req.originalUrl}`;
    const source = `${method}${url}${body}${timestamp}`;
    const hash = crypto.createHmac('sha256', secret).update(source).digest('base64');
    if (hash === sigV3) return true;
  }

  if (!sig) return false;

  // v2 signature
  if (sigVersion === 'v2') {
    const body = JSON.stringify(req.body);
    const method = req.method.toUpperCase();
    const url = `${process.env.BASE_URL}${req.originalUrl}`;
    const hash = crypto.createHash('sha256').update(secret + method + url + body).digest('hex');
    if (hash === sig) return true;
  }

  // v1 signature — try both with raw body string and JSON.stringify
  const body = JSON.stringify(req.body);
  const hashV1 = crypto.createHash('sha256').update(secret + body).digest('hex');
  if (hashV1 === sig) return true;

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

function isFallbackClosedLost(stageValue) {
  const normalised = (stageValue || '').toLowerCase().replace(/[\s_-]/g, '');
  return normalised === 'closedlost';
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

  // Look up probability directly from the stage config — avoids race condition
  // where HubSpot hasn't updated the deal's hs_deal_stage_probability yet
  let stageProbability = null;
  try {
    stageProbability = await getStageProbability(portalIdStr, stageValue);
  } catch (err) {
    console.error(`[webhook] Failed to fetch stage probability for stage ${stageValue}:`, err.message);
  }

  const triggerStages = await getTriggerStages(portalIdStr);

  // Determine if this is a "won" stage (triggers decrement + convert)
  let isWonStage;
  if (triggerStages) {
    isWonStage = triggerStages.has(stageValue);
  } else {
    isWonStage = isFallbackClosedWon(stageValue);
  }

  // Determine if this is a "lost" stage (releases reservations)
  const isLostStage = isFallbackClosedLost(stageValue);

  console.log(`[webhook] Deal ${dealId} stage="${stageValue}" probability=${stageProbability}% won=${isWonStage} lost=${isLostStage}`);

  // --- DEAL WON: convert reservations + decrement stock ---
  if (isWonStage) {
    console.log(`[webhook] Deal ${dealId} WON — converting reservations and decrementing stock`);

    await convertReservationsToSale(portalIdStr, dealId);

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
      if (!hsProductId || isNaN(qty) || qty <= 0) continue;
      await decrementStock(portalIdStr, hsProductId, qty, dealId);
    }

    console.log(`[webhook] Done processing won deal ${dealId} — ${lineItems.length} line items`);
    return;
  }

  // --- DEAL LOST: release reservations ---
  if (isLostStage) {
    console.log(`[webhook] Deal ${dealId} LOST — releasing reservations`);
    await releaseReservations(portalIdStr, dealId, 'lost');
    return;
  }

  // --- RESERVATION LOGIC: based on probability threshold ---
  const threshold = await getReservationThreshold(portalIdStr);
  const dealProbability = stageProbability !== null ? stageProbability : 0;

  if (dealProbability >= threshold) {
    // Probability meets threshold — reserve line items
    console.log(`[webhook] Deal ${dealId} probability ${dealProbability}% >= threshold ${threshold}% — reserving stock`);

    let lineItems;
    try {
      lineItems = await getLineItemsForDeal(portalIdStr, dealId);
    } catch (err) {
      console.error(`[webhook] Failed to fetch line items for deal ${dealId}:`, err.message);
      return;
    }

    const reservationItems = lineItems
      .map((item) => {
        const props = item.properties || {};
        return {
          hsProductId: props.hs_product_id,
          sku: '',
          quantity: parseInt(props.quantity, 10) || 0,
        };
      })
      .filter((i) => i.hsProductId && i.quantity > 0);

    if (reservationItems.length > 0) {
      await reserveForDeal(portalIdStr, dealId, reservationItems);
      console.log(`[webhook] Reserved ${reservationItems.length} products for deal ${dealId}`);
    }
  } else {
    // Probability dropped below threshold — release any existing reservations
    console.log(`[webhook] Deal ${dealId} probability ${dealProbability}% < threshold ${threshold}% — releasing reservations`);
    await releaseReservations(portalIdStr, dealId, 'below_threshold');
  }
}

module.exports = router;
