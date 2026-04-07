const { db } = require('../db');

/**
 * Requires a logged-in account session.
 * Redirects to /account/login if not authenticated.
 */
function requireAccount(req, res, next) {
  if (!req.session?.accountId) {
    return res.redirect('/account/login');
  }
  next();
}

/**
 * Requires a logged-in account AND checks the plan is active.
 * Redirects to billing if trial expired or no active plan.
 */
async function requireActivePlan(req, res, next) {
  if (!req.session?.accountId) {
    return res.redirect('/account/login');
  }

  const result = await db.execute({
    sql: 'SELECT * FROM accounts WHERE id = ?',
    args: [req.session.accountId],
  });

  if (result.rows.length === 0) {
    req.session.destroy(() => {});
    return res.redirect('/account/login');
  }

  const account = result.rows[0];

  if (account.plan === 'trial') {
    const now = Date.now();
    if (account.trial_ends_at && now > account.trial_ends_at) {
      return res.redirect('/account/billing?reason=trial_expired');
    }
  }

  req.account = account;
  next();
}

/**
 * Requires SUPERADMIN_PASSWORD cookie/session.
 */
function requireSuperAdmin(req, res, next) {
  if (req.session?.isSuperAdmin) return next();
  return res.redirect('/superadmin/login');
}

module.exports = { requireAccount, requireActivePlan, requireSuperAdmin };
