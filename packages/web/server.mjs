#!/usr/bin/env node
/**
 * Server for the HAR texture viewer.
 *
 * Static file serving + a POST /upload endpoint that accepts a raw .har body,
 * auto-detects the engine (cocos / pragmatic / slotmill / gameart), builds a tab
 * into the served directory, appends it to catalog.json, and returns the tab JSON
 * so the page can add it live.
 *
 * Usage:
 *   node packages/web/server.mjs [--dir path] [--port 8765] [--host 0.0.0.0]
 *   --host 127.0.0.1  仅本机
 *   --host 0.0.0.0    局域网可访问（默认）
 */
import { createServer } from 'http';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces, homedir } from 'os';
import {
  buildSlotmillTab,
  buildPragmaticTab,
  buildCocosTab,
  buildGameartTab,
  detectEngine,
  hydrateTabFromSignedUrls,
} from '../core/src/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const portIdx = args.indexOf('--port');
const hostIdx = args.indexOf('--host');
const ROOT = dirIdx >= 0 ? args[dirIdx + 1] : join(process.cwd(), 'dist', 'texture-viewer');
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 8765;
const HOST = hostIdx >= 0 ? args[hostIdx + 1] : '0.0.0.0';

function lanIPv4List() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' && info.family !== 4) continue;
      if (info.internal) continue;
      out.push(info.address);
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.atlas': 'text/plain; charset=utf-8',
  '.plist': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

const BUILDERS = {
  cocos: buildCocosTab,
  pragmatic: buildPragmaticTab,
  slotmill: buildSlotmillTab,
  gameart: buildGameartTab,
};

function safeId(name) {
  return (
    String(name)
      .replace(/\.har$/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `har-${Date.now()}`
  );
}

function loadCatalog() {
  const file = join(ROOT, 'catalog.json');
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* fall through */
    }
  }
  return { builtAt: new Date().toISOString(), tabs: [] };
}

function readBody(req, maxBytes = 800 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('HAR too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleUpload(req, res) {
  try {
    const buf = await readBody(req);
    const rawName = decodeURIComponent(req.headers['x-file-name'] ?? 'upload.har');
    let har;
    try {
      har = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new Error('无法解析为 HAR JSON');
    }
    const entries = har.log?.entries ?? [];
    if (!entries.length) throw new Error('HAR 中没有网络请求 (log.entries 为空)');

    const pageTitle = har.log?.pages?.[0]?.title ?? '';
    const detection = detectEngine(entries, pageTitle);

    const uploadsDir = join(ROOT, 'uploads');
    mkdirSync(uploadsDir, { recursive: true });
    let id = safeId(rawName);
    const catalog = loadCatalog();
    if (catalog.tabs.some((t) => t.id === id)) id = `${id}-${Date.now().toString(36)}`;

    const harPath = join(uploadsDir, `${id}.har`);
    writeFileSync(harPath, buf);

    const build = BUILDERS[detection.engine] ?? buildSlotmillTab;
    const src = {
      id,
      label: pageTitle?.split('?')[0]?.slice(0, 48) || rawName.replace(/\.har$/i, ''),
      type: detection.engine,
      har: harPath,
    };
    // Slotmill builder is async (may fetch missing .avif bodies)
    const built = build(harPath, ROOT, src);
    const tab = typeof built?.then === 'function' ? await built : built;
    tab.engineDetection = detection;

    // PG / 签名 CDN：禁止外链补拉（CORS / sign 策略）；只信 HAR 正文 + 本地 cdn-cache
    if (detection.engine === 'cocos' && typeof hydrateTabFromSignedUrls === 'function') {
      const remotes = (tab.textures || []).filter((t) => t.srcType === 'remote');
      const signedHeavy = remotes.filter((t) => /[?&]sign=/i.test(t.url || t.src || '')).length;
      if (signedHeavy > 0 && signedHeavy >= remotes.length * 0.5) {
        console.log(
          `CDN hydrate skipped: ${signedHeavy}/${remotes.length} remotes are signed (HAR-only policy)`
        );
      } else if (remotes.length) {
        try {
          const hyd = await hydrateTabFromSignedUrls(tab, ROOT, id, {
            concurrency: 8,
            timeoutMs: 15000,
          });
          if (hyd.fetched || hyd.failed) {
            console.log(
              `CDN hydrate: fetched=${hyd.fetched} failed=${hyd.failed} pending=${hyd.pending}`
            );
          }
        } catch (e) {
          console.warn('CDN hydrate skipped:', e?.message ?? e);
        }
      }
    }

    catalog.tabs.push(tab);
    catalog.builtAt = new Date().toISOString();
    writeFileSync(join(ROOT, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tab, detection }));
    console.log(
      `Upload: ${rawName} → ${detection.engine}` +
        (detection.cocosMajor != null ? `/${detection.cocosMajor}.x` : '') +
        ` (tab ${id}, ${tab.meta?.total ?? 0} textures, ` +
        `embedded=${tab.meta?.embedded ?? 0}, ` +
        `spine=${tab.animationManifest?.length ?? 0}, ` +
        `audio=${tab.audioManifest?.length ?? 0}, ` +
        `fonts=${tab.fontManifest?.length ?? 0})`
    );
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(err.message ?? err) }));
    console.error('Upload failed:', err.message ?? err);
  }
}

// The viewer app (html / vendor runtimes / 3.7 sub-player) is served from the
// package source; ROOT is purely a data directory (catalog.json, embedded/,
// animations/, uploads/) that can be deleted and rebuilt at any time.
const VIEWER_DIR = join(__dirname, 'viewer');

function resolveFile(urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\//, '');
  if (urlPath === '/' || urlPath === '/index.html') {
    return join(VIEWER_DIR, 'viewer.html');
  }
  // Cocos web-mobile shell (and its nested assets)
  if (rel === 'particle-player' || rel === 'particle-player/') {
    rel = 'particle-player/index.html';
  }

  // Prefer viewer app assets (html / vendor / players) from package source.
  // Allow any file under VIEWER_DIR so new players (spine4, …) don't need an
  // allowlist bump + server restart to be reachable.
  const appFile = join(VIEWER_DIR, rel);
  if (appFile.startsWith(VIEWER_DIR) && existsSync(appFile) && !statSync(appFile).isDirectory()) {
    return appFile;
  }

  const dataFile = join(ROOT, rel);
  if (dataFile.startsWith(ROOT) && existsSync(dataFile) && !statSync(dataFile).isDirectory()) {
    return dataFile;
  }
  return null;
}

function serveStatic(req, res) {
  const file = resolveFile(req.url.split('?')[0]);
  if (!file) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

const REPO_ROOT = join(__dirname, '..', '..');
const MINIGAME_DIR = join(REPO_ROOT, 'dist', 'minigame');

function sendJsonFile(res, file) {
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [] }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(readFileSync(file));
}

function wechatReanalyzePrompt() {
  const cacheDir = join(
    homedir(),
    'Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users',
  );
  const script = join(REPO_ROOT, 'tools/minigame/analyze-wechat.mjs');
  const catalog = join(ROOT, 'catalog.json');
  const embedded = join(ROOT, 'embedded');
  const audio = join(ROOT, 'audio');
  const index = join(MINIGAME_DIR, 'index.json');
  return `请更新本机已缓存的微信小游戏静态分析。查看器只读下面这些本地产物，不自己扫描。每个游戏单独一个来源，不要把多个游戏的资源放进同一个 tab。

只读微信缓存，不要改这个目录：
${cacheDir}

分析脚本：
${script}
执行：node ${script}

产物写到这些本地路径：
${catalog}
${embedded}/<游戏id>/
${audio}/<游戏id>/
${join(ROOT, 'animations')}/<游戏id>/
${join(ROOT, 'fonts')}/<游戏id>/
${index}
${join(MINIGAME_DIR, '<游戏id>.json')}

不要改微信缓存，不要把包写回去，不要把 game.js 全文贴进对话，不要自动发给 taxon，不要写入公网 Kura。
完成后对照 ${index}，说明新增或变化的游戏、包数量，以及每个来源里的纹理和音频数量。查看器刷新 http://127.0.0.1:${PORT}/ 即可。
`;
}

function serveMinigame(req, res) {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/wechat-reanalyze-prompt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(wechatReanalyzePrompt());
    return true;
  }
  if (urlPath === '/minigame' || urlPath === '/minigame.html') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return true;
  }
  if (urlPath === '/minigame/index.json') {
    sendJsonFile(res, join(MINIGAME_DIR, 'index.json'));
    return true;
  }
  const match = urlPath.match(/^\/minigame\/results\/([A-Za-z0-9._-]+)\.json$/);
  if (match) {
    sendJsonFile(res, join(MINIGAME_DIR, `${match[1]}.json`));
    return true;
  }
  return false;
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && serveMinigame(req, res)) return;
  if (req.method === 'POST' && req.url.split('?')[0] === '/upload') {
    handleUpload(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Texture viewer listening on ${HOST}:${PORT}`);
  console.log(`  本机:    http://127.0.0.1:${PORT}/`);
  for (const ip of lanIPv4List()) {
    console.log(`  局域网:  http://${ip}:${PORT}/`);
  }
  if (HOST === '127.0.0.1' || HOST === 'localhost') {
    console.log('（当前仅本机；局域网请用 --host 0.0.0.0）');
  } else {
    console.log('若同事打不开：检查 Windows 防火墙是否放行入站 TCP ' + PORT);
  }
  console.log(`Serving: ${ROOT}`);
  console.log('Upload a HAR: POST /upload (raw body, header x-file-name)');
  console.log('微信小游戏和 HAR 共用本页的来源标签');
});
