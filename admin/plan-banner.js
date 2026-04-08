(async function () {
  const portalId = new URLSearchParams(location.search).get('portal_id');
  if (!portalId) return;

  try {
    const res = await fetch('/account/plan-status?portal_id=' + encodeURIComponent(portalId));
    if (!res.ok) return;
    const { plan, daysLeft, expired } = await res.json();

    const banner = document.createElement('div');

    if (!plan) {
      // No account linked — prompt setup
      banner.style.cssText = 'background:#eff6ff;border-bottom:1px solid #bfdbfe;padding:10px 16px;text-align:center;font-size:14px;';
      banner.innerHTML = '📦 <strong style="color:#1e40af;">Set up your StockIQ account</strong> '
        + '<span style="color:#3730a3;"> — activate your free 14-day trial to unlock all features.</span> '
        + '<a href="/account/signup?portal_id=' + portalId + '" style="margin-left:8px;background:#2563eb;color:#fff;padding:3px 12px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">Get started →</a>';
    } else if (plan === 'trial') {
      if (expired) {
        banner.style.cssText = 'background:#fef2f2;border-bottom:1px solid #fecaca;padding:10px 16px;text-align:center;font-size:14px;';
        banner.innerHTML = '<span style="color:#b91c1c;font-weight:600;">⏰ Your free trial has expired.</span> '
          + '<a href="/account/billing?portal_id=' + portalId + '" style="margin-left:8px;background:#dc2626;color:#fff;padding:3px 12px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">Upgrade now →</a>';
      } else {
        const msg = daysLeft === 0 ? 'expires today' : daysLeft + ' day' + (daysLeft !== 1 ? 's' : '') + ' remaining in trial';
        banner.style.cssText = 'background:#fffbeb;border-bottom:1px solid #fde68a;padding:10px 16px;text-align:center;font-size:14px;';
        banner.innerHTML = '<span style="color:#92400e;">✨ <strong>' + msg + '</strong></span> '
          + '<a href="/account/billing?portal_id=' + portalId + '" style="margin-left:8px;color:#92400e;text-decoration:underline;font-weight:600;">Upgrade to Pro — $25/mo</a>';
      }
    } else {
      return; // paid plan — no banner needed
    }

    document.body.insertBefore(banner, document.body.firstChild);
  } catch (_) {}
})();
