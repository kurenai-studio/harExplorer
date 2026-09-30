/**
 * Recognize Cocos cache JSON the same way the HAR pipeline does:
 * sprite-atlas / sequence frames, Spine skeleton+atlas, bitmap fonts,
 * and friendly audio names from bundle configs.
 *
 * Spine is emitted only when a file actually contains skeleton JSON and atlas text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectSequenceGroups } from '../../packages/core/src/engines/cocos/extract-animations.mjs';
import {
  classifySpinePackType,
  extractAllSpineBlobs,
  matchTexturesToAtlasPages,
  normalizeSkeletonJsonForRuntime,
  parseAtlasPages,
} from '../../packages/core/src/engines/cocos/spine-extract.mjs';
import {
  extractBitmapFonts,
  fntConfigToBmFont,
  fontAtlasExtent,
  glyphPreview,
} from '../../packages/core/src/engines/cocos/bitmap-font.mjs';
import { decompressCocosUuid } from '../../packages/core/src/engines/cocos/cocos-uuid.mjs';

const FRAME_RE =
  /"name":"([^"]+)"[^}]*"rect":\{"x":(-?\d+),"y":(-?\d+),"width":(\d+),"height":(\d+)\}/g;

function safeAnimId(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'item';
}

function leadingUuids(text) {
  const head = text.match(/^\s*\[\s*\d+\s*,\s*\[([\s\S]*?)\]/);
  if (!head) return [];
  const ids = [];
  for (const raw of head[1].matchAll(/"([^"]+)"/g)) {
    const decoded = decompressCocosUuid(raw[1]);
    if (decoded && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(decoded)) ids.push(decoded.toLowerCase());
  }
  return ids;
}

function extractFrames(text) {
  const frames = [];
  FRAME_RE.lastIndex = 0;
  let match;
  while ((match = FRAME_RE.exec(text))) {
    const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 180);
    frames.push({
      name: match[1],
      x: Number(match[2]),
      y: Number(match[3]),
      width: Number(match[4]),
      height: Number(match[5]),
      rotated: /"rotated"\s*:\s*true/.test(tail),
    });
  }
  return frames;
}

function frameExtent(frames) {
  let w = 0;
  let h = 0;
  for (const frame of frames) {
    w = Math.max(w, frame.x + frame.width);
    h = Math.max(h, frame.y + frame.height);
  }
  return { w, h };
}

function tidySequenceGroups(frames) {
  const groups = detectSequenceGroups(frames.map((frame) => frame.name));
  const merged = new Map();
  for (const group of groups) {
    const prefix = group.prefix.replace(/[-_ ]+$/, '') || group.prefix;
    const prev = merged.get(prefix);
    if (!prev) {
      merged.set(prefix, { prefix, count: group.frames.length, frames: [...group.frames] });
      continue;
    }
    const names = new Set(prev.frames);
    for (const name of group.frames) names.add(name);
    prev.frames = [...names];
    prev.count = prev.frames.length;
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}

function textureByUuid(textures, uuid) {
  const low = String(uuid || '').toLowerCase();
  if (!low) return null;
  return textures.find((tex) => tex.uuid === low) ?? null;
}

function bundleOf(rel) {
  const dir = path.posix.dirname(String(rel));
  if (!dir || dir === '.') return 'gamecache';
  return dir.split('/')[0];
}

function matchFrameTexture(rel, frames, uuids, textures) {
  const need = frameExtent(frames);
  for (const uuid of uuids) {
    const tex = textureByUuid(textures, uuid);
    if (!tex?.width || !tex?.height) continue;
    if (tex.width + 2 >= need.w && tex.height + 2 >= need.h) return tex;
  }
  const bundle = bundleOf(rel);
  let best = null;
  let bestArea = Infinity;
  for (const tex of textures) {
    if (!tex.width || !tex.height) continue;
    if (tex.category !== bundle) continue;
    if (tex.width + 2 < need.w || tex.height + 2 < need.h) continue;
    const area = tex.width * tex.height;
    if (area < bestArea) {
      best = tex;
      bestArea = area;
    }
  }
  return best;
}

function parseSpineRegions(atlasText) {
  const text = String(atlasText || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  const lines = text.split('\n');
  const regions = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || line.startsWith(' ') || line.startsWith('\t') || trimmed.includes(':') || /\.(png|jpg|webp)$/i.test(trimmed)) {
      i += 1;
      continue;
    }
    const region = { name: trimmed, rotate: false, x: 0, y: 0, width: 0, height: 0, origW: 0, origH: 0 };
    i += 1;
    while (i < lines.length && (lines[i].startsWith(' ') || lines[i].startsWith('\t'))) {
      const prop = lines[i].trim();
      const rotated = prop.match(/^rotate:\s*(true|false)/i);
      const xy = prop.match(/^xy:\s*(\d+)\s*,\s*(\d+)/);
      const size = prop.match(/^size:\s*(\d+)\s*,\s*(\d+)/);
      const orig = prop.match(/^orig:\s*(\d+)\s*,\s*(\d+)/);
      if (rotated) region.rotate = rotated[1].toLowerCase() === 'true';
      if (xy) {
        region.x = Number(xy[1]);
        region.y = Number(xy[2]);
      }
      if (size) {
        region.width = Number(size[1]);
        region.height = Number(size[2]);
      }
      if (orig) {
        region.origW = Number(orig[1]);
        region.origH = Number(orig[2]);
      }
      i += 1;
    }
    if (region.width > 0) regions[region.name] = region;
  }
  return regions;
}

function regionsFromFrames(frames) {
  const regions = {};
  for (const frame of frames) {
    regions[frame.name] = {
      name: frame.name,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      rotate: !!frame.rotated,
      origW: frame.width,
      origH: frame.height,
    };
  }
  return regions;
}

function attachFrames(tex, frames, sequenceGroups) {
  const prev = Array.isArray(tex.frames) ? tex.frames : [];
  const seen = new Set(prev.map((frame) => frame.name));
  const merged = prev.slice();
  for (const frame of frames) {
    if (seen.has(frame.name)) continue;
    seen.add(frame.name);
    merged.push(frame);
  }
  tex.frames = merged;
  tex.atlasFrameCount = merged.length;
  const seq = sequenceGroups[0];
  if (seq) {
    tex.resourceType = 'sprite-sequence';
    tex.sequencePrefix = seq.prefix;
    tex.sequenceFrameCount = Math.max(tex.sequenceFrameCount || 0, seq.count);
  } else if (merged.length > 1) {
    tex.resourceType = 'sprite-atlas';
  }
}

function audioNameIndex(docs) {
  const names = new Map();
  for (const doc of docs) {
    if (!doc.text.includes('"uuids"') || !doc.text.includes('"paths"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(doc.text);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.uuids) || !parsed.paths || typeof parsed.paths !== 'object') continue;
    for (const [idx, entry] of Object.entries(parsed.paths)) {
      const label = Array.isArray(entry) ? entry[0] : null;
      const compressed = parsed.uuids[Number(idx)];
      if (!label || !compressed) continue;
      const uuid = decompressCocosUuid(String(compressed));
      if (!uuid || !/^[0-9a-f]{8}-/i.test(uuid)) continue;
      const base = String(label).split('/').filter(Boolean).pop();
      if (base) names.set(uuid.toLowerCase(), base);
    }
  }
  return names;
}

function applyAudioNames(audio, names) {
  let renamed = 0;
  for (const clip of audio) {
    if (!clip.uuid || !names.has(clip.uuid)) continue;
    const friendly = names.get(clip.uuid);
    const dir = path.posix.dirname(String(clip.name).split(path.sep).join('/'));
    clip.name = dir && dir !== '.' ? `${dir}/${friendly}${clip.ext}` : `${friendly}${clip.ext}`;
    renamed += 1;
  }
  return renamed;
}

function matchFontTexture(font, text, textures) {
  for (const uuid of leadingUuids(text)) {
    const tex = textureByUuid(textures, uuid);
    if (tex) return tex;
  }
  const atlas = String(font.fntConfig?.atlasName || '').toLowerCase();
  if (atlas) {
    const byName = textures.find((tex) => {
      const file = String(tex.fileName || '').toLowerCase();
      const base = path.posix.basename(String(tex.path || '')).toLowerCase();
      return file === atlas || base === atlas;
    });
    if (byName) return byName;
  }
  const need = fontAtlasExtent(font.fntConfig);
  let best = null;
  let bestScore = Infinity;
  for (const tex of textures) {
    if (!tex.width || !tex.height) continue;
    if (tex.width < need.w - 2 || tex.height < need.h - 2) continue;
    const dw = tex.width - need.w;
    const dh = tex.height - need.h;
    if (dw > 64 || dh > 64) continue;
    const score = dw + dh;
    if (score < bestScore) {
      bestScore = score;
      best = tex;
    }
  }
  return best;
}

function writeSpineFiles(viewerRoot, tabId, id, pack) {
  const dir = path.join(viewerRoot, 'animations', tabId, id);
  const relBase = `animations/${tabId}/${id}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skeleton.json'),
    JSON.stringify(normalizeSkeletonJsonForRuntime(pack.skeletonJson)),
  );
  fs.writeFileSync(path.join(dir, 'skeleton.atlas'), pack.atlasText);
  const pageUrls = {};
  const missingPages = [];
  for (const page of parseAtlasPages(pack.atlasText)) {
    const hit = pack.texturePages?.[page.page];
    const src = hit?.textureSrc || (parseAtlasPages(pack.atlasText).length === 1 ? pack.textureSrc : '');
    if (!src) {
      missingPages.push(page.page);
      continue;
    }
    const abs = path.join(viewerRoot, src);
    if (!fs.existsSync(abs)) {
      missingPages.push(page.page);
      continue;
    }
    fs.writeFileSync(path.join(dir, page.page), fs.readFileSync(abs));
    pageUrls[page.page] = `${relBase}/${page.page}`;
  }
  return {
    skelUrl: `${relBase}/skeleton.json`,
    atlasUrl: `${relBase}/skeleton.atlas`,
    pageUrls,
    missingPages,
  };
}

/**
 * Mutates textures (frames / resourceType) and audio names.
 * Writes animations/<tabId>/ and fonts/<tabId>/.
 */
export function recognizeCache({ viewerRoot, tabId, docs, textures, audio }) {
  const animationPacks = [];
  const fontDocs = [];
  const seenAnim = new Set();

  for (const doc of docs) {
    const bundle = bundleOf(doc.rel);
    const uuids = leadingUuids(doc.text);

    if (doc.text.includes('fontDefDictionary')) {
      fontDocs.push(doc);
      continue;
    }

    if (doc.text.includes('sp.SkeletonData') && doc.text.includes('{"skeleton"')) {
      const blobs = extractAllSpineBlobs(doc.text, `https://local/import/${doc.rel}`);
      for (const blob of blobs) {
        if (!blob.skeletonJson || !blob.atlasText) continue;
        const pages = blob.atlasPages?.length ? blob.atlasPages : parseAtlasPages(blob.atlasText);
        const { matched } = matchTexturesToAtlasPages(pages, textures, new Set(), blob.textureUuids || []);
        const texturePages = matched;
        const first = Object.values(texturePages)[0] || null;
        if (!first?.textureSrc && !Object.keys(texturePages).length) continue;
        const regionMap = parseSpineRegions(blob.atlasText);
        const regionNames = Object.keys(regionMap);
        const sequenceGroups = tidySequenceGroups(regionNames.map((name) => ({ name })));
        const type = classifySpinePackType(blob.skeletonJson, sequenceGroups, regionNames.length);
        const id = safeAnimId(`${bundle}-${blob.name}`);
        if (seenAnim.has(id)) continue;
        seenAnim.add(id);
        const animNames = Object.keys(blob.skeletonJson.animations ?? {});
        animationPacks.push({
          id,
          type,
          name: blob.name,
          importUrl: doc.rel,
          bundle,
          textureSrc: first?.textureSrc ?? null,
          textureUrl: first?.textureUrl ?? null,
          textureFileName: first?.textureFileName ?? null,
          width: blob.atlasMeta?.width || pages[0]?.width || first?.width || null,
          height: blob.atlasMeta?.height || pages[0]?.height || first?.height || null,
          regionCount: regionNames.length,
          sequenceGroups,
          animationNames: animNames,
          defaultAnimation: animNames[0] ?? null,
          spineVersion: blob.skeletonJson.skeleton?.spine ?? null,
          regions: regionMap,
          atlasText: blob.atlasText,
          skeletonJson: blob.skeletonJson,
          texturePages,
        });
      }
      if (blobs.length) continue;
    }

    if (!doc.text.includes('"rect"') || !doc.text.includes('"name"')) continue;
    const frames = extractFrames(doc.text);
    if (frames.length < 3) continue;
    const tex = matchFrameTexture(doc.rel, frames, uuids, textures);
    if (!tex) continue;
    const sequenceGroups = tidySequenceGroups(frames);
    attachFrames(tex, frames, sequenceGroups);
    const id = safeAnimId(doc.rel.replace(/\.[^.]+$/, ''));
    if (seenAnim.has(id)) continue;
    seenAnim.add(id);
    const type = sequenceGroups.length ? 'sprite-sequence' : 'sprite-atlas';
    animationPacks.push({
      id,
      type,
      name: doc.rel,
      importUrl: doc.rel,
      bundle,
      textureSrc: tex.src,
      textureUrl: tex.url,
      textureFileName: tex.fileName,
      width: tex.width,
      height: tex.height,
      regionCount: frames.length,
      frameCount: frames.length,
      sequenceGroups,
      animationNames: sequenceGroups.map((group) => group.prefix),
      defaultAnimation: sequenceGroups[0]?.prefix ?? null,
      frames,
      regions: regionsFromFrames(frames),
    });
  }

  const animDir = path.join(viewerRoot, 'animations', tabId);
  fs.rmSync(animDir, { recursive: true, force: true });
  const animationManifest = [];
  if (animationPacks.length) fs.mkdirSync(animDir, { recursive: true });
  for (const pack of animationPacks) {
    const previewFile = `animations/${tabId}/${pack.id}.json`;
    const spineExport = String(pack.type).startsWith('spine')
      ? writeSpineFiles(viewerRoot, tabId, pack.id, pack)
      : null;
    const slim = {
      id: pack.id,
      type: pack.type,
      name: pack.name,
      importUrl: pack.importUrl,
      bundle: pack.bundle,
      textureSrc: pack.textureSrc,
      textureUrl: pack.textureUrl ?? null,
      textureFileName: pack.textureFileName ?? null,
      width: pack.width ?? null,
      height: pack.height ?? null,
      regionCount: pack.regionCount ?? 0,
      sequenceGroups: pack.sequenceGroups ?? [],
      animationNames: pack.animationNames ?? [],
      defaultAnimation: pack.defaultAnimation ?? null,
      spineVersion: pack.spineVersion ?? null,
      previewFile,
      skelUrl: spineExport?.skelUrl ?? null,
      atlasUrl: spineExport?.atlasUrl ?? null,
      pageUrls: spineExport?.pageUrls ?? null,
      missingExportPages: spineExport?.missingPages ?? [],
    };
    fs.writeFileSync(path.join(animDir, `${pack.id}.json`), JSON.stringify({
      ...slim,
      regions: pack.regions ?? null,
      frames: pack.frames ?? null,
      atlasText: pack.atlasText ?? null,
      skeletonJson: pack.skeletonJson ?? null,
      texturePages: pack.texturePages ?? {},
    }));
    animationManifest.push(slim);
  }
  if (animationPacks.length) {
    fs.writeFileSync(
      path.join(animDir, 'manifest.json'),
      JSON.stringify({ tabId, items: animationManifest }, null, 2),
    );
  }

  const fonts = [];
  const textByUrl = new Map();
  for (const doc of fontDocs) {
    const importUrl = `https://local/import/${doc.rel}`;
    const found = extractBitmapFonts([{
      request: { url: importUrl },
      response: { content: { text: doc.text } },
    }]);
    for (const font of found) {
      const glyphs = Object.keys(font.fntConfig?.fontDefDictionary ?? {}).length;
      const prev = fonts.find((item) => item.fontName === font.fontName);
      const prevGlyphs = prev ? Object.keys(prev.fntConfig?.fontDefDictionary ?? {}).length : -1;
      if (!prev || glyphs > prevGlyphs) {
        if (prev) fonts.splice(fonts.indexOf(prev), 1);
        fonts.push(font);
        textByUrl.set(font.importUrl, doc.text);
      }
    }
  }
  const fontsDir = path.join(viewerRoot, 'fonts', tabId);
  fs.rmSync(fontsDir, { recursive: true, force: true });
  const fontManifest = [];
  for (const font of fonts) {
    const text = textByUrl.get(font.importUrl) || '';
    const tex = matchFontTexture(font, text, textures);
    const id = safeAnimId(font.fontName);
    const dir = path.join(fontsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const texExt = tex?.src?.match(/(\.[a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '.png';
    const pngName = `${id}${texExt}`;
    const fntName = `${id}.fnt`;
    let pngUrl = null;
    if (tex?.src) {
      const abs = path.join(viewerRoot, tex.src);
      if (fs.existsSync(abs)) {
        fs.writeFileSync(path.join(dir, pngName), fs.readFileSync(abs));
        pngUrl = `fonts/${tabId}/${id}/${pngName}`;
      }
    }
    fs.writeFileSync(
      path.join(dir, fntName),
      fntConfigToBmFont(font.fntConfig, font.fontName, pngName),
    );
    const defs = font.fntConfig.fontDefDictionary ?? {};
    const extent = fontAtlasExtent(font.fntConfig);
    fontManifest.push({
      id,
      name: font.fontName,
      fontSize: font.fntConfig.fontSize ?? null,
      commonHeight: font.fntConfig.commonHeight ?? null,
      glyphCount: Object.keys(defs).length,
      glyphs: glyphPreview(defs),
      atlasWidth: tex?.width ?? extent.w,
      atlasHeight: tex?.height ?? extent.h,
      textureFileName: tex?.fileName ?? null,
      importUrl: font.importUrl,
      fntUrl: `fonts/${tabId}/${id}/${fntName}`,
      pngUrl,
      fontDefDictionary: defs,
    });
  }
  if (fontManifest.length) {
    fs.writeFileSync(
      path.join(fontsDir, 'manifest.json'),
      JSON.stringify({
        tabId,
        items: fontManifest.map(({ fontDefDictionary, ...rest }) => rest),
      }, null, 2),
    );
  }

  const audioRenamed = applyAudioNames(audio, audioNameIndex(docs));
  return { animationManifest, fontManifest, audioRenamed };
}
