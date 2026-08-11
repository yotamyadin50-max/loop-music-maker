const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 8444;
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${port}`);
  let urlPath = decodeURIComponent(urlObj.pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, urlPath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(port, () => console.log('serving on ' + port));
