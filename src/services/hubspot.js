const axios = require('axios');
const { db } = require('../db');
require('dotenv').config();

const HUBSPOT_API = 'https://api.hubapi.com';
const TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

/**
 * Returns a valid access token for the portal, refreshing if needed.
 */
async function getValidToken(portalId) {
  const result = await db.execute({
    sql: 'SELECT * FROM portals WHERE portal_id = ?',
    args: [portalId],
  });

  if (result.rows.length === 0) {
    throw new Error(`Portal ${portalId} not found`);
  }

  const portal = result.rows[0];
  const now = Date.now();

  // Refresh 60s before actual expiry to be safe
  if (now >= portal.token_expires - 60_000) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.HUBSPOT_CLIENT_ID,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET,
      refresh_token: portal.refresh_token,
    });

    const response = await axios.post(TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in } = response.data;
    const token_expires = now + expires_in * 1000;

    await db.execute({
      sql: `UPDATE portals
            SET access_token = ?, refresh_token = ?, token_expires = ?
            WHERE portal_id = ?`,
      args: [access_token, refresh_token, token_expires, portalId],
    });

    return access_token;
  }

  return portal.access_token;
}

/**
 * Fetches all products from HubSpot product library (paginates automatically).
 */
async function getProductsFromHubSpot(portalId) {
  const token = await getValidToken(portalId);
  const products = [];
  let after = undefined;

  do {
    const params = {
      limit: 100,
      properties: 'name,hs_sku,price,description',
    };
    if (after) params.after = after;

    const response = await axios.get(`${HUBSPOT_API}/crm/v3/objects/products`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });

    products.push(...response.data.results);
    after = response.data.paging?.next?.after;
  } while (after);

  return products;
}

/**
 * Returns all line items associated with a deal, each with quantity and hs_product_id.
 */
async function getLineItemsForDeal(portalId, dealId) {
  const token = await getValidToken(portalId);

  // Step 1: get line item IDs associated with the deal
  const assocResponse = await axios.get(
    `${HUBSPOT_API}/crm/v3/objects/deals/${dealId}/associations/line_items`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const lineItemIds = (assocResponse.data.results || []).map((r) => r.id);
  if (lineItemIds.length === 0) return [];

  // Step 2: batch-fetch each line item
  const lineItems = await Promise.all(
    lineItemIds.map((id) =>
      axios
        .get(`${HUBSPOT_API}/crm/v3/objects/line_items/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { properties: 'quantity,hs_product_id,name' },
        })
        .then((r) => r.data)
    )
  );

  return lineItems;
}

/**
 * Fetches all deal pipelines and their stages from HubSpot.
 * Returns a flat list of { pipelineId, pipelineLabel, stageId, stageLabel } objects.
 */
async function getDealPipelinesAndStages(portalId) {
  const token = await getValidToken(portalId);

  const response = await axios.get(`${HUBSPOT_API}/crm/v3/pipelines/deals`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const pipelines = response.data.results || [];
  const stages = [];

  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages || []) {
      stages.push({
        pipelineId: pipeline.id,
        pipelineLabel: pipeline.label,
        stageId: stage.id,
        stageLabel: stage.label,
        probability: stage.metadata?.probability != null
          ? parseFloat(stage.metadata.probability) * 100
          : null,
      });
    }
  }

  return stages;
}

/**
 * Returns the win probability (0-100) for a specific stage ID.
 * Uses the pipeline stages config — no race condition with deal property updates.
 */
async function getStageProbability(portalId, stageId) {
  const stages = await getDealPipelinesAndStages(portalId);
  const stage = stages.find((s) => s.stageId === stageId);
  return stage?.probability ?? null;
}

/**
 * Fetches a deal's probability and dealstage from HubSpot.
 */
async function getDealProperties(portalId, dealId) {
  const token = await getValidToken(portalId);
  const response = await axios.get(`${HUBSPOT_API}/crm/v3/objects/deals/${dealId}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { properties: 'hs_deal_stage_probability,dealstage,dealname' },
  });
  const props = response.data.properties || {};
  return {
    probability: props.hs_deal_stage_probability ? parseFloat(props.hs_deal_stage_probability) * 100 : null,
    dealstage: props.dealstage,
    dealname: props.dealname,
  };
}

module.exports = { getValidToken, getProductsFromHubSpot, getLineItemsForDeal, getDealPipelinesAndStages, getStageProbability, getDealProperties };
