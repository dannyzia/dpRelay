/**
 * One-off alert receiver for the ALERT_WEBHOOK_URL end-to-end proof.
 * Listens on 127.0.0.1:8787, appends every POST body as a JSON line to
 * staging/alerts-received.log. Never prints or stores the Bearer secret —
 * only whether an Authorization header was present.
 */
const http = require('node:http');
const { appendFileSync } = require('node:fs');

const LOG = '/home/zia/Documents/My Projects/Authenticator/staging/alerts-received.log';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const entry = {
      at: new Date().toISOString(),
      path: req.url,
      hadAuth: Boolean(req.headers.authorization),
      body: body.slice(0, 2000),
    };
    appendFileSync(LOG, JSON.stringify(entry) + '\n');
    console.log(`[receiver] ${entry.at} POST ${req.url} auth=${entry.hadAuth} bytes=${body.length}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

server.listen(8787, '127.0.0.1', () => {
  console.log('[receiver] listening on 127.0.0.1:8787, logging to staging/alerts-received.log');
});
