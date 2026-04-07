const axios = require('axios');
const { db } = require('../db');

const RESEND_API = 'https://api.resend.com/emails';

/**
 * Load alert config for a portal.
 */
async function getAlertConfig(portalId) {
  const result = await db.execute({
    sql: 'SELECT * FROM portal_settings WHERE portal_id = ?',
    args: [portalId],
  });
  return result.rows[0] || null;
}

/**
 * Send an email alert via Resend.
 */
async function sendEmail(apiKey, fromEmail, toEmail, subject, html) {
  await axios.post(
    RESEND_API,
    {
      from: fromEmail || 'StockIQ <onboarding@resend.dev>',
      to: [toEmail],
      subject,
      html,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Send a Slack message via incoming webhook URL.
 */
async function sendSlack(webhookUrl, text, blocks) {
  await axios.post(webhookUrl, { text, blocks });
}

/**
 * Send a low stock alert (available units below threshold).
 */
async function sendLowStockAlert(portalId, product) {
  const config = await getAlertConfig(portalId);
  if (!config) return;

  const { resend_api_key, alert_email, alert_from_email, slack_webhook_url } = config;

  const productName = product.name;
  const available = product.available ?? product.quantity;
  const onHand = product.quantity;
  const reserved = product.reserved ?? 0;
  const threshold = product.low_stock_threshold ?? 10;
  const subject = `⚠️ Low Stock Alert: ${productName}`;

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
      <h2 style="color:#d97706">⚠️ Low Stock Alert</h2>
      <p><strong>${productName}</strong> is running low.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:6px 12px;background:#fafafa;border:1px solid #e5e7eb">SKU</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${product.sku || '—'}</td></tr>
        <tr><td style="padding:6px 12px;background:#fafafa;border:1px solid #e5e7eb">On Hand</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${onHand}</td></tr>
        <tr><td style="padding:6px 12px;background:#fafafa;border:1px solid #e5e7eb">Reserved</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${reserved}</td></tr>
        <tr><td style="padding:6px 12px;background:#fafafa;border:1px solid #e5e7eb"><strong>Available</strong></td><td style="padding:6px 12px;border:1px solid #e5e7eb;color:#d97706"><strong>${available}</strong></td></tr>
        <tr><td style="padding:6px 12px;background:#fafafa;border:1px solid #e5e7eb">Threshold</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${threshold}</td></tr>
      </table>
      <p style="color:#6b7280;font-size:12px;margin-top:24px">Sent by StockIQ · Portal ${portalId}</p>
    </div>
  `;

  const slackText = `⚠️ *Low Stock Alert* — *${productName}*\nSKU: ${product.sku || '—'} | On Hand: ${onHand} | Reserved: ${reserved} | *Available: ${available}* (threshold: ${threshold})`;

  if (resend_api_key && alert_email) {
    try {
      await sendEmail(resend_api_key, alert_from_email, alert_email, subject, html);
      console.log(`[alerts] Low stock email sent for ${productName}`);
    } catch (err) {
      console.error(`[alerts] Email failed for ${productName}:`, err.response?.data || err.message);
    }
  }

  if (slack_webhook_url) {
    try {
      await sendSlack(slack_webhook_url, slackText);
      console.log(`[alerts] Slack alert sent for ${productName}`);
    } catch (err) {
      console.error(`[alerts] Slack failed for ${productName}:`, err.message);
    }
  }
}

/**
 * Send an out-of-stock alert (after a deal is won and stock hit 0).
 */
async function sendOutOfStockAlert(portalId, product, dealId) {
  const config = await getAlertConfig(portalId);
  if (!config) return;

  const { resend_api_key, alert_email, alert_from_email, slack_webhook_url } = config;

  const productName = product.name;
  const subject = `🚨 Out of Stock: ${productName}`;

  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
      <h2 style="color:#dc2626">🚨 Out of Stock</h2>
      <p><strong>${productName}</strong> has reached 0 units after a deal was closed.</p>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:6px 12px;background:#fafafa;border:1px solid #e5e7eb">SKU</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${product.sku || '—'}</td></tr>
        <tr><td style="padding:6px 12px;background:#fafafa;border:1px solid #e5e7eb"><strong>Stock Remaining</strong></td><td style="padding:6px 12px;border:1px solid #e5e7eb;color:#dc2626"><strong>0</strong></td></tr>
        ${dealId ? `<tr><td style="padding:6px 12px;background:#fafafa;border:1px solid #e5e7eb">Deal</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${dealId}</td></tr>` : ''}
      </table>
      <p>Please restock this product as soon as possible.</p>
      <p style="color:#6b7280;font-size:12px;margin-top:24px">Sent by StockIQ · Portal ${portalId}</p>
    </div>
  `;

  const slackText = `🚨 *Out of Stock* — *${productName}*\nSKU: ${product.sku || '—'} | Stock hit 0${dealId ? ` after Deal #${dealId}` : ''}. Restock needed!`;

  if (resend_api_key && alert_email) {
    try {
      await sendEmail(resend_api_key, alert_from_email, alert_email, subject, html);
      console.log(`[alerts] Out of stock email sent for ${productName}`);
    } catch (err) {
      console.error(`[alerts] Email failed for ${productName}:`, err.response?.data || err.message);
    }
  }

  if (slack_webhook_url) {
    try {
      await sendSlack(slack_webhook_url, slackText);
      console.log(`[alerts] Slack OOS alert sent for ${productName}`);
    } catch (err) {
      console.error(`[alerts] Slack failed for ${productName}:`, err.message);
    }
  }
}

/**
 * Send a test notification to verify config.
 */
async function sendTestAlert(portalId) {
  const config = await getAlertConfig(portalId);
  if (!config) throw new Error('No settings found for this portal');

  const { resend_api_key, alert_email, alert_from_email, slack_webhook_url } = config;
  const results = { email: null, slack: null };

  if (resend_api_key && alert_email) {
    try {
      await sendEmail(
        resend_api_key,
        alert_from_email,
        alert_email,
        '✅ StockIQ Alerts Connected',
        `<div style="font-family:sans-serif"><h2>✅ StockIQ Alerts are working!</h2><p>You will now receive low stock and out-of-stock alerts at this address.</p><p style="color:#6b7280;font-size:12px">Sent by StockIQ · Portal ${portalId}</p></div>`
      );
      results.email = 'sent';
    } catch (err) {
      results.email = err.response?.data?.message || err.message;
    }
  } else {
    results.email = 'not configured';
  }

  if (slack_webhook_url) {
    try {
      await sendSlack(slack_webhook_url, '✅ *StockIQ Alerts Connected* — You will now receive low stock and out-of-stock notifications in this channel.');
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
