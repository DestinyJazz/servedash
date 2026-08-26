const express = require('express');
const Docker = require('dockerode');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');

// Servedash version — keep in sync with the git tag / GHCR image tag on release.
const VERSION = '1.3.0';

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Persistent data directory (mount a volume here to keep order across restarts)
const DATA_DIR = process.env.DATA_DIR || '/app-data';
const ORDER_FILE = path.join(DATA_DIR, 'order.json');

// Refresh interval (seconds) the frontend uses for auto-refresh. 0 = off.
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL, 10) || 0;

// Image update check interval (minutes). 0 = manual only (button click).
const UPDATE_CHECK_INTERVAL = parseInt(process.env.UPDATE_CHECK_INTERVAL, 10) || 0;

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.warn(`Could not create data dir ${DATA_DIR}: ${e.message}`);
  }
}
ensureDataDir();

/* ──────────────────────────────────────────────────────────
   IMAGE UPDATE DETECTION (read-only)
   Supports public images on Docker Hub, GHCR (ghcr.io), and
   LinuxServer (lscr.io). Compares the local image digest with
   the remote digest for the same tag. Private images and other
   registries are reported as 'unsupported'. Results are cached.
   ────────────────────────────────────────────────────────── */

const UPDATE_CACHE = new Map(); // "<registry>/<repo>:<tag>" -> { remoteDigest, checkedAt }
const UPDATE_TTL = 30 * 60 * 1000; // 30 min

// Per-registry config. Each entry knows its registry host and how to get
// an anonymous pull token for a repo.
const REGISTRIES = {
  'docker.io': {
    host: 'registry-1.docker.io',
    tokenUrl: (repo) => `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
  },
  'ghcr.io': {
    host: 'ghcr.io',
    tokenUrl: (repo) => `https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`,
  },
  'lscr.io': {
    host: 'lscr.io',
    tokenUrl: (repo) => `https://lscr.io/token?service=lscr.io&scope=repository:${repo}:pull`,
  },
};

// Parse an image reference into { registry, repo, tag }.
// Returns null only for images on registries we can't check (private/other).
function parseImage(ref) {
  if (!ref) return null;
  let rest = ref;
  let tag = 'latest';

  // split tag (but not the registry port colon)
  const lastColon = rest.lastIndexOf(':');
  const lastSlash = rest.lastIndexOf('/');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
  }

  // digest-pinned images (@sha256:...) — can't meaningfully "update"
  if (rest.includes('@')) return null;

  // detect explicit registry host (contains '.' or ':' before first slash, or 'localhost')
  const firstSlash = rest.indexOf('/');
  let host = 'docker.io';
  let repoPath = rest;
  if (firstSlash > 0) {
    const maybeHost = rest.slice(0, firstSlash);
    if (maybeHost.includes('.') || maybeHost.includes(':') || maybeHost === 'localhost') {
      host = maybeHost;
      repoPath = rest.slice(firstSlash + 1);
    }
  }

  // only the registries we know how to query anonymously
  if (!REGISTRIES[host]) return null;

  // Docker Hub official images need the library/ prefix
  let repo = repoPath;
  if (host === 'docker.io' && !repo.includes('/')) repo = 'library/' + repo;

  return { registry: host, repo, tag };
}

// Get an anonymous pull token for a repo on a given registry
async function registryToken(registry, repo) {
  const cfg = REGISTRIES[registry];
  const r = await fetch(cfg.tokenUrl(repo));
  if (!r.ok) throw new Error(`token ${r.status}`);
  const j = await r.json();
  // Docker Hub returns { token }, GHCR/lscr return { token } too (sometimes { access_token })
  return j.token || j.access_token;
}

// Fetch the remote manifest digest for a parsed image
async function remoteDigest(parsed) {
  const cfg = REGISTRIES[parsed.registry];
  const token = await registryToken(parsed.registry, parsed.repo);
  const url = `https://${cfg.host}/v2/${parsed.repo}/manifests/${parsed.tag}`;
  const r = await fetch(url, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: [
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.oci.image.manifest.v1+json',
      ].join(', '),
    },
  });
  if (!r.ok) throw new Error(`manifest ${r.status}`);
  return r.headers.get('docker-content-digest');
}

// Check a single container's image for updates. Never throws.
async function checkImageUpdate(imageRef, localDigests) {
  const parsed = parseImage(imageRef);
  if (!parsed) return { status: 'unsupported' };

  const cacheKey = `${parsed.registry}/${parsed.repo}:${parsed.tag}`;
  const cached = UPDATE_CACHE.get(cacheKey);
  const now = Date.now();

  let remote;
  if (cached && now - cached.checkedAt < UPDATE_TTL) {
    remote = cached.remoteDigest;
  } else {
    try {
      remote = await remoteDigest(parsed);
      UPDATE_CACHE.set(cacheKey, { remoteDigest: remote, checkedAt: now });
    } catch (e) {
      return { status: 'error', message: e.message };
    }
  }
  if (!remote) return { status: 'error', message: 'no remote digest' };

  // localDigests look like "repo@sha256:abc..." — extract the sha part
  const localShas = (localDigests || []).map(d => {
    const at = d.indexOf('@');
    return at >= 0 ? d.slice(at + 1) : d;
  });

  if (localShas.length === 0) return { status: 'unknown' };
  const upToDate = localShas.includes(remote);
  return { status: upToDate ? 'current' : 'update', remoteDigest: remote };
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

// GET runtime config for the frontend
app.get('/api/config', (req, res) => {
  res.json({
    version: VERSION,
    refreshInterval: REFRESH_INTERVAL,
    updateCheckInterval: UPDATE_CHECK_INTERVAL,
  });
});

// GET saved container order (array of container names). Empty array if none.
app.get('/api/order', (req, res) => {
  try {
    if (!fs.existsSync(ORDER_FILE)) return res.json({ order: [] });
    const raw = fs.readFileSync(ORDER_FILE, 'utf8');
    const data = JSON.parse(raw);
    res.json({ order: Array.isArray(data.order) ? data.order : [] });
  } catch (err) {
    res.json({ order: [] });
  }
});

// POST saved container order. Body: { order: ["name1","name2",...] }
app.post('/api/order', (req, res) => {
  const order = req.body && Array.isArray(req.body.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'order must be an array' });
  try {
    ensureDataDir();
    fs.writeFileSync(ORDER_FILE, JSON.stringify({ order }, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET image update status for all containers.
// Returns { updates: { "<containerName>": { status, ... } } }
// status: 'update' | 'current' | 'unsupported' | 'error' | 'unknown'
app.get('/api/updates', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });

    // Inspect each container to get its image ref + local digests.
    // De-duplicate by image ref so we hit the registry once per image.
    const byImage = new Map(); // imageRef -> localDigests[]
    const containerImage = {};  // name -> imageRef

    await Promise.all(containers.map(async (c) => {
      const name = c.Names[0].replace(/^\//, '');
      try {
        const info = await docker.getContainer(c.Id).inspect();
        const imageRef = info.Config.Image; // e.g. "nginx:latest"
        containerImage[name] = imageRef;
        if (!byImage.has(imageRef)) {
          // get local digests from the image itself
          let digests = [];
          try {
            const img = await docker.getImage(imageRef).inspect();
            digests = img.RepoDigests || [];
          } catch { /* image may be untagged locally */ }
          byImage.set(imageRef, digests);
        }
      } catch {
        containerImage[name] = c.Image;
      }
    }));

    // Check each unique image once
    const imageResults = {};
    await Promise.all([...byImage.entries()].map(async ([ref, digests]) => {
      imageResults[ref] = await checkImageUpdate(ref, digests);
    }));

    // Map back to container names
    const updates = {};
    for (const [name, ref] of Object.entries(containerImage)) {
      updates[name] = imageResults[ref] || { status: 'unknown' };
    }

    res.json({ updates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ──────────────────────────────────────────────────────────
   ONE-CLICK IMAGE UPDATE (pull + recreate)
   Unlike the read-only check above, this actually replaces the
   container. Containers matching known "safe" shapes (no compose/
   Portainer stack ownership, no legacy linking, single default
   network) can be recreated with one click; anything else is
   flagged risky with reasons and requires client confirmation,
   which the server re-validates rather than trusting.
   ────────────────────────────────────────────────────────── */

function classifyRisk(info) {
  const reasons = [];
  const labels = (info.Config && info.Config.Labels) || {};

  if (labels['com.docker.compose.project']) {
    reasons.push('Managed by docker-compose — recreating here may drift from your compose file; next "docker compose up -d" may not behave as expected.');
  }
  if (Object.keys(labels).some((k) => k.startsWith('io.portainer.'))) {
    reasons.push('Managed by a Portainer stack — recreating here may cause it to fall out of sync with Portainer.');
  }
  const hc = info.HostConfig || {};
  if ((hc.VolumesFrom || []).length) reasons.push('Uses VolumesFrom (mounts volumes from another container).');
  if ((hc.Links || []).length) reasons.push('Uses legacy container links (--link).');

  const nets = Object.entries((info.NetworkSettings && info.NetworkSettings.Networks) || {});
  const hasCustomNet = nets.length > 1 || nets.some(([, n]) =>
    (n.IPAMConfig && n.IPAMConfig.IPv4Address) || (n.Aliases || []).some((a) => !a.startsWith(info.Id.slice(0, 12)))
  );
  if (hasCustomNet) reasons.push('Custom network configuration (multiple networks, a static IP, or network aliases).');

  return { risky: reasons.length > 0, reasons };
}

// GET risk assessment for updating a single container
app.get('/api/containers/:id/update-risk', async (req, res) => {
  try {
    const info = await docker.getContainer(req.params.id).inspect();
    res.json(classifyRisk(info));
  } catch (err) {
    res.status(err.statusCode === 404 ? 404 : 500).json({ error: err.message });
  }
});

const UPDATE_IN_PROGRESS = new Set(); // container ids currently being recreated

// Pull an image, awaiting completion (dockerode's pull() streams progress events).
function pullImage(imageRef) {
  return new Promise((resolve, reject) => {
    docker.pull(imageRef, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
    });
  });
}

// Rebuild a createContainer NetworkingConfig from an inspected container's
// NetworkSettings, preserving aliases / static IPs per network.
function rebuildNetworkingConfig(networks) {
  const EndpointsConfig = {};
  for (const [netName, net] of Object.entries(networks || {})) {
    EndpointsConfig[netName] = {
      Aliases: net.Aliases || undefined,
      IPAMConfig: net.IPAMConfig && net.IPAMConfig.IPv4Address ? { IPv4Address: net.IPAMConfig.IPv4Address } : undefined,
    };
  }
  return { EndpointsConfig };
}

// Poll until a container reports Running, or give up.
async function waitUntilRunning(container, attempts = 10, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    const info = await container.inspect();
    if (info.State.Running) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// POST recreate a container against a freshly pulled image. Body: { confirm: boolean }
// Order matters: never stop the old container before the new image is pulled,
// and never remove the old container before the new one is confirmed running —
// so a failure at any step leaves at least one of the two alive.
app.post('/api/containers/:id/update', async (req, res) => {
  const { id } = req.params;
  if (UPDATE_IN_PROGRESS.has(id)) {
    return res.status(409).json({ error: 'An update for this container is already in progress' });
  }
  UPDATE_IN_PROGRESS.add(id);

  const container = docker.getContainer(id);
  let old;
  try {
    old = await container.inspect();
  } catch (err) {
    UPDATE_IN_PROGRESS.delete(id);
    return res.status(404).json({ error: 'Container not found' });
  }

  const risk = classifyRisk(old);
  if (risk.risky && !req.body.confirm) {
    UPDATE_IN_PROGRESS.delete(id);
    return res.status(400).json({ error: 'This update is risky and requires confirmation', ...risk });
  }

  const origName = old.Name.replace(/^\//, '');
  const rollbackName = `${origName}_sd_rollback_${Date.now()}`;
  const wasRunning = old.State.Running;

  // Renames the old container back to its original name and, if it was
  // running before we touched it, restarts it. Guarded so it only ever
  // runs once, from whichever failure branch hits it first.
  let restored = false;
  async function restoreOriginal() {
    if (restored) return;
    restored = true;
    await container.rename({ name: origName }).catch(() => {});
    if (wasRunning) await container.start().catch(() => {});
  }

  let renamed = false;
  let newContainer = null;
  try {
    // 1. Pull first — if this fails, nothing about the running container changes.
    await pullImage(old.Config.Image);

    // 2. Rename the old container out of the way, then stop it, so the new
    //    container can take its original name.
    await container.rename({ name: rollbackName });
    renamed = true;
    await container.stop({ t: 10 }).catch((e) => {
      if (e.statusCode !== 304 /* already stopped */) throw e;
    });

    // 3. Create + start the replacement under the original name/config.
    //    Any failure here — including createContainer itself — restores
    //    the original rather than leaving it stopped under the rollback name.
    newContainer = await docker.createContainer({
      name: origName,
      Image: old.Config.Image,
      Cmd: old.Config.Cmd,
      Entrypoint: old.Config.Entrypoint,
      Env: old.Config.Env,
      Labels: old.Config.Labels,
      ExposedPorts: old.Config.ExposedPorts,
      WorkingDir: old.Config.WorkingDir,
      User: old.Config.User,
      HostConfig: old.HostConfig,
      NetworkingConfig: rebuildNetworkingConfig(old.NetworkSettings.Networks),
    });
    await newContainer.start();
    const running = await waitUntilRunning(newContainer);
    if (!running) throw new Error('New container did not reach Running state');

    // 4. Only now remove the renamed original.
    await container.remove({ force: true });
    res.json({ success: true });
  } catch (err) {
    if (newContainer) await newContainer.remove({ force: true }).catch(() => {});
    if (renamed) {
      await restoreOriginal();
      res.status(500).json({ error: `Update failed, original container restored: ${err.message}` });
    } else {
      res.status(500).json({ error: err.message });
    }
  } finally {
    UPDATE_IN_PROGRESS.delete(id);
  }
});

// GET all containers with stats
app.get('/api/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });

    const details = await Promise.all(containers.map(async (c) => {
      let stats = null;
      let url = null;
      let port = null;

      const labels = c.Labels || {};

      // Custom URL from label, in priority order:
      // servedash.url (preferred) > dashboard.url (legacy) > homepage.href (Homepage compat)
      url = labels['servedash.url']
        || labels['dashboard.url']
        || labels['homepage.href']
        || null;

      // Otherwise grab the public port — frontend will build the URL
      if (!url && c.Ports && c.Ports.length > 0) {
        const pub = c.Ports.find(p => p.PublicPort);
        if (pub) port = pub.PublicPort;
      }

      // CPU / RAM stats for running containers only
      if (c.State === 'running') {
        try {
          const container = docker.getContainer(c.Id);
          const s = await container.stats({ stream: false });
          const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
          const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
          const ncpu = s.cpu_stats.online_cpus || 1;
          const cpuPct = sysDelta > 0 ? (cpuDelta / sysDelta) * ncpu * 100 : 0;
          const memUsage = s.memory_stats.usage || 0;
          const memLimit = s.memory_stats.limit || 1;
          stats = {
            cpu: Math.round(cpuPct * 10) / 10,
            memUsage: Math.round(memUsage / 1024 / 1024),
            memLimit: Math.round(memLimit / 1024 / 1024),
            memPercent: Math.round((memUsage / memLimit) * 1000) / 10,
          };
        } catch {
          stats = { cpu: 0, memUsage: 0, memLimit: 0, memPercent: 0 };
        }
      }

      // Parse healthcheck state from the Status string.
      // Docker reports health in parentheses, e.g. "Up 2 hours (unhealthy)".
      // A container can be running AND unhealthy at the same time — State alone
      // won't tell you, so we read it from Status here.
      let health = null; // 'healthy' | 'unhealthy' | 'starting' | null (no healthcheck)
      const st = c.Status || '';
      if (/\(healthy\)/i.test(st)) health = 'healthy';
      else if (/\(unhealthy\)/i.test(st)) health = 'unhealthy';
      else if (/\(health: starting\)/i.test(st)) health = 'starting';

      return {
        id: c.Id.substring(0, 12),
        fullId: c.Id,
        name: c.Names[0].replace(/^\//, ''),
        image: c.Image,
        status: c.State,
        statusText: c.Status,
        health,
        url,
        port,
        ports: c.Ports,
        stats,
        created: c.Created,
      };
    }));

    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET Docker host info
app.get('/api/info', async (req, res) => {
  try {
    const info = await docker.info();
    res.json({
      containers: info.Containers,
      running: info.ContainersRunning,
      stopped: info.ContainersStopped,
      images: info.Images,
      dockerVersion: info.ServerVersion,
      os: info.OperatingSystem,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET container logs
app.get('/api/containers/:id/logs', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const tail = parseInt(req.query.tail) || 200;
    const logs = await container.logs({ stdout: true, stderr: true, tail, timestamps: true });

    const lines = [];
    const buf = Buffer.isBuffer(logs) ? logs : Buffer.from(logs);
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const streamType = buf[offset];
      const size = buf.readUInt32BE(offset + 4);
      offset += 8;
      if (size === 0) continue;
      if (offset + size > buf.length) break;
      const line = buf.slice(offset, offset + size).toString('utf8');
      lines.push({ stream: streamType === 2 ? 'stderr' : 'stdout', line });
      offset += size;
    }

    res.json({ logs: lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST start / stop / restart / pause / unpause
app.post('/api/containers/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart', 'pause', 'unpause'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  try {
    const container = docker.getContainer(id);
    await container[action]();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback to frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

/* ──────────────────────────────────────────────────────────
   WEB TERMINAL (docker exec over WebSocket)
   Client connects to /ws/exec/:id, we detect a usable shell,
   attach an interactive exec, and pipe bytes both ways as
   base64 JSON frames. One exec process per WS connection.
   ────────────────────────────────────────────────────────── */

// Find a shell that actually exists in the container. Runs a throwaway
// non-interactive exec rather than assuming bash is present.
async function detectShell(container) {
  const probe = await container.exec({
    Cmd: ['sh', '-c', 'command -v bash || command -v sh || echo NONE'],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await probe.start({ hijack: true, Tty: false });
  const chunks = [];
  await new Promise((resolve, reject) => {
    container.modem.demuxStream(stream, { write: (c) => chunks.push(c) }, { write: (c) => chunks.push(c) });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const out = Buffer.concat(chunks).toString('utf8').trim().split('\n').pop().trim();
  return out === 'NONE' || !out ? null : out;
}

function wsSend(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const execStreams = new Map(); // ws -> exec duplex stream, for cleanup on disconnect

async function handleExecSocket(ws, containerId) {
  const container = docker.getContainer(containerId);
  let info;
  try {
    info = await container.inspect();
  } catch {
    wsSend(ws, { type: 'error', message: 'Container not found' });
    return ws.close(1008);
  }
  if (!info.State.Running) {
    wsSend(ws, { type: 'error', message: 'Container is not running' });
    return ws.close(1008);
  }

  let shell;
  try {
    shell = await detectShell(container);
  } catch (e) {
    wsSend(ws, { type: 'error', message: `Could not probe container: ${e.message}` });
    return ws.close(1011);
  }
  if (!shell) {
    wsSend(ws, { type: 'error', message: 'No shell (bash or sh) found in this container' });
    return ws.close(1008);
  }

  const exec = await container.exec({
    Cmd: [shell],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  execStreams.set(ws, stream);

  stream.on('data', (chunk) => wsSend(ws, { type: 'data', data: chunk.toString('base64') }));
  stream.on('error', () => ws.close(1011));
  stream.on('close', () => ws.close(1000));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'data') {
      stream.write(Buffer.from(msg.data, 'base64'));
    } else if (msg.type === 'resize') {
      exec.resize({ h: msg.rows, w: msg.cols }).catch(() => {});
    }
  });

  ws.on('close', () => {
    const s = execStreams.get(ws);
    if (s) { s.end(); s.destroy && s.destroy(); execStreams.delete(ws); }
  });
}

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
// noServer: 'path' on WebSocketServer only exact-matches; we need the
// container id as a suffix, so route the upgrade manually instead.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const match = /^\/ws\/exec\/([^/?]+)/.exec(req.url || '');
  if (!match) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, match[1]);
  });
});

wss.on('connection', (ws, req, containerId) => {
  handleExecSocket(ws, containerId).catch((e) => {
    wsSend(ws, { type: 'error', message: e.message });
    ws.close(1011);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log(`  Servedash v${VERSION}`);
  console.log(`  ────────────────────────────`);
  console.log(`  Port:                  ${PORT}`);
  console.log(`  Refresh interval:      ${REFRESH_INTERVAL > 0 ? REFRESH_INTERVAL + 's' : 'off (manual)'}`);
  console.log(`  Update check interval: ${UPDATE_CHECK_INTERVAL > 0 ? UPDATE_CHECK_INTERVAL + 'm' : 'off (manual)'}`);
  console.log(`  Data dir:              ${DATA_DIR}`);
  console.log(`  ────────────────────────────`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log('');
});
