// Minimal server-rendered HTML views. No build step, no framework — just
// template-literal functions. Kept deliberately simple and dependency-free.

// Shared <head> tags that make "Add to Home Screen" on an iPhone (or
// Android) behave like a real app icon — standalone (no browser chrome),
// proper icon, correct title — instead of just a bookmark to a webpage.
const PWA_HEAD = `
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icons/icon-192.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">
<meta name="theme-color" content="#2b6cb0">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Couches">
`;

export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function money(n) {
  const num = typeof n === 'number' ? n : parseFloat(n);
  if (num === null || num === undefined || Number.isNaN(num)) return '—';
  return num.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function layout({ title, user, active, body, wide }) {
  const nav = [
    ['/', 'Log a sale'],
    ['/inventory', 'Inventory'],
    ['/inventory/add', 'Add Inventory'],
    ['/trips', 'Trips'],
    ['/sales', 'Sales'],
    ['/stats', 'Stats'],
    ['/dashboard', 'Dashboard'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Redefined Couches</title>
<link rel="stylesheet" href="/app.css">
${PWA_HEAD}
</head>
<body>
${user ? `
<header class="topbar">
  <div class="brand">Redefined Couches</div>
  <nav>
    ${nav.map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`).join('')}
  </nav>
  <form method="post" action="/logout" class="logout-form">
    <span class="who">${esc(user.name)}</span>
    <button type="submit">Switch</button>
  </form>
</header>` : ''}
<main class="wrap ${wide ? 'wide' : ''}">
${body}
</main>
</body>
</html>`;
}

export function loginPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Who's this? · Redefined Couches</title>
<link rel="stylesheet" href="/app.css">
${PWA_HEAD}
</head>
<body class="login-body">
<div class="login-box">
  <h1>Redefined Couches</h1>
  <p class="muted">Who's logging in?</p>
  <form method="post" action="/login">
    <button type="submit" name="name" value="Dawson" class="who-btn">Dawson</button>
    <button type="submit" name="name" value="Grant" class="who-btn">Grant</button>
  </form>
</div>
</body>
</html>`;
}
