// Serves bench/fixture-app on a random localhost port, with Range support for video.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./fixture-app/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4' };

export async function startFixture() {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    let info;
    try {
      info = await stat(file);
    } catch {
      return res.writeHead(404).end();
    }
    const type = types[extname(file)] ?? 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : info.size - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${info.size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'accept-ranges': 'bytes' });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => server.close(r)),
  };
}
