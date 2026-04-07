const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

/**
 * Get total active reserved quantity for a product across all deals.
 */
async function getReservedQty(portalId, hsProductId) {
  const result = await db.execute({
    sql: `SELECT COALESCE(SUM(quantity), 0) as reserved
          FROM reservations
          WHERE portal_id = ? AND hs_product_id = ? AND status = 'active'`,
    args: [portalId, hsProductId],
  });
  return Number(result.rows[0].reserved);
}

/**
 * Get all active reservations for a portal.
 */
async function getAllReservations(portalId) {
  const result = await db.execute({
    sql: `SELECT r.*, p.name as product_name
          FROM reservations r
          LEFT JOIN products p ON r.portal_id = p.portal_id AND r.hs_product_id = p.hs_product_id
          WHERE r.portal_id = ?
          ORDER BY r.created_at DESC
          LIMIT 200`,
    args: [portalId],
  });
  return result.rows;
}

/**
 * Get all active reservations for a specific deal.
 */
async function getReservationsForDeal(portalId, dealId) {
  const result = await db.execute({
    sql: `SELECT * FROM reservations
          WHERE portal_id = ? AND deal_id = ? AND status = 'active'`,
    args: [portalId, dealId],
  });
  return result.rows;
}

/**
 * Create or update reservations for a deal's line items.
 * If reservations already exist for this deal, update them.
 */
async function reserveForDeal(portalId, dealId, lineItems) {
  const now = Date.now();

  // Release any existing active reservations for this deal first
  await releaseReservations(portalId, dealId, 'updated');

  // Create new reservations
  for (const item of lineItems) {
    const { hsProductId, sku, quantity } = item;
    if (!hsProductId || !quantity || quantity <= 0) continue;

    await db.execute({
      sql: `INSERT INTO reservations (id, portal_id, deal_id, hs_product_id, sku, quantity, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      args: [uuidv4(), portalId, dealId, hsProductId, sku || '', quantity, now, now],
    });
  }

  console.log(`[reservations] Reserved ${lineItems.length} items for deal ${dealId}`);
}

/**
 * Release reservations for a deal (on lost, deleted, or when re-reserving).
 */
async function releaseReservations(portalId, dealId, reason = 'released') {
  const now = Date.now();
  await db.execute({
    sql: `UPDATE reservations SET status = ?, updated_at = ?
          WHERE portal_id = ? AND deal_id = ? AND status = 'active'`,
    args: [reason, now, portalId, dealId],
  });
  console.log(`[reservations] Released reservations for deal ${dealId} (${reason})`);
}

/**
 * Convert reservations to sales when deal is won — releases reservation
 * (actual stock decrement happens separately via decrementStock).
 */
async function convertReservationsToSale(portalId, dealId) {
  const now = Date.now();
  await db.execute({
    sql: `UPDATE reservations SET status = 'converted', updated_at = ?
          WHERE portal_id = ? AND deal_id = ? AND status = 'active'`,
    args: [now, portalId, dealId],
  });
}

/**
 * Get reservation probability threshold for a portal (default 80%).
 */
async function getReservationThreshold(portalId) {
  const result = await db.execute({
    sql: 'SELECT reservation_probability FROM portal_settings WHERE portal_id = ?',
    args: [portalId],
  });
  if (result.rows.length === 0) return 80;
  return result.rows[0].reservation_probability ?? 80;
}

module.exports = {
  getReservedQty,
  getAllReservations,
  getReservationsForDeal,
  reserveForDeal,
  releaseReservations,
  convertReservationsToSale,
  getReservationThreshold,
};
