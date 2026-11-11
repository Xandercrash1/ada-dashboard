// Preview of the rebuilt Grimoire at /grimoire-next/ (Alex, 2026-11-10). The app runs on loopback
// and Caddy has no route for it, so the dashboard passes requests through. Signed-in admins only
// (that's Alex alone today); Grimoire then checks the same session itself through /api/me.
const http = require('http');

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function mountGrimoirePreview(app, { isAdminReq, target = process.env.GRIMOIRE_NEXT_URL || 'http://127.0.0.1:8889' }) {
  const t = new URL(target);
  app.use('/grimoire-next', (req, res) => {
    if (!isAdminReq(req) || !req.user || req.user.username === 'system') return res.status(404).send('Not found');
    if (req.originalUrl === '/grimoire-next') return res.redirect(301, '/grimoire-next/');
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    delete headers.forwarded; delete headers['x-real-ip'];
    Object.assign(headers, { 'x-forwarded-for': req.ip, 'x-forwarded-host': req.hostname, 'x-forwarded-prefix': '/grimoire-next', 'x-forwarded-proto': req.protocol });
    // express.json() has already read JSON bodies; send them on again.
    let body = null;
    if (req._body) {
      body = Buffer.from(JSON.stringify(req.body));
      headers['content-length'] = String(body.length);
      delete headers['transfer-encoding'];
    }
    const up = http.request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers }, (r) => {
      const out = { ...r.headers };
      for (const h of HOP_BY_HOP) delete out[h];
      delete out['set-cookie'];   // the app never sets cookies on the dashboard's origin
      res.writeHead(r.statusCode, out);
      r.pipe(res);
    });
    up.setTimeout(200000, () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'The Grimoire preview isn\'t running.' }); else res.end(); });
    if (body) up.end(body); else req.pipe(up);
  });
}

module.exports = { mountGrimoirePreview };
