const express = require('express');
const { db } = require('../db');

const router = express.Router();

// PayPal sends raw JSON body — parse it here before express.json() strips it
router.use(express.raw({ type: 'application/json' }));

// POST /paypal/webhook — handles subscription lifecycle events
router.post('/webhook', async (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { event_type, resource } = event;
  console.log('[paypal webhook]', event_type, resource?.id);

  try {
    switch (event_type) {

      // Subscription activated (first payment approved)
      case 'BILLING.SUBSCRIPTION.ACTIVATED': {
        const subId = resource.id;
        const planId = resource.plan_id;
        const plan = planFromId(planId);
        if (plan && subId) {
          await db.execute({
            sql: `UPDATE accounts SET plan = ?, paypal_subscription_id = ?, trial_ends_at = NULL, updated_at = ?
                  WHERE paypal_subscription_id = ?`,
            args: [plan, subId, Date.now(), subId],
          });
        }
        break;
      }

      // Payment completed on renewal
      case 'PAYMENT.SALE.COMPLETED':
      case 'BILLING.SUBSCRIPTION.RENEWED': {
        const subId = resource.billing_agreement_id || resource.id;
        if (subId) {
          await db.execute({
            sql: `UPDATE accounts SET updated_at = ? WHERE paypal_subscription_id = ?`,
            args: [Date.now(), subId],
          });
        }
        break;
      }

      // Subscription cancelled or suspended — downgrade to trial (expired)
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
      case 'BILLING.SUBSCRIPTION.EXPIRED': {
        const subId = resource.id;
        if (subId) {
          await db.execute({
            sql: `UPDATE accounts SET plan = 'cancelled', updated_at = ? WHERE paypal_subscription_id = ?`,
            args: [Date.now(), subId],
          });
        }
        break;
      }

      // Payment failed — mark for follow-up but don't immediately cancel
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
        const subId = resource.id;
        if (subId) {
          console.warn('[paypal webhook] payment failed for subscription', subId);
          // You could send an alert email here
        }
        break;
      }

      default:
        // Ignore unhandled event types
        break;
    }
  } catch (err) {
    console.error('[paypal webhook] db error:', err);
    return res.status(500).json({ error: err.message });
  }

  res.json({ ok: true });
});

// Map PayPal plan ID → our plan name
function planFromId(planId) {
  if (planId === process.env.PAYPAL_PLAN_MONTHLY) return 'monthly';
  if (planId === process.env.PAYPAL_PLAN_YEARLY) return 'yearly';
  return null;
}

module.exports = router;
