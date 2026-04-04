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

module.exports = { getValidToken, getProductsFromHubSpot, getLineItemsForDeal };
