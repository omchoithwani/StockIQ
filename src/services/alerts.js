const axios = require('axios');
const { db } = require('../db');

const RESEND_API = 'https://api.resend.com/emails';

async function getAlertConfig(portalId) {
  const result = await db.execute({
    sql: 'SELECT * FROM portal_settings WHERE portal_id = ?',
    args: [portalId],
  });
  return result.rows[0] || null;
}

async function sendEmail(toEmail, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.ALERT_FROM_EMAIL || 'StockIQ <onboarding@resend.dev>';
  if (!apiKey) throw new Error('RESEND_API_KEY not set on server');

  await axios.post(
    RESEND_API,
    { from: fromEmail, to: [toEmail], subject, html },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
  );
}

async function sendSlack(webhookUrl, text) {
  await axios.post(webhookUrl, { text });
}

function buildLowStockHtml(product, portalId) {
  const available = product.available ?? product.quantity;
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
      <h2 style="color:#d97706">⚠️ Low Stock Alert</h2>
      <p><strong>${product.name}</strong> is running low and may need restocking.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px 12px;background:#fafafa;border:1px solid #e5e7eb;color:#6b7280">SKU</td><td style="padding:8px 12px;border:1px solid #e5e7eb">${product.sku || '—'}</td></tr>
        <tr><td style="padding:8px 12px;background:#fafafa;border:1px solid #e5e7eb;color:#6b7280">On Hand</td><td style="padding:8px 12px;border:1px solid #e5e7eb">${product.quantity}</td></tr>
        <tr><td style="padding:8px 12px;background:#fafafa;border:1px solid #e5e7eb;color:#6b7280">Reserved</td><td style="padding:8px 12px;border:1px solid #e5e7eb">${product.reserved ?? 0}</td></tr>
        <tr><td style="padding:8px 12px;background:#fafafa;border:1px solid #e5e7eb;color:#6b7280;font-weight:600">Available</td><td style="padding:8px 12px;border:1px solid #e5e7eb;color:#d97706;font-weight:600">${available}</td></tr>
        <tr><td style="padding:8px 12px;background:#fafafa;border:1px solid #e5e7eb;color:#6b7280">Threshold</td><td style="padding:8px 12px;border:1px solid #e5e7eb">${product.low_stock_threshold ?? 10}</td></tr>
      </table>
      <p style="color:#6b7280;font-size:12px">Sent by StockIQ · Portal ${portalId}</p>
    </div>`;
}

function buildOutOfStockHtml(product, dealId, portalId) {
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
      <h2 style="color:#dc2626">🚨 Out of Stock</h2>
      <p><strong>${product.name}</strong> has reached 0 units after a deal was closed.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px 12px;background:#fafafa;border:1px solid #e5e7eb;color:#6b7280">SKU</td><td style="padding:8px 12px;border:1px solid #e5e7eb">${product.sku || '—'}</td></tr>
        <tr><td style="padding:8px 12px;background:#fafafa;border:1px solid #e5e7eb;color:#6b7280;font-weight:600">Stock Remaining</td><td style="padding:8px 12px;border:1px solid #e5e7eb;color:#dc2626;font-weight:600">0</td></tr>
        ${dealId ? `<tr><td style="padding:8px 12px;background:#fafafa;border:1px solid #e5e7eb;color:#6b7280">Triggered by Deal</td><td style="padding:8px 12px;border:1px solid #e5e7eb">${dealId}</td></tr>` : ''}
      </table>
      <p>Please restock this product as soon as possible.</p>
      <p style="color:#6b7280;font-size:12px">Sent by StockIQ · Portal ${portalId}</p>
    </div>`;
}

async function sendLowStockAlert(portalId, product) {
  const config = await getAlertConfig(portalId);
  if (!config) return;

  const available = product.available ?? product.quantity;
  const name = product.name;
  const subject = `⚠️ Low Stock: ${name} (${available} units available)`;
  const slackText = `⚠️ *Low Stock Alert* — *${name}*\nSKU: ${product.sku || '—'} | On Hand: ${product.quantity} | Reserved: ${product.reserved ?? 0} | *Available: ${available}* (threshold: ${product.low_stock_threshold ?? 10})`;

  if (config.alert_email_enabled && config.alert_email) {
    try {
      await sendEmail(config.alert_email, subject, buildLowStockHtml(product, portalId));
      console.log(`[alerts] Low stock email sent for ${name}`);
    } catch (err) {
      console.error(`[alerts] Email failed:`, err.response?.data || err.message);
    }
  }

  if (config.slack_enabled && config.slack_webhook_url) {
    try {
      await sendSlack(config.slack_webhook_url, slackText);
      console.log(`[alerts] Slack low stock alert sent for ${name}`);
    } catch (err) {
      console.error(`[alerts] Slack failed:`, err.message);
    }
  }
}

async function sendOutOfStockAlert(portalId, product, dealId) {
  const config = await getAlertConfig(portalId);
  if (!config) return;

  const name = product.name;
  const subject = `🚨 Out of Stock: ${name}`;
  const slackText = `🚨 *Out of Stock* — *${name}*\nSKU: ${product.sku || '—'} | Stock hit 0${dealId ? ` after Deal #${dealId}` : ''}. Restock needed!`;

  if (config.alert_email_enabled && config.alert_email) {
    try {
      await sendEmail(config.alert_email, subject, buildOutOfStockHtml(product, dealId, portalId));
      console.log(`[alerts] Out of stock email sent for ${name}`);
    } catch (err) {
      console.error(`[alerts] Email failed:`, err.response?.data || err.message);
    }
  }

  if (config.slack_enabled && config.slack_webhook_url) {
    try {
      await sendSlack(config.slack_webhook_url, slackText);
      console.log(`[alerts] Slack out of stock alert sent for ${name}`);
    } catch (err) {
      console.error(`[alerts] Slack failed:`, err.message);
    }
  }
}

async function sendTestAlert(portalId) {
  const config = await getAlertConfig(portalId);
  if (!config) throw new Error('No settings found for this portal');

  const results = { email: null, slack: null };

  if (config.alert_email_enabled && config.alert_email) {
    try {
      await sendEmail(
        config.alert_email,
        '✅ StockIQ Alerts Connected',
        `<div style="font-family:sans-serif"><h2 style="color:#16a34a">✅ StockIQ Alerts are working!</h2><p>You will now receive low stock and out-of-stock alerts at this address.</p><p style="color:#6b7280;font-size:12px">Sent by StockIQ · Portal ${portalId}</p></div>`
      );
      results.email = 'sent';
    } catch (err) {
      results.email = err.response?.data?.message || err.message;
    }
  } else {
    results.email = 'not configured';
  }

  if (config.slack_enabled && config.slack_webhook_url) {
    try {
      await sendSlack(config.slack_webhook_url, '✅ *StockIQ Alerts Connected!* You will now receive low stock and out-of-stock notifications in this channel.');
      results.slack = 'sent';
    } catch (err) {
      results.slack = err.message;
    }
  } else {
    results.slack = 'not configured';
  }

  return results;
}

module.exports = { sendLowStockAlert, sendOutOfStockAlert, sendTestAlert };
