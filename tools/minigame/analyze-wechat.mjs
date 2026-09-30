#!/usr/bin/env node
/**
 * 扫描本机微信小游戏缓存，写出查看器要读的分析结果。
 * 只解密每个版本的主包，用来读配置和入口文件。不改微信目录。
 *
 *   node tools/minigame/analyze-wechat.mjs
 *   node tools/minigame/analyze-wechat.mjs --wxid wx0123456789abcdef
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decryptV1mmwx,
  inferWxid,
  isEncrypted,
  isPlainWxapkg,
  macScanRoots,
  unpackWxapkg,
} from './wxapkg.mjs';
import { decodeAstcToPng } from './astc-png.mjs';
import { recognizeCache } from './recognize-cache.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outRoot = path.join(repoRoot, 'dist', 'minigame');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return '';
  return process.argv[i + 1];
}

function walkFiles(root, { max = 4000 } = {}) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const stack = [root];
  while (stack.length && found.length < max) {
    const dir = stack.pop();
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (found.length >= max) break;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) found.push({ path: full, size: st.size, name });
    }
  }
  return found;
}

function gameGroups() {
  const groups = new Map();
  for (const root of macScanRoots()) {
    if (!root.includes(`${path.sep}applet`)) continue;
    for (const file of walkFiles(root, { max: 800 })) {
      if (!file.name.endsWith('.wxapkg')) continue;
      const parts = file.path.split(path.sep);
      const i = parts.lastIndexOf('packages');
      if (i < 0 || parts.length < i + 4) continue;
      const wxid = parts[i + 1];
      const version = parts[i + 2];
      if (!/^wx[0-9a-fA-F]{16}$/.test(wxid)) continue;
      const key = `${wxid}@${version}`;
      if (!groups.has(key)) {
        groups.set(key, { wxid, version, dir: path.dirname(file.path), packages: [] });
      }
      groups.get(key).packages.push(file);
    }
  }
  return [...groups.values()];
}

function readPlain(file, wxid) {
  const buf = fs.readFileSync(file.path);
  if (isPlainWxapkg(buf)) return { plain: buf, encrypted: false };
  if (!isEncrypted(buf)) {
    return { error: `无法识别的包头 ${buf.subarray(0, 6).toString('hex')}` };
  }
  try {
    return { plain: decryptV1mmwx(buf, wxid || inferWxid(file.path)), encrypted: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function pickMain(packages) {
  const prefer = ['__WITHOUT_MULTI_PLUGINCODE__.wxapkg', '__APP__.wxapkg'];
  for (const name of prefer) {
    const hit = packages.find((p) => p.name === name);
    if (hit) return hit;
  }
  const rest = packages.filter((p) => !/_wasmcode/.test(p.name));
  rest.sort((a, b) => b.size - a.size);
  return rest[0] || packages[0];
}

function countHits(text, words) {
  const hits = {};
  for (const word of words) hits[word] = text.split(word).length - 1;
  return hits;
}

function declaredPkgName(root) {
  const segs = String(root).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (!segs.length) return '';
  return `_${segs.join('_')}_.wxapkg`;
}

function streamingSummary(appletDir, wxid) {
  const root = path.join(appletDir, 'local', wxid, 'usr', '__GAME_FILE_CACHE', 'StreamingAssets');
  if (!fs.existsSync(root)) return { present: false, bundles: 0, groups: [] };
  const files = walkFiles(root, { max: 5000 });
  const bundles = files.filter((f) => f.name.endsWith('.bundle'));
  const groups = new Map();
  for (const file of bundles) {
    const rel = path.relative(root, file.path);
    const group = rel.split(path.sep)[0] || '(root)';
    groups.set(group, (groups.get(group) || 0) + 1);
  }
  return {
    present: true,
    bundles: bundles.length,
    scannedFiles: files.length,
    groups: [...groups.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => ({ name, count })),
  };
}

function analyzeGroup(group) {
  const names = new Set(group.packages.map((p) => p.name));
  const main = pickMain(group.packages);
  const opened = readPlain(main, group.wxid);
  let config = null;
  let configName = '';
  let entries = [];
  let fileTree = [];
  let hits = {};
  if (opened.plain) {
    let unpacked = [];
    try {
      unpacked = unpackWxapkg(opened.plain);
    } catch (e) {
      opened.error = e instanceof Error ? e.message : String(e);
    }
    fileTree = unpacked.slice(0, 400).map((f) => ({
      path: f.name.replace(/^[/\\]+/, ''),
      size: f.data.length,
    }));
    const meta = unpacked.find((f) => /(^|[/\\])(app-config\.json|game\.json)$/.test(f.name));
    if (meta) {
      configName = meta.name.replace(/^[/\\]+/, '');
      try {
        config = JSON.parse(meta.data.toString('utf8'));
      } catch {
        config = null;
      }
    }
    const gameJs = unpacked.find((f) => /(^|[/\\])game\.js$/.test(f.name));
    if (gameJs) {
      hits = countHits(gameJs.data.toString('utf8'), [
        'Cocos', 'cocos', 'cc.game', 'Unity', 'unity', 'WXWebAssembly',
      ]);
    }
    const entryNames = ['game.js', 'workers.js', 'subContext.js', 'app-config.json', 'game.json'];
    entries = unpacked
      .filter((f) => entryNames.some((n) => f.name.replace(/^[/\\]+/, '') === n || f.name.endsWith(`/${n}`)))
      .map((f) => ({ path: f.name.replace(/^[/\\]+/, ''), size: f.data.length }));
  }

  const declared = Array.isArray(config?.subPackages) ? config.subPackages : [];
  const declaredFiles = declared.map((s) => declaredPkgName(s.root || ''));
  const missing = declared
    .filter((_, i) => declaredFiles[i] && !names.has(declaredFiles[i]))
    .map((s) => s.name || s.root);
  const known = new Set(declaredFiles);
  known.add(main.name);
  const extra = group.packages
    .map((p) => p.name)
    .filter((n) => !known.has(n) && !/_wasmcode|_framework_|__PLUGINCODE__|__WITHOUT_/.test(n));

  const hasUnityName = [...names].some((n) => /Unity|wasmcode/i.test(n));
  const hasCocosName = [...names].some((n) => /Cocos|cocos/i.test(n));
  const jsUnity = (hits.Unity || 0) + (hits.unity || 0);
  const jsCocos = (hits.Cocos || 0) + (hits.cocos || 0) + (hits['cc.game'] || 0);
  let engine = 'unknown';
  if ((hasUnityName || jsUnity > 0) && (hasCocosName || jsCocos > 0)) engine = 'unity+cocos';
  else if (hasUnityName || jsUnity > 0) engine = 'unity';
  else if (hasCocosName || jsCocos > 0) engine = 'cocos';

  const appletDir = path.resolve(group.dir, '..', '..', '..');
  const id = `${group.wxid}-${group.version}`;
  return {
    kind: 'wechat-minigame-analysis',
    id,
    label: `${group.wxid} @ ${group.version}`,
    wxid: group.wxid,
    version: group.version,
    analyzedAt: new Date().toISOString(),
    overview: {
      engine,
      deviceOrientation: config?.deviceOrientation || '',
      packageCount: group.packages.length,
      encryptedPackages: group.packages.filter((p) => {
        const head = Buffer.alloc(6);
        const fd = fs.openSync(p.path, 'r');
        fs.readSync(fd, head, 0, 6, 0);
        fs.closeSync(fd);
        return head.toString() === 'V1MMWX';
      }).length,
      subpackagesDeclared: declared.length,
      mainPackage: main.name,
      mainError: opened.error || '',
    },
    packages: group.packages
      .sort((a, b) => b.size - a.size)
      .map((p) => ({ name: p.name, size: p.size })),
    files: fileTree,
    analysis: {
      engine: {
        conclusion: engine,
        filenameHits: { unity: hasUnityName, cocos: hasCocosName },
        mainScriptHits: hits,
      },
      subpackages: {
        declared: declared.length,
        missing: missing.slice(0, 80),
        extra: extra.slice(0, 80),
      },
      entries,
      unityCache: streamingSummary(appletDir, group.wxid),
    },
    taxonHint: null,
  };
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac']);

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function imageMagicOk(buf, ext) {
  if (ext === '.png') return buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50;
  if (ext === '.jpg' || ext === '.jpeg') return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
  if (ext === '.gif') return buf.length > 10 && buf.subarray(0, 4).toString() === 'GIF8';
  if (ext === '.webp') return buf.length > 16 && buf.subarray(0, 4).toString() === 'RIFF';
  return false;
}

function imageDimensions(buf, ext) {
  if (ext === '.png' && buf.length >= 24) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if ((ext === '.jpg' || ext === '.jpeg') && buf[0] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      if (i + 3 >= buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  if (ext === '.gif' && buf.length >= 10) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (ext === '.webp' && buf.length >= 30 && buf.toString('ascii', 12, 16) === 'VP8X') {
    return {
      w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
      h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
    };
  }
  return null;
}

function mimeOf(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a' || ext === '.aac') return 'audio/mp4';
  return 'application/octet-stream';
}

function uuidFromBase(base) {
  const id = String(base || '').split('.')[0];
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : '';
}

function cacheCategory(name) {
  const dir = path.posix.dirname(String(name));
  if (!dir || dir === '.') return 'gamecache';
  return dir.split('/')[0];
}

function categoryOf(name) {
  const parts = String(name).replace(/^[/\\]+/, '').split(/[/\\]/).filter(Boolean);
  if (parts[0] === 'assets' && parts[1]) return parts[1];
  return parts[0] || 'root';
}

function parsePlistAtlas(xml) {
  const tex =
    xml.match(/<key>realTextureFileName<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ||
    xml.match(/<key>textureFileName<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!tex) return null;
  const frames = [];
  const re = /<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  let match;
  while ((match = re.exec(xml))) {
    const body = match[2];
    const frame = body.match(
      /<key>frame<\/key>\s*<string>\{\{(-?\d+),\s*(-?\d+)\},\s*\{(\d+),\s*(\d+)\}\}<\/string>/,
    );
    if (!frame) continue;
    frames.push({
      name: match[1],
      x: Number(frame[1]),
      y: Number(frame[2]),
      width: Number(frame[3]),
      height: Number(frame[4]),
      rotated: /<key>rotated<\/key>\s*<true\s*\/>/.test(body),
    });
  }
  return frames.length ? { texture: path.basename(tex), frames } : null;
}

function safeFileName(name, index) {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return `${String(index).padStart(3, '0')}-${base}`;
}

function keepCacheJson(text) {
  return text.includes('"rect"')
    || text.includes('fontDefDictionary')
    || text.includes('sp.SkeletonData')
    || (text.includes('"uuids"') && text.includes('"paths"'));
}

async function collectPackageFiles(group) {
  const images = [];
  const audio = [];
  const atlases = [];
  const docs = [];
  for (const file of group.packages) {
    if (/_wasmcode/.test(file.name)) continue;
    const opened = readPlain(file, group.wxid);
    if (!opened.plain) continue;
    let unpacked = [];
    try {
      unpacked = unpackWxapkg(opened.plain);
    } catch {
      continue;
    }
    for (const entry of unpacked) {
      const ext = path.extname(entry.name).toLowerCase();
      const rel = entry.name.replace(/^[/\\]+/, '');
      if (IMAGE_EXT.has(ext) && imageMagicOk(entry.data, ext)) {
        images.push({ name: rel, ext, data: entry.data, packageName: file.name, uuid: '' });
      } else if (AUDIO_EXT.has(ext) && entry.data.length > 64) {
        audio.push({ name: rel, ext, data: entry.data, packageName: file.name, uuid: '' });
      } else if (ext === '.plist' && entry.data.length < 2_000_000) {
        const atlas = parsePlistAtlas(entry.data.toString('utf8'));
        if (atlas) atlases.push(atlas);
      } else if (ext === '.json' && entry.data.length < 4_000_000) {
        const text = entry.data.toString('utf8');
        if (keepCacheJson(text)) docs.push({ rel, text });
      }
    }
  }
  const cacheRoot = path.resolve(group.dir, '..', '..', '..', 'local', group.wxid, 'usr', 'gamecaches');
  let astcCount = 0;
  let astcDecoded = 0;
  if (fs.existsSync(cacheRoot)) {
    const names = cacheOriginalNames(cacheRoot);
    for (const file of walkFiles(cacheRoot, { max: 8000 })) {
      const ext = path.extname(file.name).toLowerCase();
      const rel = path.relative(cacheRoot, file.path);
      const relPosix = rel.split(path.sep).join('/');
      const original = names.get(relPosix);
      const bundle = path.posix.dirname(relPosix);
      const display = original
        ? (bundle && bundle !== '.' ? `${bundle}/${original}` : original)
        : relPosix;
      const uuid = uuidFromBase(original || path.posix.basename(display));
      if (ext === '.astc') {
        const decoded = await decodeAstcToPng(fs.readFileSync(file.path));
        if (!decoded) {
          astcCount += 1;
          continue;
        }
        astcDecoded += 1;
        images.push({
          name: display.replace(/\.astc$/i, '.png'),
          ext: '.png',
          data: decoded.png,
          packageName: 'gamecache',
          uuid,
          width: decoded.width,
          height: decoded.height,
          codec: 'astc',
        });
        continue;
      }
      if (ext === '.json' && file.name !== 'cacheList.json' && file.size < 4_000_000) {
        const text = fs.readFileSync(file.path, 'utf8');
        if (keepCacheJson(text)) docs.push({ rel: relPosix, text });
        continue;
      }
      if (IMAGE_EXT.has(ext)) {
        const data = fs.readFileSync(file.path);
        if (!imageMagicOk(data, ext)) continue;
        images.push({ name: display, ext, data, packageName: 'gamecache', uuid });
      } else if (AUDIO_EXT.has(ext) && file.size > 64) {
        audio.push({
          name: display,
          ext,
          data: fs.readFileSync(file.path),
          packageName: 'gamecache',
          uuid,
        });
      }
    }
  }
  const iconDir = path.resolve(group.dir, '..', '..', '..', 'icon');
  if (fs.existsSync(iconDir)) {
    for (const name of fs.readdirSync(iconDir)) {
      if (!name.startsWith(group.wxid) || !IMAGE_EXT.has(path.extname(name).toLowerCase())) continue;
      const data = fs.readFileSync(path.join(iconDir, name));
      const ext = path.extname(name).toLowerCase();
      if (imageMagicOk(data, ext)) {
        images.unshift({ name: `icon/${name}`, ext, data, packageName: 'icon', uuid: '' });
      }
    }
  }
  return { images, audio, atlases, astcCount, astcDecoded, docs };
}

function cacheOriginalNames(cacheRoot) {
  const map = new Map();
  const listPath = path.join(cacheRoot, 'cacheList.json');
  if (!fs.existsSync(listPath)) return map;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  } catch {
    return map;
  }
  const files = parsed.files || {};
  for (const [remote, info] of Object.entries(files)) {
    const local = String(info?.url || '').replace(/^wxfile:\/\/usr\/gamecaches\//, '');
    if (!local) continue;
    let base = '';
    try {
      base = path.posix.basename(new URL(remote).pathname);
    } catch {
      base = path.posix.basename(remote);
    }
    if (base) map.set(local, base);
  }
  return map;
}

async function publishViewerTabs(groups) {
  const viewerRoot = path.join(repoRoot, 'dist', 'texture-viewer');
  const catalogPath = path.join(viewerRoot, 'catalog.json');
  fs.mkdirSync(viewerRoot, { recursive: true });
  let catalog = { builtAt: new Date().toISOString(), tabs: [] };
  if (fs.existsSync(catalogPath)) {
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    } catch {
      catalog = { builtAt: new Date().toISOString(), tabs: [] };
    }
  }
  const refreshing = new Set(groups.map((group) => `${group.wxid}-${group.version}`));
  const kept = (catalog.tabs || []).filter((tab) => (
    tab.meta?.container !== 'wechat' || !refreshing.has(tab.id)
  ));
  const fresh = [];
  for (const group of groups) {
    const { images, audio, atlases, astcCount, astcDecoded, docs } = await collectPackageFiles(group);
    const pluginOnly = group.packages.every((file) => /PLUGINCODE/.test(file.name));
    if (pluginOnly && !images.length && !audio.length) continue;
    const id = `${group.wxid}-${group.version}`;
    const embeddedDir = path.join(viewerRoot, 'embedded', id);
    const audioDir = path.join(viewerRoot, 'audio', id);
    fs.rmSync(embeddedDir, { recursive: true, force: true });
    fs.rmSync(audioDir, { recursive: true, force: true });
    fs.mkdirSync(embeddedDir, { recursive: true });

    const framesByTexture = new Map();
    for (const atlas of atlases) {
      const key = atlas.texture.toLowerCase();
      const prev = framesByTexture.get(key) || [];
      framesByTexture.set(key, prev.concat(atlas.frames));
    }

    const textures = images.map((image, index) => {
      const fileName = safeFileName(image.name, index);
      fs.writeFileSync(path.join(embeddedDir, fileName), image.data);
      const dim = image.width && image.height
        ? { w: image.width, h: image.height }
        : imageDimensions(image.data, image.ext);
      const frames = framesByTexture.get(path.basename(image.name).toLowerCase()) || [];
      const src = `embedded/${id}/${fileName}`;
      return {
        id: index,
        url: src,
        path: image.name,
        fileName: path.basename(image.name),
        ext: image.ext,
        mime: mimeOf(image.ext),
        size: image.data.length,
        sizeFmt: fmtSize(image.data.length),
        category: image.packageName === 'icon'
          ? 'icon'
          : image.packageName === 'gamecache'
            ? cacheCategory(image.name)
            : categoryOf(image.name),
        src,
        srcType: 'embedded',
        width: dim?.w ?? null,
        height: dim?.h ?? null,
        vramBytes: dim ? dim.w * dim.h * 4 : 0,
        uuid: image.uuid || '',
        source: image.codec === 'astc'
          ? 'astc'
          : image.packageName === 'gamecache'
            ? 'gamecache'
            : 'wxapkg',
        resourceType: frames.length > 1 ? 'sprite-atlas' : 'static',
        ...(frames.length ? { frames, atlasFrameCount: frames.length } : {}),
      };
    });
    textures.sort((a, b) => b.size - a.size);
    const recognized = recognizeCache({
      viewerRoot,
      tabId: id,
      docs,
      textures,
      audio,
    });

    const audioManifest = [];
    if (audio.length) fs.mkdirSync(audioDir, { recursive: true });
    audio.forEach((clip, index) => {
      const itemId = safeFileName(clip.name, index).replace(/\.[^.]+$/, '');
      const dir = path.join(audioDir, itemId);
      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${itemId}${clip.ext}`;
      fs.writeFileSync(path.join(dir, fileName), clip.data);
      audioManifest.push({
        id: itemId,
        kind: 'audioNative',
        name: path.basename(clip.name, clip.ext),
        uuid: null,
        duration: null,
        ext: clip.ext,
        mime: mimeOf(clip.ext),
        size: clip.data.length,
        sizeFmt: fmtSize(clip.data.length),
        url: null,
        importUrl: null,
        audioUrl: `audio/${id}/${itemId}/${fileName}`,
      });
    });

    const vramBytes = textures.reduce((sum, tex) => sum + (tex.vramBytes || 0), 0);
    fresh.push({
      id,
      label: `${group.wxid.slice(0, 10)}@${group.version}`,
      wxid: group.wxid,
      version: group.version,
      meta: {
        container: 'wechat',
        engine: '微信小游戏',
        summary: `${group.wxid} @ ${group.version}`,
        builtAt: new Date().toISOString(),
        total: textures.length,
        embedded: textures.length,
        remote: 0,
        missing: 0,
        vramBytes,
        vramFmt: fmtSize(vramBytes),
        audioCount: audioManifest.length,
        astcCount: astcCount || 0,
        astcDecoded: astcDecoded || 0,
        previewCount: recognized.animationManifest.length,
        fontCount: recognized.fontManifest.length,
        spineCount: recognized.animationManifest.filter((item) => String(item.type).startsWith('spine')).length,
        particleCount: 0,
      },
      textures,
      animationManifest: recognized.animationManifest,
      fontManifest: recognized.fontManifest,
      particleManifest: [],
      audioManifest,
      categories: [...new Set(textures.map((tex) => tex.category))].sort(),
      extensions: [...new Set(textures.map((tex) => tex.ext))].sort(),
      resourceTypes: [...new Set(textures.map((tex) => tex.resourceType))].sort(),
    });
    const sequences = recognized.animationManifest.filter((item) => item.type === 'sprite-sequence').length;
    console.log(
      `${id}  textures=${textures.length}  audio=${audioManifest.length}`
      + `  astcDecoded=${astcDecoded || 0}  astcLeft=${astcCount || 0}`
      + `  sequences=${sequences}  fonts=${recognized.fontManifest.length}`
      + `  spine=${recognized.animationManifest.filter((item) => String(item.type).startsWith('spine')).length}`
      + `  audioNamed=${recognized.audioRenamed}`,
    );
  }

  catalog.tabs = [...fresh, ...kept];
  catalog.builtAt = new Date().toISOString();
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  console.log(`catalog → ${catalogPath}  wechat tabs=${fresh.length}`);
}

const only = argValue('--wxid');
const groups = gameGroups().filter((g) => !only || g.wxid === only);
fs.mkdirSync(outRoot, { recursive: true });
const index = [];
for (const group of groups) {
  const result = analyzeGroup(group);
  fs.writeFileSync(
    path.join(outRoot, `${result.id}.json`),
    JSON.stringify(result, null, 2),
  );
  index.push({
    id: result.id,
    label: result.label,
    wxid: result.wxid,
    version: result.version,
    engine: result.overview.engine,
    packageCount: result.overview.packageCount,
  });
  console.log(`${result.id}  engine=${result.overview.engine}  packages=${result.overview.packageCount}`);
}
fs.writeFileSync(
  path.join(outRoot, 'index.json'),
  JSON.stringify({ analyzedAt: new Date().toISOString(), results: index }, null, 2),
);
console.log(`wrote ${index.length} result(s) → ${outRoot}`);
const engineById = new Map(index.map((item) => [item.id, item.engine]));
await publishViewerTabs(groups);
{
  const catalogPath = path.join(repoRoot, 'dist', 'texture-viewer', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  for (const tab of catalog.tabs) {
    if (tab.meta?.container !== 'wechat') continue;
    const engine = engineById.get(tab.id);
    if (engine && engine !== 'unknown') tab.meta.engine = `微信小游戏 · ${engine}`;
  }
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
}
