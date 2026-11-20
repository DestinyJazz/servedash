/* STATE */
let containers = [];
let filter  = 'all';
let query   = '';
let viewMode = localStorage.getItem('sd-view') || 'grid';
let logId   = null;
let allLines = [];

/* SORT / ORDER STATE
   sortMode: 'manual' | 'name' | 'uptime'
   manualOrder: array of container names in user-defined order (from backend)
   dir: 'asc' | 'desc' for the active sort button */
let sortMode = 'manual';
let manualOrder = [];
let nameDir = 'asc';
let uptimeDir = 'desc';
let refreshTimer = null;
let updates = {}; // containerName -> { status }

/* THEME */
const html = document.documentElement;
const themeBtn = document.getElementById('themeBtn');
const initTheme = localStorage.getItem('sd-theme') || 'dark';
html.dataset.theme = initTheme;
themeBtn.textContent = initTheme === 'dark' ? '☀️' : '🌙';
themeBtn.addEventListener('click', () => {
  const n = html.dataset.theme === 'dark' ? 'light' : 'dark';
  html.dataset.theme = n;
  localStorage.setItem('sd-theme', n);
  themeBtn.textContent = n === 'dark' ? '☀️' : '🌙';
});

/* VIEW TOGGLE */
const gridBtn = document.getElementById('gridBtn');
const listBtn = document.getElementById('listBtn');
function setView(v) {
  viewMode = v;
  localStorage.setItem('sd-view', v);
  gridBtn.classList.toggle('active', v === 'grid');
  listBtn.classList.toggle('active', v === 'list');
  render();
}
gridBtn.addEventListener('click', () => setView('grid'));
listBtn.addEventListener('click', () => setView('list'));
// init button state
gridBtn.classList.toggle('active', viewMode === 'grid');
listBtn.classList.toggle('active', viewMode === 'list');

/* TOAST */
function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.className = `toast ${type} show`;
  // textContent, not innerHTML: messages can include container names and
  // Docker error text, which must never be parsed as HTML.
  const icon = document.createElement('span');
  icon.textContent = type === 'ok' ? '✅' : '❌';
  el.replaceChildren(icon, document.createTextNode(String(msg)));
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

/* API */
async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

/* LOAD */
async function loadInfo() {
  try {
    const d = await get('/api/info');
    document.getElementById('hostText').textContent = `Docker ${d.dockerVersion} · ${d.os}`;
    document.getElementById('sTotal').textContent   = d.containers;
    document.getElementById('sRunning').textContent = d.running;
    document.getElementById('sStopped').textContent = d.stopped;
    document.getElementById('sImages').textContent  = d.images;
  } catch(e) {
    document.getElementById('hostText').textContent = 'Connection error';
  }
}

async function loadContainers(isAuto = false) {
  const btn = document.getElementById('refreshBtn');
  if (!isAuto) btn.classList.add('spinning');
  try {
    const fresh = await get('/api/containers');
    // On auto-refresh, patch data in place to avoid a full re-render
    // (no flicker, keeps scroll position, drag order, open menus).
    // Fall back to full render if the container set changed structurally.
    if (isAuto && canPatch(containers, fresh)) {
      containers = fresh;
      patchContainers();
    } else {
      containers = fresh;
      render();
    }
    updateCounts();
  } catch(e) {
    if (!isAuto) toast('Failed to load containers', 'err');
  }
  if (!isAuto) btn.classList.remove('spinning');
}

// Can we patch in place? Only if the same containers exist with the same
// running-state (structural changes need a full render: add/remove/start/stop).
function canPatch(oldList, newList) {
  if (!oldList || oldList.length !== newList.length) return false;
  const oldByName = {};
  oldList.forEach(c => { oldByName[c.name] = c; });
  for (const c of newList) {
    const o = oldByName[c.name];
    if (!o) return false;                       // new container
    if (o.status !== c.status) return false;    // running<->stopped flip
    const oRun = o.status === 'running', nRun = c.status === 'running';
    if (oRun !== nRun) return false;
  }
  return true;
}

// Update only the volatile fields inside existing cards/rows.
function patchContainers() {
  const wrap = document.getElementById('container');
  containers.forEach(c => {
    const els = wrap.querySelectorAll(`[data-name="${cssEsc(c.name)}"]`);
    els.forEach(el => {
      // status badge (label + class) — handles healthy<->unhealthy
      const badge = el.querySelector('[data-field="badge"]');
      if (badge) {
        const sc = sClass(c);
        badge.className = `sbadge ${sc}`;
        badge.innerHTML = `<div class="sdot"></div>${sLabel(c)}`;
        // keep the card/row accent border in sync
        el.classList.remove('running','exited','paused','unhealthy');
        el.classList.add(sc);
      }
      // CPU / memory values + bars
      if (c.stats) {
        const cpu = c.stats.cpu, mem = c.stats.memPercent;
        const cv = el.querySelector('[data-field="cpu-val"]');
        const cb = el.querySelector('[data-field="cpu-bar"]');
        const mv = el.querySelector('[data-field="mem-val"]');
        const mb = el.querySelector('[data-field="mem-bar"]');
        if (cv) cv.textContent = `${cpu}%`;
        if (cb) { cb.className = `cs-fill cpu ${barCls(cpu)}`; cb.style.width = `${Math.min(cpu,100)}%`; }
        if (mv) mv.textContent = `${c.stats.memUsage} MB`;
        if (mb) { mb.className = `cs-fill mem ${barCls(mem)}`; mb.style.width = `${Math.min(mem,100)}%`; }
      }
    });
  });
}

// Escape a string for use in a CSS attribute selector
function cssEsc(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\\]]/g, '\\$&');
}

// Check for image updates in the background; re-render badges when ready.
// Network-bound (hits the registry), so never blocks the main load.
// manual=true means user clicked the button (show toast + spinner feedback).
let updateCheckInterval = 0;
async function loadUpdates(manual = false) {
  const btn = document.getElementById('updateCheckBtn');
  if (manual && btn) btn.classList.add('spinning');
  try {
    const d = await get('/api/updates');
    updates = d.updates || {};
    render();
    reflectSelfUpdate();
    if (manual) {
      const n = Object.values(updates).filter(u => u.status === 'update').length;
      if (n > 0) toast(`${n} update${n > 1 ? 's' : ''} available`);
      else toast('All images up to date');
    }
  } catch(e) {
    if (manual) toast('Update check failed', 'err');
  }
  if (manual && btn) btn.classList.remove('spinning');
}

async function loadAll(isAuto = false) {
  await Promise.all([loadInfo(), loadContainers(isAuto)]);
  // Only auto-check on load if an interval is configured (0 = strictly manual)
  if (!isAuto && updateCheckInterval > 0) loadUpdates(false);
}

/* HELPERS */
// Status helpers take the container so an unhealthy running container
// can be shown as "Unhealthy" rather than plain "Running".
function sClass(c) {
  if (c.status === 'running' && c.health === 'unhealthy') return 'unhealthy';
  return c.status === 'running' ? 'running' : c.status === 'paused' ? 'paused' : 'exited';
}
function sLabel(c) {
  if (c.status === 'running' && c.health === 'unhealthy') return 'Unhealthy';
  return c.status === 'running' ? 'Running' : c.status === 'paused' ? 'Paused' : c.status === 'created' ? 'Created' : 'Stopped';
}
function init(name) { return name.slice(0,2).toUpperCase(); }
function barCls(v) { return v >= 90 ? 'hot' : v >= 80 ? 'warn' : ''; }

// Build the Actions dropdown for a container, listing only actions valid
// for its current state:
//   running (not paused) -> Restart, Pause, Stop
//   paused               -> Unpause, Stop
//   stopped/exited       -> Start
function actionsMenu(c) {
  const icons = {
    start:   '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    restart: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>',
    pause:   '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
    unpause: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
    stop:    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
  };
  let actions;
  if (c.status === 'paused') actions = ['unpause', 'stop'];
  else if (c.status === 'running') actions = ['restart', 'pause', 'stop'];
  else actions = ['start'];

  const items = actions.map(a =>
    `<div class="am-item ${a}" data-action="act" data-act="${a}" data-id="${esc(c.fullId)}" data-name="${esc(c.name)}">${icons[a]}<span>${a.charAt(0).toUpperCase()+a.slice(1)}</span></div>`
  ).join('');

  return `<div class="actions-menu-wrap" data-action="actions-menu">
    <button class="ca actions-btn">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
      Actions
    </button>
    <div class="am-menu">${items}</div>
  </div>`;
}
// Escape for both HTML text and quoted attribute values. Every string that
// comes from Docker (names, images, labels, logs, registry tags) is untrusted:
// image authors set labels with LABEL in their Dockerfile, and containers
// inherit them. Never put these values inside inline JS (onclick="...");
// pass them as data-* attributes and read them in the click handler instead.
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Only http(s) links can be opened. Blocks javascript:, data: and anything
// that doesn't parse as a URL. The backend applies the same rule.
function safeUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw, location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

function buildUrl(c) {
  if (c.url) return safeUrl(c.url);
  if (c.port) return `http://${window.location.hostname}:${c.port}`;
  return null;
}

// All public ports for a container
// Ports the Open button can offer: published TCP only (a browser can't open UDP).
function publicPorts(c) {
  return (c.ports || []).filter(p => p.PublicPort && p.Type !== 'udp');
}

// Build URL from a specific port entry
function portUrl(p) {
  const proto = p.PublicPort === 443 || p.PublicPort === 9443 || p.PublicPort === 8443 ? 'https' : 'http';
  return `${proto}://${window.location.hostname}:${p.PublicPort}`;
}

// Toggle port dropdown (closes all others first)
function togglePortMenu(el) {
  const isOpen = el.classList.contains('open');
  document.querySelectorAll('.port-menu-wrap.open').forEach(w => w.classList.remove('open'));
  if (!isOpen) {
    el.classList.add('open');
    // Close when clicking outside
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!el.contains(e.target)) {
          el.classList.remove('open');
          document.removeEventListener('click', handler);
        }
      });
    }, 0);
  }
}

function toggleActionsMenu(el) {
  const isOpen = el.classList.contains('open');
  document.querySelectorAll('.actions-menu-wrap.open').forEach(w => w.classList.remove('open'));
  if (!isOpen) {
    el.classList.add('open');
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!el.contains(e.target)) {
          el.classList.remove('open');
          document.removeEventListener('click', handler);
        }
      });
    }, 0);
  }
}

/* FILTER */
function matchesFilter(c) {
  switch (filter) {
    case 'all': return true;
    case 'running': return c.status === 'running';
    case 'exited': return c.status !== 'running' && c.status !== 'paused';
    case 'paused': return c.status === 'paused';
    case 'unhealthy': return c.status === 'running' && c.health === 'unhealthy';
    default: return true;
  }
}
function filtered() {
  return containers.filter(c => {
    const mf = matchesFilter(c);
    const mq = !query || c.name.toLowerCase().includes(query) || c.image.toLowerCase().includes(query);
    return mf && mq;
  });
}

/* ORDER — apply manual order or an active sort rule */
function ordered(items) {
  const list = items.slice();
  if (sortMode === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name));
    if (nameDir === 'desc') list.reverse();
    return list;
  }
  if (sortMode === 'uptime') {
    // created is a unix timestamp (seconds); older = longer uptime
    list.sort((a, b) => a.created - b.created); // oldest first = longest uptime first
    if (uptimeDir === 'asc') list.reverse();    // asc = shortest uptime first
    return list;
  }
  if (sortMode === 'update') {
    // containers with an available update first, then by name
    const rank = (c) => (updates[c.name] && updates[c.name].status === 'update') ? 0 : 1;
    list.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    return list;
  }
  // manual: order by saved name list, unknown names fall to the end in original order
  if (manualOrder.length) {
    const idx = {};
    manualOrder.forEach((n, i) => { idx[n] = i; });
    list.sort((a, b) => {
      const ia = a.name in idx ? idx[a.name] : Infinity;
      const ib = b.name in idx ? idx[b.name] : Infinity;
      return ia - ib;
    });
  }
  return list;
}

function updateCounts() {
  const all = containers.length;
  const run = containers.filter(c=>c.status==='running').length;
  const stop = containers.filter(c=>c.status!=='running' && c.status!=='paused').length;
  const pause = containers.filter(c=>c.status==='paused').length;
  const unhealthy = containers.filter(c=>c.status==='running' && c.health==='unhealthy').length;
  document.getElementById('cAll').textContent = all;
  document.getElementById('cRun').textContent = run;
  document.getElementById('cStop').textContent = stop;
  document.getElementById('cPause').textContent = pause;
  document.getElementById('cUnhealthy').textContent = unhealthy;
  // the active filter's count shown on the dropdown button
  const map = { all, running:run, exited:stop, paused:pause, unhealthy };
  document.getElementById('fCount').textContent = map[filter] != null ? map[filter] : all;
}

/* RENDER */
// "↑ Update" badge (grid) or compact "↑" (list). Pinned version tags such as
// 1.2.1 report latestVersion instead — show that version, since clicking
// only explains how to move to it (see openUpdateConfirm).
function updateBadge(c, compact) {
  const u = updates[c.name];
  if (!u || u.status !== 'update') return '';
  const title = u.latestVersion ? `Version ${u.latestVersion} is available — click for details` : 'A newer image is available — click to update';
  const label = compact ? '↑' : u.latestVersion ? `↑ ${esc(u.latestVersion)}` : '↑ Update';
  const tag = compact ? 'span' : 'div';
  return `${compact ? ' ' : ''}<${tag} class="ubadge" title="${esc(title)}" data-action="update" data-id="${esc(c.fullId)}" data-name="${esc(c.name)}">${label}</${tag}>`;
}

function render() {
  const wrap = document.getElementById('container');
  const items = ordered(filtered());
  if (!items.length) {
    wrap.innerHTML = `<div class="${viewMode === 'grid' ? 'grid' : ''}"><div class="empty"><div class="empty-icon">🔍</div><h3>No containers found</h3><p>Try adjusting your filter or search.</p></div></div>`;
    return;
  }
  wrap.innerHTML = viewMode === 'grid' ? renderGrid(items) : renderList(items);
  wrap.querySelectorAll('.card, .list-row').forEach((el,i) => { el.style.animationDelay = `${i*20}ms`; });
  attachDrag();
}

function renderGrid(items) {
  return `<div class="grid">${items.map(c => {
    const sc  = sClass(c);
    const hs  = c.stats !== null;
    const cpu = hs ? c.stats.cpu : 0;
    const mem = hs ? c.stats.memPercent : 0;
    const url = buildUrl(c);
    const pubPorts = publicPorts(c);
    const multiPort = !c.url && pubPorts.length > 1;
    const ports = (c.ports||[]).filter(p=>p.PublicPort).slice(0,4);
    const isRun = c.status === 'running';

    // Build open button — dropdown if multiple ports, normal if single/label.
    // Not running -> a plain disabled button: a stopped service won't answer,
    // and the dropdown wrapper would still open on click (disabled buttons
    // have pointer-events:none, so the click falls through to the wrapper).
    const openBtn = multiPort && isRun
      ? `<div class="port-menu-wrap" id="pmw-${esc(c.id)}" data-action="port-menu">
          <button class="ca open">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-left:2px"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="port-dropdown">
            ${pubPorts.map(p => `
              <div class="port-option" data-action="open" data-url="${esc(portUrl(p))}">
                <span class="port-option-port">:${p.PublicPort}</span>
                <span class="port-option-proto">${portUrl(p).startsWith('https') ? 'HTTPS' : 'HTTP'} → ${p.PrivatePort}</span>
              </div>`).join('')}
          </div>
        </div>`
      : `<button class="ca open" data-action="open" data-url="${esc(url || '')}" ${url && isRun ? '' : 'disabled'} title="${esc(isRun ? (url||'No URL') : 'Container not running')}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Open
        </button>`;
    return `<div class="card ${sc}" draggable="true" data-name="${esc(c.name)}">
      <div class="ch">
        <div class="drag-grip" title="Drag to reorder">⠿</div>
        <div class="avatar">${esc(init(c.name))}</div>
        <div class="cmeta">
          <div class="cname" title="${esc(c.name)}">${esc(c.name)}</div>
          <div class="cimage" title="${esc(c.image)}">${esc(c.image)}</div>
        </div>
        <div class="sbadge ${sc}" data-field="badge"><div class="sdot"></div>${sLabel(c)}</div>
        ${updateBadge(c)}
      </div>
      ${hs ? `<div class="cstats">
        <div class="cs"><div class="cs-label">CPU</div><div class="cs-val" data-field="cpu-val">${cpu}%</div><div class="cs-bar"><div class="cs-fill cpu ${barCls(cpu)}" data-field="cpu-bar" style="width:${Math.min(cpu,100)}%"></div></div></div>
        <div class="cs"><div class="cs-label">Memory</div><div class="cs-val" data-field="mem-val">${hs ? c.stats.memUsage : 0} MB</div><div class="cs-bar"><div class="cs-fill mem ${barCls(mem)}" data-field="mem-bar" style="width:${Math.min(mem,100)}%"></div></div></div>
      </div>` : ''}
      ${ports.length ? `<div class="cports">${ports.map(p=>`<span class="ptag">${p.PublicPort}→${p.PrivatePort}${p.Type === 'udp' ? '/udp' : ''}</span>`).join('')}</div>` : ''}
      <div class="cactions">
        ${openBtn}
        <button class="ca logs" data-action="logs" data-id="${esc(c.fullId)}" data-name="${esc(c.name)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          Logs
        </button>
        ${isRun ? `<button class="ca term" data-action="term" data-id="${esc(c.fullId)}" data-name="${esc(c.name)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Term
        </button>` : ''}
        ${actionsMenu(c)}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderList(items) {
  return `<div class="list">
    <div class="list-header">
      <div>Container</div><div>Image</div><div>Status</div><div>CPU</div><div>Memory</div><div style="text-align:right">Actions</div>
    </div>
    ${items.map(c => {
      const sc  = sClass(c);
      const hs  = c.stats !== null;
      const cpu = hs ? `${c.stats.cpu}%` : '—';
      const mem = hs ? `${c.stats.memUsage} MB` : '—';
      const url = buildUrl(c);
      const pubPorts = publicPorts(c);
      const multiPort = !c.url && pubPorts.length > 1;
      const isRun = c.status === 'running';

      // Same rule as the grid: dropdown only when running, else disabled button.
      const listOpenBtn = multiPort && isRun
        ? `<div class="port-menu-wrap" id="lpmw-${esc(c.id)}" data-action="port-menu" style="position:relative">
            <button class="la open">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Open ▾
            </button>
            <div class="port-dropdown">
              ${pubPorts.map(p => `
                <div class="port-option" data-action="open" data-url="${esc(portUrl(p))}">
                  <span class="port-option-port">:${p.PublicPort}</span>
                  <span class="port-option-proto">${portUrl(p).startsWith('https') ? 'HTTPS' : 'HTTP'} → ${p.PrivatePort}</span>
                </div>`).join('')}
            </div>
          </div>`
        : `<button class="la open" data-action="open" data-url="${esc(url || '')}" ${url && isRun ? '' : 'disabled'}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Open
          </button>`;

      return `<div class="list-row ${sc}" draggable="true" data-name="${esc(c.name)}">
        <div class="list-name">
          <div class="drag-grip list-grip" title="Drag to reorder">⠿</div>
          <div class="list-avatar">${esc(init(c.name))}</div>
          <div class="list-cname" title="${esc(c.name)}">${esc(c.name)}</div>
        </div>
        <div class="list-image" title="${esc(c.image)}">${esc(c.image)}</div>
        <div><div class="sbadge ${sc}" data-field="badge"><div class="sdot"></div>${sLabel(c)}</div>${updateBadge(c, true)}</div>
        <div class="list-stat" data-field="cpu-val">${cpu}</div>
        <div class="list-stat" data-field="mem-val">${mem}</div>
        <div class="list-actions">
          ${listOpenBtn}
          <button class="la logs" data-action="logs" data-id="${esc(c.fullId)}" data-name="${esc(c.name)}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Logs
          </button>
          ${isRun ? `<button class="la term" data-action="term" data-id="${esc(c.fullId)}" data-name="${esc(c.name)}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            Term
          </button>` : ''}
          ${actionsMenu(c)}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

/* FILTER / SEARCH */
function toggleFilterMenu(e) {
  e.stopPropagation();
  document.getElementById('filterMenu').classList.toggle('open');
}
document.addEventListener('click', () => {
  document.getElementById('filterMenu').classList.remove('open');
});
const fLabels = { all:'All', running:'Running', exited:'Stopped', paused:'Paused', unhealthy:'Unhealthy' };
document.querySelectorAll('.f-dd-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.f-dd-item').forEach(x => x.classList.remove('on'));
    item.classList.add('on');
    filter = item.dataset.f;
    // reflect selection in the button (label + colored dot)
    document.getElementById('fLabel').textContent = fLabels[filter];
    document.getElementById('fDot').className = 'f-dd-dot ' + (filter === 'all' ? 'all' : filter);
    document.getElementById('filterMenu').classList.remove('open');
    render();
    updateCounts();
  });
});
document.getElementById('searchInput').addEventListener('input', e => {
  query = e.target.value.toLowerCase();
  render();
});

/* ACTIONS */
function openURL(url) {
  const u = safeUrl(url);
  // noopener: the opened page gets no handle back to this window
  if (u) window.open(u, '_blank', 'noopener,noreferrer');
}
// One click handler for every button on the cards and rows. Values come from
// data-* attributes (read back as plain strings by the browser), so nothing
// from Docker is ever parsed as JavaScript. This also lets the CSP forbid
// inline event handlers entirely.
const VALID_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause'];
document.getElementById('container').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !e.currentTarget.contains(el) || el.matches(':disabled')) return;
  const { action, id, name, url } = el.dataset;
  const portWrap = el.closest('.port-menu-wrap');
  const menuWrap = el.closest('.actions-menu-wrap');
  switch (action) {
    case 'open':
      openURL(url);
      if (portWrap) { e.stopPropagation(); togglePortMenu(portWrap); }
      break;
    case 'port-menu':
      e.stopPropagation(); togglePortMenu(el);
      break;
    case 'actions-menu':
      e.stopPropagation(); toggleActionsMenu(el);
      break;
    case 'act':
      e.stopPropagation();
      if (VALID_ACTIONS.includes(el.dataset.act)) act(id, el.dataset.act, name);
      if (menuWrap) toggleActionsMenu(menuWrap);
      break;
    case 'update':
      e.stopPropagation(); openUpdateConfirm(id, name);
      break;
    case 'logs':
      openLogs(id, name);
      break;
    case 'term':
      openTerminal(id, name);
      break;
  }
});
document.getElementById('logo').addEventListener('click', () => loadAll());
document.getElementById('versionTag').addEventListener('click', (e) => e.stopPropagation());
document.getElementById('filterBtn').addEventListener('click', toggleFilterMenu);

async function act(id, action, name) {
  try {
    const r = await fetch(`/api/containers/${id}/${action}`, { method: 'POST' });
    if (!r.ok) throw new Error();
    toast(`${name} — ${action} successful`);
    setTimeout(loadAll, 900);
  } catch {
    toast(`Failed to ${action} ${name}`, 'err');
  }
}

/* LOGS */
function parseTS(ts) {
  try { return new Date(ts.split(' ')[0]).toLocaleTimeString(); } catch { return ts.slice(0,19); }
}
async function openLogs(id, name) {
  logId = id;
  document.getElementById('mName').textContent = name;
  document.getElementById('mId').textContent   = id.slice(0,12);
  document.getElementById('overlay').classList.add('open');
  document.getElementById('logFilter').value = '';
  await fetchLogs();
}
async function fetchLogs() {
  const body = document.getElementById('logBody');
  const tail = document.getElementById('tailSel').value;
  body.innerHTML = '<div class="log-empty">Loading…</div>';
  try {
    const d = await get(`/api/containers/${logId}/logs?tail=${tail}`);
    allLines = d.logs || [];
    renderLogs('');
  } catch {
    body.innerHTML = `<div class="log-empty" style="color:var(--red)">Error loading logs.</div>`;
  }
}
function renderLogs(ft) {
  const body = document.getElementById('logBody');
  const f = ft.toLowerCase();
  const lines = f ? allLines.filter(l => l.line.toLowerCase().includes(f)) : allLines;
  if (!lines.length) { body.innerHTML = '<div class="log-empty">No log entries found.</div>'; return; }
  body.innerHTML = lines.map(({stream, line}) => {
    const parts = line.split(' ');
    const ts   = parseTS(parts[0] || '');
    const text = esc(parts.slice(1).join(' '));
    const hl   = f && line.toLowerCase().includes(f) ? 'log-hl' : '';
    return `<div class="log-line ${hl}"><span class="log-ts">${esc(ts)}</span><span class="log-txt ${stream==='stderr'?'err':''}">${text}</span></div>`;
  }).join('');
  body.scrollTop = body.scrollHeight;
}
document.getElementById('logFilter').addEventListener('input', e => renderLogs(e.target.value));
document.getElementById('tailSel').addEventListener('change', fetchLogs);
document.getElementById('reloadLogs').addEventListener('click', fetchLogs);
document.getElementById('closeModal').addEventListener('click', () => document.getElementById('overlay').classList.remove('open'));
document.getElementById('overlay').addEventListener('click', e => { if (e.target === document.getElementById('overlay')) document.getElementById('overlay').classList.remove('open'); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  document.getElementById('overlay').classList.remove('open');
  if (document.getElementById('termOverlay').classList.contains('open')) closeTerminal();
  closeUpdateModal();
});

/* TERMINAL */
let termWs = null;
let term = null;
let fitAddon = null;
let termResizeObserver = null;

// base64 <-> raw bytes, not base64 <-> JS-string — the exec stream is
// arbitrary bytes (control sequences, UTF-8, etc.), and btoa()/atob() only
// handle Latin1, so we go through Uint8Array explicitly in both directions.
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function closeTerminal() {
  document.getElementById('termOverlay').classList.remove('open');
  if (termWs) { termWs.onclose = null; termWs.close(); termWs = null; }
  if (termResizeObserver) { termResizeObserver.disconnect(); termResizeObserver = null; }
  if (term) { term.dispose(); term = null; }
  document.getElementById('termContainer').innerHTML = '';
}

function openTerminal(id, name) {
  document.getElementById('termName').textContent = name;
  document.getElementById('termId').textContent = id.slice(0, 12);
  document.getElementById('termOverlay').classList.add('open');
  const statusEl = document.getElementById('termStatus');
  statusEl.textContent = 'Connecting…';
  statusEl.className = 'term-status';

  term = new Terminal({
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 13,
    theme: { background: '#0a0c10' },
    cursorBlink: true,
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById('termContainer'));
  fitAddon.fit();

  const sendResize = () => {
    if (termWs && termWs.readyState === WebSocket.OPEN) {
      termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  termWs = new WebSocket(`${proto}://${location.host}/ws/exec/${id}`);
  // The server sends an error frame and then closes the socket, so onclose
  // must not overwrite the error with a generic "Disconnected".
  let failed = false;
  termWs.onopen = () => { statusEl.textContent = 'Connected'; sendResize(); };
  termWs.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'data') term.write(b64ToBytes(msg.data));
    else if (msg.type === 'error') {
      failed = true;
      statusEl.textContent = msg.message;
      statusEl.className = 'term-status err';
      term.write(`\x1b[31m${msg.message}\x1b[0m\r\n`);
    }
  };
  termWs.onclose = () => { if (!failed) statusEl.textContent = 'Disconnected'; };
  termWs.onerror = () => { failed = true; statusEl.className = 'term-status err'; statusEl.textContent = 'Connection error'; };

  term.onData((data) => {
    if (termWs && termWs.readyState === WebSocket.OPEN) {
      termWs.send(JSON.stringify({ type: 'data', data: bytesToB64(new TextEncoder().encode(data)) }));
    }
  });

  termResizeObserver = new ResizeObserver(() => { fitAddon.fit(); sendResize(); });
  termResizeObserver.observe(document.getElementById('termContainer'));
}

document.getElementById('closeTerm').addEventListener('click', closeTerminal);
document.getElementById('termOverlay').addEventListener('click', e => { if (e.target === document.getElementById('termOverlay')) closeTerminal(); });

/* IMAGE UPDATE (risk-classified pull + recreate) */
let updateTarget = null; // { id, name, risky }

function closeUpdateModal() {
  document.getElementById('updateOverlay').classList.remove('open');
  updateTarget = null;
}

// "repo:1.2.1" -> "repo:1.3.0"
function withTag(image, tag) { return image.replace(/:[^:/]+$/, '') + ':' + tag; }

// Why Servedash can't one-click update itself, plus what to run instead.
function selfUpdateHelp(s, latestVersion) {
  const target = latestVersion ? withTag(s.image, latestVersion) : s.image;
  const cd = s.composeDir ? `cd "${s.composeDir}" && ` : '';
  const svc = s.composeService ? ' ' + s.composeService : '';
  let how;
  if (s.portainer) {
    how = latestVersion
      ? `<p>In Portainer, change the stack's image to <code>${esc(target)}</code> and redeploy it.</p>`
      : `<p>In Portainer, open the stack and redeploy it with <b>Re-pull image</b> enabled.</p>`;
  } else if (s.composeService) {
    how = latestVersion
      ? `<p>Change the image in your docker-compose.yml to <code>${esc(target)}</code>, then run on the host:</p><pre class="confirm-cmd">${esc(`${cd}docker compose up -d${svc}`)}</pre>`
      : `<p>Run this on the host instead:</p><pre class="confirm-cmd">${esc(`${cd}docker compose pull${svc} && docker compose up -d${svc}`)}</pre>`;
  } else {
    how = `<p>Pull the new image on the host, then remove this container and start it again with the same <code>docker run</code> options:</p><pre class="confirm-cmd">${esc(`docker pull ${target}`)}</pre>`;
  }
  return `<p><b>Servedash can't update its own container.</b> Updating means stopping the old container and starting a new one — but Servedash runs inside the container it would have to stop, so it would shut itself down halfway and never start the new one. Other containers aren't affected and still update in one click.</p>${how}`;
}

// Pinned version tag (e.g. 1.2.1): pulling the same tag again changes nothing,
// and jumping versions automatically could cross a breaking major upgrade.
function pinnedUpdateHelp(c, latestVersion) {
  return `<p><b>${esc(c.name)}</b> is pinned to a specific version, and <b>${esc(latestVersion)}</b> is available.</p>
    <p>Servedash doesn't change pinned versions for you — a newer version can include breaking changes (a database major upgrade, for example). To update, change the image in your compose file or <code>docker run</code> command to <code>${esc(withTag(c.image, latestVersion))}</code> and recreate the container.</p>`;
}

async function openUpdateConfirm(id, name) {
  document.getElementById('updName').textContent = name;
  document.getElementById('updId').textContent = id.slice(0, 12);
  const body = document.getElementById('updateBody');
  const confirmBtn = document.getElementById('updateConfirmBtn');
  const cancelBtn = document.getElementById('updateCancelBtn');
  body.innerHTML = 'Checking…';
  confirmBtn.disabled = true;
  confirmBtn.style.display = '';
  cancelBtn.textContent = 'Cancel';
  confirmBtn.classList.remove('risky');
  confirmBtn.textContent = 'Update now';
  document.getElementById('updateOverlay').classList.add('open');

  let risk;
  try {
    risk = await get(`/api/containers/${id}/update-risk`);
  } catch {
    body.innerHTML = 'Could not check update risk.';
    return;
  }

  // Servedash itself, or a pinned version tag: nothing to do in one click,
  // so explain what to do instead and offer only "Close".
  const u = updates[name] || {};
  const c = containers.find(x => x.fullId === id);
  const info = risk.self ? selfUpdateHelp(risk.self, u.latestVersion)
    : u.latestVersion && c ? pinnedUpdateHelp(c, u.latestVersion) : null;
  if (info) {
    body.innerHTML = info;
    confirmBtn.style.display = 'none';
    cancelBtn.textContent = 'Close';
    return;
  }

  updateTarget = { id, name, risky: risk.risky };

  if (!risk.risky) {
    body.innerHTML = `This will pull the new image and recreate <b>${esc(name)}</b> with its current configuration (ports, volumes, env). The container restarts briefly.`;
    confirmBtn.disabled = false;
  } else {
    body.innerHTML = `
      <p>Updating <b>${esc(name)}</b> carries some risk:</p>
      <ul class="confirm-reasons">${risk.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      <label class="confirm-check">
        <input type="checkbox" id="riskAck"/>
        <span>I understand the risk, update anyway</span>
      </label>`;
    confirmBtn.classList.add('risky');
    confirmBtn.textContent = 'Update anyway';
    confirmBtn.disabled = true;
    document.getElementById('riskAck').addEventListener('change', e => { confirmBtn.disabled = !e.target.checked; });
  }
}

document.getElementById('updateConfirmBtn').addEventListener('click', async () => {
  if (!updateTarget) return;
  const { id, name, risky } = updateTarget;
  const btn = document.getElementById('updateConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  try {
    const r = await fetch(`/api/containers/${id}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: risky }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Update failed');
    toast(`${name} updated`);
    closeUpdateModal();
    setTimeout(loadAll, 900);
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
    btn.textContent = risky ? 'Update anyway' : 'Update now';
  }
});
document.getElementById('updateCancelBtn').addEventListener('click', closeUpdateModal);
document.getElementById('closeUpdate').addEventListener('click', closeUpdateModal);
document.getElementById('updateOverlay').addEventListener('click', e => { if (e.target === document.getElementById('updateOverlay')) closeUpdateModal(); });

/* DRAG & DROP REORDER */
let dragName = null;
function attachDrag() {
  const wrap = document.getElementById('container');
  const els = wrap.querySelectorAll('[draggable="true"]');
  els.forEach(el => {
    el.addEventListener('dragstart', e => {
      dragName = el.dataset.name;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      wrap.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
    });
    el.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (el.dataset.name !== dragName) el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const targetName = el.dataset.name;
      if (!dragName || dragName === targetName) return;
      reorder(dragName, targetName);
    });
  });
}

// Move dragName to the position of targetName, switch to manual mode, persist
function reorder(fromName, toName) {
  // Build the current full visible order as the base
  const current = ordered(filtered()).map(c => c.name);
  const from = current.indexOf(fromName);
  const to = current.indexOf(toName);
  if (from < 0 || to < 0) return;
  current.splice(to, 0, current.splice(from, 1)[0]);

  // Merge with any names not currently visible (filtered out) so we don't lose them
  const hidden = manualOrder.filter(n => !current.includes(n));
  manualOrder = current.concat(hidden);

  // Switch to manual mode and clear sort button highlights
  sortMode = 'manual';
  document.getElementById('sortName').classList.remove('active');
  document.getElementById('sortUptime').classList.remove('active');
  document.getElementById('sortUpdate').classList.remove('active');
  render();
  saveOrder();
}

async function saveOrder() {
  try {
    await fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: manualOrder })
    });
  } catch {
    toast('Could not save order', 'err');
  }
}

async function loadOrder() {
  try {
    const d = await get('/api/order');
    manualOrder = Array.isArray(d.order) ? d.order : [];
  } catch {
    manualOrder = [];
  }
}

/* SORT BUTTONS — clicking applies the rule and overrides manual order */
const sortNameBtn = document.getElementById('sortName');
const sortUptimeBtn = document.getElementById('sortUptime');
const sortUpdateBtn = document.getElementById('sortUpdate');

function clearSortActive() {
  sortNameBtn.classList.remove('active');
  sortUptimeBtn.classList.remove('active');
  sortUpdateBtn.classList.remove('active');
}

function setSortLabels() {
  document.getElementById('sortNameLbl').innerHTML =
    'Name' + (sortMode === 'name' ? ` <span class="sort-dir">${nameDir === 'asc' ? 'A–Z' : 'Z–A'}</span>` : '');
  document.getElementById('sortUptimeLbl').innerHTML =
    'Uptime' + (sortMode === 'uptime' ? ` <span class="sort-dir">${uptimeDir === 'desc' ? '↓' : '↑'}</span>` : '');
}

sortNameBtn.addEventListener('click', () => {
  if (sortMode === 'name') { nameDir = nameDir === 'asc' ? 'desc' : 'asc'; }
  else { sortMode = 'name'; }
  clearSortActive();
  sortNameBtn.classList.add('active');
  setSortLabels();
  render();
});

sortUptimeBtn.addEventListener('click', () => {
  if (sortMode === 'uptime') { uptimeDir = uptimeDir === 'desc' ? 'asc' : 'desc'; }
  else { sortMode = 'uptime'; }
  clearSortActive();
  sortUptimeBtn.classList.add('active');
  setSortLabels();
  render();
});

sortUpdateBtn.addEventListener('click', () => {
  sortMode = 'update';
  clearSortActive();
  sortUpdateBtn.classList.add('active');
  setSortLabels();
  render();
});

/* CONFIG + AUTO-REFRESH */
let updateCheckTimer = null;
let appVersion = '';
async function loadConfig() {
  try {
    const d = await get('/api/config');
    appVersion = d.version || '';
    const vt = document.getElementById('versionTag');
    if (vt && appVersion) vt.textContent = 'v' + appVersion;
    const sec = parseInt(d.refreshInterval, 10) || 0;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (sec > 0) {
      refreshTimer = setInterval(() => loadAll(true), sec * 1000);
    }
    // image update check interval (minutes). 0 = manual only.
    const upMin = parseInt(d.updateCheckInterval, 10) || 0;
    updateCheckInterval = upMin;
    if (updateCheckTimer) { clearInterval(updateCheckTimer); updateCheckTimer = null; }
    if (upMin > 0) {
      updateCheckTimer = setInterval(() => loadUpdates(false), upMin * 60 * 1000);
    }
  } catch {}
}

// Highlight the version tag if Servedash itself has an update available.
function reflectSelfUpdate() {
  const vt = document.getElementById('versionTag');
  if (!vt) return;
  // The backend flags its own container; the image-name match is a fallback
  // for setups where it can't tell (e.g. a custom hostname and no procfs).
  const self = containers.find(c => c.self) || containers.find(c => c.image.includes('servedash'));
  const u = self && updates[self.name];
  const hasUpdate = u && u.status === 'update';
  vt.classList.toggle('has-update', !!hasUpdate);
  vt.title = hasUpdate
    ? `A new Servedash version${u.latestVersion ? ` (${u.latestVersion})` : ''} is available — click for release notes`
    : 'View release notes';
}

/* REFRESH */
document.getElementById('refreshBtn').addEventListener('click', loadAll);
document.getElementById('updateCheckBtn').addEventListener('click', () => loadUpdates(true));

/* INIT */
(async function bootstrap() {
  await loadOrder();
  await loadConfig();
  await loadAll();
})();
