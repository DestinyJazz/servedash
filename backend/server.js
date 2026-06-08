const express = require('express');
const Docker = require('dockerode');
const cors = require('cors');
const path = require('path');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

// GET all containers with stats
app.get('/api/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });

    const details = await Promise.all(containers.map(async (c) => {
      let stats = null;
      let url = null;
      let port = null;

      const labels = c.Labels || {};

      // Custom URL from label takes priority
      if (labels['dashboard.url']) {
        url = labels['dashboard.url'];
      }

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

      return {
        id: c.Id.substring(0, 12),
        fullId: c.Id,
        name: c.Names[0].replace(/^\//, ''),
        image: c.Image,
        status: c.State,
        statusText: c.Status,
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

// POST start / stop / restart
app.post('/api/containers/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servedash running on port ${PORT}`);
});
