// Serves bench/fixture-app on a random localhost port, with Range support for
// video. Each variant ('ok' | 'bug') is served only under its own random
// per-start token path (/s/<token>/), so the served HTML/JS/CSS never names
// or otherwise reveals which variant an agent under test is looking at.
// app.js and styles.css are rendered per-request from templates plus the
// variant's snippets in variants.mjs (never served itself); index.html and
// clip.mp4 are served as static files, unchanged across variants.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { variants } from './variants.mjs';

const root = fileURLToPath(new URL('./fixture-app/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4' };

const templated = {
  '/app.js': { templateFile: 'app.template.js', contentType: 'text/javascript', render: renderAppJs },
  '/styles.css': { templateFile: 'styles.template.css', contentType: 'text/css', render: renderStylesCss },
};

function renderAppJs(template, variant) {
  return template
    .replace('{{LOAD_HANDLER}}', variant.loadHandler)
    .replace('{{PREVIEW_X}}', variant.previewX)
    .replace('{{CAPTIONS_SETUP}}', variant.captionsSetup)
    .replace('{{EMAIL_ID}}', variant.emailId);
}

function renderStylesCss(template, variant) {
  return template.replace('{{TOOLBAR_WRAP}}', variant.toolbarWrap);
}

// A single `bytes=` range → [start, end] inclusive, or null when unsatisfiable
// (start past the end, end beyond the file, start after end, empty suffix).
function parseRange(first, last, size) {
  let start;
  let end;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === '' ? size - 1 : Number(last);
  }
  if (start >= size || end >= size || start > end) return null;
  return [start, end];
}

export async function startFixture() {
  const tokens = { ok: randomBytes(4).toString('hex'), bug: randomBytes(4).toString('hex') };
  const tokenToVariant = new Map(Object.entries(tokens).map(([name, token]) => [token, name]));

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      console.error(`fixture server error: ${err?.message ?? err}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  async function handle(req, res) {
    const pathname = new URL(req.url, 'http://x').pathname;
    const match = /^\/s\/([0-9a-f]+)(\/.*)?$/.exec(pathname);
    if (!match) return res.writeHead(404).end();
    const variantName = tokenToVariant.get(match[1]);
    if (!variantName) return res.writeHead(404).end();

    const subpath = match[2] && match[2] !== '/' ? match[2] : '/index.html';
    const rendered = templated[subpath];
    if (rendered) {
      const templateFile = join(root, rendered.templateFile);
      let template;
      try {
        template = await readFile(templateFile, 'utf8');
      } catch {
        return res.writeHead(404).end();
      }
      const body = rendered.render(template, variants[variantName]);
      res.writeHead(200, { 'content-type': rendered.contentType, 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }

    const file = normalize(join(root, subpath));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    let info;
    try {
      info = await stat(file);
    } catch {
      return res.writeHead(404).end();
    }
    const type = types[extname(file)] ?? 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (req.headers.range) {
      const bounds = range && parseRange(range[1], range[2], info.size);
      if (!bounds) {
        return res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
      }
      const [start, end] = bounds;
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
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    urlFor: (variant) => `http://127.0.0.1:${port}/s/${tokens[variant]}/`,
    close: () => new Promise((r) => server.close(r)),
  };
}
