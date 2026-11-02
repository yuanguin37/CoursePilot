#!/usr/bin/env node
/** 零依赖静态服务器：用于本地预览 demo/ 或手动注入脚本到目标页面 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const PORT = Number(process.env.PORT || 8123);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  const isDirectory = relative === '' || /[\\/]$/.test(relative);
  const target = join(ROOT, relative || 'demo');
  const file = isDirectory ? join(target, 'index.html') : target;

  if (!resolve(file).startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`CoursePilot demo: http://localhost:${PORT}/demo/`);
});
