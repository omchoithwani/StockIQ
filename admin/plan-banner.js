(async function () {
  const portalId = new URLSearchParams(location.search).get('portal_id');
  if (!portalId) return;

  try {
    const res = await fetch('/account/plan-status?portal_id=' + encodeURIComponent(portalId));
    if (!res.ok) return;
    const { plan, daysLeft, expired } = await res.json();
    if (!plan || plan !== 'trial') return;

    const banner = document.createElement('div');
    if (expired) {
      banner.style.cssText = 'background:#fef2f2;border-bottom:1px solid #fecaca;padding:10px 16px;text-align:center;font-size:14px;';
      banner.innerHTML = '<span style="color:#b91c1c;font-weight:600;">⏰ Your free trial has expired.</span> '
        + '<a href="/account/billing?portal_id=' + portalId + '" style="color:#b91c1c;text-decoration:underline;font-weight:700;margin-left:8px;">Upgrade now →</a>';
    } else {
      const msg = daysLeft === 0 ? 'expires today' : daysLeft + ' day' + (daysLeft !== 1 ? 's' : '') + ' remaining';
      banner.style.cssText = 'background:#fffbeb;border-bottom:1px solid #fde68a;padding:10px 16px;text-align:center;font-size:14px;';
      banner.innerHTML = '<span style="color:#92400e;">✨ Free trial — <strong>' + msg + '</strong></span>'
        + '<a href="/account/billing?portal_id=' + portalId + '" style="color:#92400e;text-decoration:underline;font-weight:700;margin-left:8px;">Upgrade to Pro</a>';
    }
    document.body.insertBefore(banner, document.body.firstChild);
  } catch (_) {}
})();
