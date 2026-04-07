const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { getProductsFromHubSpot } = require('./hubspot');
const { sendLowStockAlert, sendOutOfStockAlert } = require('./alerts');

/**
 * Return all products for a portal, with reserved and available quantities joined in.
 */
async function getAllProducts(portalId) {
  const result = await db.execute({
    sql: `SELECT p.*,
            COALESCE(r.reserved, 0) as reserved,
            MAX(0, p.quantity - COALESCE(r.reserved, 0)) as available
          FROM products p
          LEFT JOIN (
            SELECT hs_product_id, SUM(quantity) as reserved
            FROM reservations
            WHERE portal_id = ? AND status = 'active'
            GROUP BY hs_product_id
          ) r ON p.hs_product_id = r.hs_product_id
          WHERE p.portal_id = ?
          ORDER BY p.name ASC`,
    args: [portalId, portalId],
  });
  return result.rows;
}

/**
 * Search products by name or SKU.
 */
async function searchProducts(portalId, query) {
  const like = `%${query}%`;
  const result = await db.execute({
    sql: `SELECT * FROM products
          WHERE portal_id = ?
            AND (name LIKE ? OR sku LIKE ?)
          ORDER BY name ASC`,
    args: [portalId, like, like],
  });
  return result.rows;
}

/**
 * Return a single product by hs_product_id.
 */
async function getProduct(portalId, hsProductId) {
  const result = await db.execute({
    sql: 'SELECT * FROM products WHERE portal_id = ? AND hs_product_id = ?',
    args: [portalId, hsProductId],
  });
  return result.rows[0] || null;
}

/**
 * Restock a product — increment quantity and write a stock_movement row.
 */
async function restockProduct(portalId, hsProductId, quantityReceived, reference) {
  const product = await getProduct(portalId, hsProductId);
  if (!product) throw new Error(`Product ${hsProductId} not found for portal ${portalId}`);

  const newQty = product.quantity + quantityReceived;
  const now = Date.now();

  await db.execute({
    sql: 'UPDATE products SET quantity = ?, updated_at = ? WHERE portal_id = ? AND hs_product_id = ?',
    args: [newQty, now, portalId, hsProductId],
  });

  await db.execute({
    sql: `INSERT INTO stock_movements
            (id, portal_id, hs_product_id, sku, movement_type, quantity_change, quantity_after, reference, created_at)
          VALUES (?, ?, ?, ?, 'restock', ?, ?, ?, ?)`,
    args: [uuidv4(), portalId, hsProductId, product.sku, quantityReceived, newQty, reference || null, now],
  });

  const updated = { ...product, quantity: newQty };
  // Fire low stock alert async — don't block the response
  checkAndAlert(portalId, updated).catch(() => {});
  return updated;
}

/**
 * Manual quantity adjustment — set to new_quantity and write a stock_movement row.
 */
async function adjustProduct(portalId, hsProductId, newQuantity, reason) {
  const product = await getProduct(portalId, hsProductId);
  if (!product) throw new Error(`Product ${hsProductId} not found for portal ${portalId}`);

  const change = newQuantity - product.quantity;
  const now = Date.now();

  await db.execute({
    sql: 'UPDATE products SET quantity = ?, updated_at = ? WHERE portal_id = ? AND hs_product_id = ?',
    args: [newQuantity, now, portalId, hsProductId],
  });

  await db.execute({
    sql: `INSERT INTO stock_movements
            (id, portal_id, hs_product_id, sku, movement_type, quantity_change, quantity_after, reference, created_at)
          VALUES (?, ?, ?, ?, 'manual_adjust', ?, ?, ?, ?)`,
    args: [uuidv4(), portalId, hsProductId, product.sku, change, newQuantity, reason || null, now],
  });

  const updated = { ...product, quantity: newQuantity };
  checkAndAlert(portalId, updated).catch(() => {});
  return updated;
}

/**
 * Decrement stock when a deal is won. Floors at 0.
 */
async function decrementStock(portalId, hsProductId, qty, dealId) {
  const product = await getProduct(portalId, hsProductId);
  if (!product) {
    console.warn(`[stock] decrementStock: product ${hsProductId} not in DB for portal ${portalId}`);
    return;
  }

  if (qty > product.quantity) {
    console.warn(
      `[stock] Deal ${dealId} requests ${qty} of ${hsProductId} but only ${product.quantity} in stock — flooring at 0`
    );
  }

  const newQty = Math.max(0, product.quantity - qty);
  const actualChange = -(product.quantity - newQty);
  const now = Date.now();

  await db.execute({
    sql: 'UPDATE products SET quantity = ?, updated_at = ? WHERE portal_id = ? AND hs_product_id = ?',
    args: [newQty, now, portalId, hsProductId],
  });

  await db.execute({
    sql: `INSERT INTO stock_movements
            (id, portal_id, hs_product_id, sku, movement_type, quantity_change, quantity_after, reference, created_at)
          VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?)`,
    args: [uuidv4(), portalId, hsProductId, product.sku, actualChange, newQty, dealId, now],
  });

  const updated = { ...product, quantity: newQty };
  if (newQty === 0) {
    sendOutOfStockAlert(portalId, updated, dealId).catch(() => {});
  } else {
    checkAndAlert(portalId, updated).catch(() => {});
  }
}

/**
 * Check stock levels and fire alert if below threshold.
 */
async function checkAndAlert(portalId, product) {
  const reserved = product.reserved ?? 0;
  const available = Math.max(0, product.quantity - reserved);
  const threshold = product.low_stock_threshold ?? 10;
  if (available <= threshold && available > 0) {
    await sendLowStockAlert(portalId, { ...product, available, reserved });
  }
}

/**
 * Sync products from HubSpot — upsert, never overwrite existing quantities.
 */
async function syncProductsFromHubSpot(portalId) {
  const hsProducts = await getProductsFromHubSpot(portalId);
  const now = Date.now();
  let created = 0;
  let updated = 0;

  for (const p of hsProducts) {
    const props = p.properties;
    const hsProductId = p.id;
    const sku = props.hs_sku || '';
    const name = props.name || 'Unnamed Product';

    const existing = await getProduct(portalId, hsProductId);

    if (existing) {
      await db.execute({
        sql: `UPDATE products SET name = ?, sku = ?, updated_at = ? WHERE portal_id = ? AND hs_product_id = ?`,
        args: [name, sku, now, portalId, hsProductId],
      });
      updated++;
    } else {
      await db.execute({
        sql: `INSERT INTO products (id, portal_id, hs_product_id, sku, name, quantity, low_stock_threshold, is_active, updated_at)
              VALUES (?, ?, ?, ?, ?, 0, 10, 1, ?)`,
        args: [uuidv4(), portalId, hsProductId, sku, name, now],
      });
      created++;
    }
  }

  return { created, updated, total: hsProducts.length };
}

/**
 * Return all stock movements for a portal, newest first.
 */
async function getMovements(portalId) {
  const result = await db.execute({
    sql: `SELECT sm.*, p.name as product_name
          FROM stock_movements sm
          LEFT JOIN products p ON sm.portal_id = p.portal_id AND sm.hs_product_id = p.hs_product_id
          WHERE sm.portal_id = ?
          ORDER BY sm.created_at DESC`,
    args: [portalId],
  });
  return result.rows;
}

module.exports = {
  getAllProducts,
  searchProducts,
  getProduct,
  restockProduct,
  adjustProduct,
  decrementStock,
  syncProductsFromHubSpot,
  getMovements,
};
