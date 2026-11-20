// Security regression check for Servedash.
//
// Run against a local dev instance before every release:
//   docker compose -f docker-compose.dev.yml up -d --build
//   cd test/security && npm ci && node check.js
//
// It creates two throwaway containers with hostile labels, drives a real
// Chrome against Servedash, and checks that:
//   1. label values can't inject HTML/JS into the page
//   2. the API doesn't allow other sites to read it (no CORS)
//   3. other sites can't send POSTs or open the terminal WebSocket
//   4. the CSP blocks inline script even if escaping is ever missed
//   5. Servedash's own page can still do all of the above (no regressions)
// The payloads only set a marker variable; nothing else runs.
// Containers and the helper server are removed at the end, pass or fail.

const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const { chromium } = require('playwright-core');

const BASE = process.env.SERVEDASH_URL || 'http://localhost:3000';
const OTHER_SITE_PORT = 3999; // a different origin, standing in for "some other website"
const C_BREAKOUT = 'sd-sec-breakout';
const C_JSURL = 'sd-sec-jsurl';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function cleanup() {
  for (const n of [C_BREAKOUT, C_JSURL]) {
    try { execFileSync('docker', ['rm', '-f', n], { stdio: 'ignore' }); } catch { /* not there */ }
  }
}

function startedAt(name) {
  return docker('inspect', '-f', '{{.State.StartedAt}}', name);
}

// Opens a WebSocket from Node with a chosen Origin header.
// Resolves 'data' if the server sent an exec frame, 'rejected' otherwise.
function wsFromOrigin(origin, container) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/exec/${container}`, { origin });
    const done = (r) => { try { ws.terminate(); } catch {} resolve(r); };
    ws.on('message', () => done('data'));
    ws.on('error', () => done('rejected'));
    ws.on('close', () => done('rejected'));
    setTimeout(() => done('timeout'), 5000);
  });
}

// A page on another origin that tries to drive Servedash.
const OTHER_SITE_PAGE = `<!doctype html><script>
  window.results = {};
  fetch(${JSON.stringify(BASE)} + '/api/containers/${C_BREAKOUT}/restart', { method: 'POST', mode: 'no-cors' })
    .then(() => { window.results.post = 'sent'; }, () => { window.results.post = 'error'; });
  const ws = new WebSocket(${JSON.stringify(BASE.replace(/^http/, 'ws'))} + '/ws/exec/${C_BREAKOUT}');
  ws.onmessage = () => { window.results.ws = 'data'; ws.close(); };
  ws.onerror = () => { if (!window.results.ws) window.results.ws = 'rejected'; };
  ws.onclose = () => { if (!window.results.ws) window.results.ws = 'rejected'; };
</script>`;

(async () => {
  const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');

  cleanup();
  // A label value that tries to break out of an HTML attribute
  docker('run', '-d', '--name', C_BREAKOUT,
    '--label', 'servedash.url=http://x" onmouseover="window.__sd_marker=1" data-z="',
    'alpine', 'sleep', '600');
  // A javascript: URL
  docker('run', '-d', '--name', C_JSURL,
    '--label', 'servedash.url=javascript:window.__sd_marker=2',
    'alpine', 'sleep', '600');

  const otherSite = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(OTHER_SITE_PAGE);
  }).listen(OTHER_SITE_PORT);

  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    // ── API and headers (no browser) ─────────────────────────
    const r = await fetch(`${BASE}/api/containers`, { headers: { Origin: 'https://other.example' } });
    check('API sends no Access-Control-Allow-Origin', !r.headers.get('access-control-allow-origin'),
      `got ${r.headers.get('access-control-allow-origin')}`);
    const csp = r.headers.get('content-security-policy') || '';
    check("CSP present with script-src 'self'", /script-src 'self'(;|$)/.test(csp), csp ? '' : 'missing');
    check('CSP forbids framing', /frame-ancestors 'none'/.test(csp));
    check('X-Frame-Options DENY', r.headers.get('x-frame-options') === 'DENY');

    const list = await r.json();
    const byName = Object.fromEntries(list.map((c) => [c.name, c]));
    check('quote-breakout label URL is dropped by the API', byName[C_BREAKOUT] && byName[C_BREAKOUT].url === null,
      JSON.stringify(byName[C_BREAKOUT] && byName[C_BREAKOUT].url));
    check('javascript: label URL is dropped by the API', byName[C_JSURL] && byName[C_JSURL].url === null,
      JSON.stringify(byName[C_JSURL] && byName[C_JSURL].url));

    const post = await fetch(`${BASE}/api/containers/${C_BREAKOUT}/restart`, {
      method: 'POST', headers: { Origin: 'https://other.example' },
    });
    check('POST with a foreign Origin is rejected', post.status === 403, `status ${post.status}`);
    const postSite = await fetch(`${BASE}/api/containers/${C_BREAKOUT}/restart`, {
      method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    check('POST with Sec-Fetch-Site: cross-site is rejected', postSite.status === 403, `status ${postSite.status}`);

    check('WebSocket with a foreign Origin is rejected',
      (await wsFromOrigin('https://other.example', C_BREAKOUT)) === 'rejected');

    // ── Servedash's own page ─────────────────────────────────
    const page = await browser.newPage();
    const cspErrors = [];
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text()); });
    page.on('pageerror', (e) => cspErrors.push(`pageerror: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector(`[data-name="${C_BREAKOUT}"]`, { timeout: 10000 });

    const injected = await page.evaluate(() =>
      [...document.querySelectorAll('#container *')].some((el) =>
        [...el.attributes].some((a) => /^on/i.test(a.name))));
    check('no inline on* attributes anywhere in the rendered cards', !injected);

    await page.hover(`[data-name="${C_BREAKOUT}"] .ca.open`).catch(() => {});
    await page.click(`[data-name="${C_JSURL}"] .ca.open`, { force: true, timeout: 2000 }).catch(() => {});
    check('label payloads did not run', (await page.evaluate(() => window.__sd_marker)) === undefined);

    // CSP as a second line of defense: an inline handler added at runtime must
    // not run. Done in a separate page, because the browser logs the blocked
    // attempt as a CSP violation, and the real UI page must have none.
    const probe = await browser.newPage();
    await probe.goto(BASE, { waitUntil: 'networkidle' });
    const cspHeld = await probe.evaluate(() => {
      const b = document.createElement('button');
      b.setAttribute('onclick', 'window.__sd_csp=1');
      document.body.appendChild(b); b.click(); b.remove();
      return window.__sd_csp === undefined;
    });
    check('CSP blocks inline event handlers', cspHeld);

    // Positive checks: the real UI still works
    const before = startedAt(C_BREAKOUT);
    const ownPost = await page.evaluate(async (n) =>
      (await fetch(`/api/containers/${n}/restart`, { method: 'POST' })).status, C_BREAKOUT);
    check('own page can still restart a container', ownPost === 200, `status ${ownPost}`);
    check('...and it actually restarted', startedAt(C_BREAKOUT) !== before);

    const ownWs = await page.evaluate((n) => new Promise((resolve) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/exec/${n}`);
      ws.onmessage = () => { ws.close(); resolve('data'); };
      ws.onerror = () => resolve('error');
      setTimeout(() => resolve('timeout'), 5000);
    }), C_BREAKOUT);
    check('own page can still open the terminal', ownWs === 'data', ownWs);
    check('no CSP violations or script errors on the page', cspErrors.length === 0, cspErrors.join(' | '));

    // ── A page on another site, in the same browser ──────────
    const beforeCross = startedAt(C_BREAKOUT);
    const evil = await browser.newPage();
    await evil.goto(`http://localhost:${OTHER_SITE_PORT}/`);
    await evil.waitForFunction(() => window.results && window.results.ws, null, { timeout: 8000 }).catch(() => {});
    await new Promise((res) => setTimeout(res, 1500)); // give a restart time to show up, if it happened
    const res = await evil.evaluate(() => window.results);
    check('other site cannot restart a container', startedAt(C_BREAKOUT) === beforeCross);
    check('other site cannot open the terminal', res && res.ws === 'rejected', JSON.stringify(res));
  } finally {
    await browser.close();
    otherSite.close();
    cleanup();
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll security checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e.message);
  cleanup();
  process.exit(2);
});
