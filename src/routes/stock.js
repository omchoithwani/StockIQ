const express = require('express');
const { requirePortal } = require('../middleware/auth');
const {
  getAllProducts,
  searchProducts,
  getProduct,
  restockProduct,
  adjustProduct,
  syncProductsFromHubSpot,
  getMovements,
} = require('../services/stock');
const { getLineItemsForDeal } = require('../services/hubspot');
const { getReservedQty } = require('../services/reservations');
const { db } = require('../db');

const router = express.Router();

// GET /api/stock/:portalId
router.get('/:portalId', requirePortal, async (req, res) => {
  try {
    const products = await getAllProducts(req.portalId);
    res.json(products);
  } catch (err) {
    console.error('[stock] getAllProducts:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/:portalId/search?q=
router.get('/:portalId/search', requirePortal, async (req, res) => {
  const q = req.query.q || '';
  try {
    const products = await searchProducts(req.portalId, q);
    res.json(products);
  } catch (err) {
    console.error('[stock] searchProducts:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/:portalId/movements
router.get('/:portalId/movements', requirePortal, async (req, res) => {
  try {
    const movements = await getMovements(req.portalId);
    res.json(movements);
  } catch (err) {
    console.error('[stock] getMovements:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/:portalId/product/:hsProductId
router.get('/:portalId/product/:hsProductId', requirePortal, async (req, res) => {
  try {
    const product = await getProduct(req.portalId, req.params.hsProductId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) {
    console.error('[stock] getProduct:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock/:portalId/restock
router.post('/:portalId/restock', requirePortal, async (req, res) => {
  const { hs_product_id, quantity_received, reference } = req.body;
  if (!hs_product_id || !quantity_received) {
    return res.status(400).json({ error: 'hs_product_id and quantity_received are required' });
  }
  const qty = parseInt(quantity_received, 10);
  if (isNaN(qty) || qty < 1) {
    return res.status(400).json({ error: 'quantity_received must be a positive integer' });
  }
  try {
    const product = await restockProduct(req.portalId, hs_product_id, qty, reference);
    res.json(product);
  } catch (err) {
    console.error('[stock] restockProduct:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock/:portalId/adjust
router.post('/:portalId/adjust', requirePortal, async (req, res) => {
  const { hs_product_id, new_quantity, reason } = req.body;
  if (hs_product_id === undefined || new_quantity === undefined) {
    return res.status(400).json({ error: 'hs_product_id and new_quantity are required' });
  }
  const qty = parseInt(new_quantity, 10);
  if (isNaN(qty) || qty < 0) {
    return res.status(400).json({ error: 'new_quantity must be a non-negative integer' });
  }
  try {
    const product = await adjustProduct(req.portalId, hs_product_id, qty, reason);
    res.json(product);
  } catch (err) {
    console.error('[stock] adjustProduct:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock/:portalId/sync
router.post('/:portalId/sync', requirePortal, async (req, res) => {
  try {
    const result = await syncProductsFromHubSpot(req.portalId);
    res.json(result);
  } catch (err) {
    console.error('[stock] syncProducts:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock/:portalId/threshold
router.post('/:portalId/threshold', requirePortal, async (req, res) => {
  const { hs_product_id, threshold } = req.body;
  if (!hs_product_id || threshold === undefined) {
    return res.status(400).json({ error: 'hs_product_id and threshold are required' });
  }
  const t = parseInt(threshold, 10);
  if (isNaN(t) || t < 0) {
    return res.status(400).json({ error: 'threshold must be a non-negative integer' });
  }
  try {
    await db.execute({
      sql: 'UPDATE products SET low_stock_threshold = ?, updated_at = ? WHERE portal_id = ? AND hs_product_id = ?',
      args: [t, Date.now(), req.portalId, hs_product_id],
    });
    res.json({ ok: true, threshold: t });
  } catch (err) {
    console.error('[stock] threshold update:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/:portalId/export — download all products as CSV
router.get('/:portalId/export', requirePortal, async (req, res) => {
  try {
    const products = await getAllProducts(req.portalId);
    const rows = [
      ['sku', 'name', 'on_hand', 'reserved', 'available', 'threshold'],
      ...products.map(p => [
        p.sku || '',
        `"${(p.name || '').replace(/"/g, '""')}"`,
        p.quantity,
        p.reserved ?? 0,
        p.available ?? p.quantity,
        p.low_stock_threshold ?? 10,
      ]),
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="stockiq-export-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock/:portalId/bulk-restock — [{sku, quantity_to_add}]
router.post('/:portalId/bulk-restock', requirePortal, async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'rows array is required' });

  const results = { updated: 0, skipped: [], errors: [] };
  for (const row of rows) {
    const qty = parseInt(row.quantity_to_add, 10);
    if (!row.sku || isNaN(qty) || qty <= 0) {
      results.skipped.push({ sku: row.sku, reason: 'invalid quantity' }); continue;
    }
    const found = await db.execute({
      sql: 'SELECT * FROM products WHERE portal_id = ? AND sku = ?',
      args: [req.portalId, row.sku.trim()],
    });
    if (found.rows.length === 0) {
      results.skipped.push({ sku: row.sku, reason: 'SKU not found' }); continue;
    }
    try {
      await restockProduct(req.portalId, found.rows[0].hs_product_id, qty, 'Bulk restock');
      results.updated++;
    } catch (err) {
      results.errors.push({ sku: row.sku, reason: err.message });
    }
  }
  res.json(results);
});

// POST /api/stock/:portalId/bulk-adjust — [{sku, new_quantity, threshold?}]
router.post('/:portalId/bulk-adjust', requirePortal, async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'rows array is required' });

  const results = { updated: 0, skipped: [], errors: [] };
  for (const row of rows) {
    const qty = parseInt(row.new_quantity, 10);
    if (!row.sku || isNaN(qty) || qty < 0) {
      results.skipped.push({ sku: row.sku, reason: 'invalid quantity' }); continue;
    }
    const found = await db.execute({
      sql: 'SELECT * FROM products WHERE portal_id = ? AND sku = ?',
      args: [req.portalId, row.sku.trim()],
    });
    if (found.rows.length === 0) {
      results.skipped.push({ sku: row.sku, reason: 'SKU not found' }); continue;
    }
    try {
      await adjustProduct(req.portalId, found.rows[0].hs_product_id, qty, 'Bulk adjust');
      const threshold = parseInt(row.threshold, 10);
      if (!isNaN(threshold) && threshold >= 0) {
        await db.execute({
          sql: 'UPDATE products SET low_stock_threshold = ? WHERE portal_id = ? AND hs_product_id = ?',
          args: [threshold, req.portalId, found.rows[0].hs_product_id],
        });
      }
      results.updated++;
    } catch (err) {
      results.errors.push({ sku: row.sku, reason: err.message });
    }
  }
  res.json(results);
});

// POST /api/stock/:portalId/bulk-threshold — [{hs_product_id, threshold}]
router.post('/:portalId/bulk-threshold', requirePortal, async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'rows array is required' });

  const now = Date.now();
  let updated = 0;
  for (const row of rows) {
    const t = parseInt(row.threshold, 10);
    if (!row.hs_product_id || isNaN(t) || t < 0) continue;
    await db.execute({
      sql: 'UPDATE products SET low_stock_threshold = ?, updated_at = ? WHERE portal_id = ? AND hs_product_id = ?',
      args: [t, now, req.portalId, row.hs_product_id],
    });
    updated++;
  }
  res.json({ ok: true, updated });
});


// Used by the HubSpot CRM card to get stock data for all line items on a deal.
router.get('/:portalId/deal-line-items/:dealId', requirePortal, async (req, res) => {
  const { dealId } = req.params;
  try {
    const hsLineItems = await getLineItemsForDeal(req.portalId, dealId);
    const enriched = await Promise.all(
      hsLineItems.map(async (item) => {
        const props = item.properties || {};
        const hsProductId = props.hs_product_id;
        const requested = parseInt(props.quantity, 10) || 0;
        let stockData = null;
        if (hsProductId) {
          stockData = await getProduct(req.portalId, hsProductId);
        }
        const reserved = hsProductId ? await getReservedQty(req.portalId, hsProductId) : 0;
        const stockOnHand = stockData ? stockData.quantity : null;
        const available = stockOnHand !== null ? Math.max(0, stockOnHand - reserved) : null;
        return {
          hsProductId: hsProductId || null,
          name: props.name || stockData?.name || 'Unknown',
          sku: stockData?.sku || null,
          requested,
          stockOnHand,
          reserved,
          available,
          threshold: stockData ? stockData.low_stock_threshold : 10,
        };
      })
    );
    res.json({ lineItems: enriched });
  } catch (err) {
    console.error('[stock] deal-line-items:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
