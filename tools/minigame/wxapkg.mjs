/**
 * 微信 PC 端小程序 / 小游戏包：识别、V1MMWX 解密、wxapkg 拆包。
 *
 * 加密格式（桌面微信缓存，公开实现一致）：
 *   0..6     魔数 V1MMWX
 *   6..1030  明文前 1023 字节，AES-256-CBC（解出 1024 字节后丢掉最后 1 字节）
 *   1030..   其余明文逐字节 XOR（密钥为 wxid 倒数第二个字符）
 * 密钥：PBKDF2-HMAC-SHA1(wxid, "saltiest", 1000, 32)
 * IV：  "the iv: 16 bytes"
 *
 * 只处理用户本机已经缓存的包，不下载、不回填。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAGIC = Buffer.from('V1MMWX');
const SALT = 'saltiest';
const IV = Buffer.from('the iv: 16 bytes');
const PLAIN_MARK = 0xbe;
const INDEX_MARK = 0xed;

export function isEncrypted(buf) {
  return buf.length >= 6 && buf.subarray(0, 6).equals(MAGIC);
}

export function isPlainWxapkg(buf) {
  return buf.length >= 14 && buf[0] === PLAIN_MARK && buf[13] === INDEX_MARK;
}

/** 从路径里猜小程序 wxid（wx + 16 位十六进制）。 */
export function inferWxid(filePath) {
  const parts = String(filePath).split(/[/\\]/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (/^wx[0-9a-fA-F]{16}$/.test(parts[i])) return parts[i];
  }
  return '';
}

function xorKeyOf(wxid) {
  if (!wxid || wxid.length < 2) return 0x66;
  return wxid.charCodeAt(wxid.length - 2) & 0xff;
}

function deriveKey(wxid) {
  return crypto.pbkdf2Sync(Buffer.from(wxid), Buffer.from(SALT), 1000, 32, 'sha1');
}

/**
 * 解密 V1MMWX。明文不足 1023 字节的包按「整段都在 AES 头里」处理。
 * @param {Buffer} buf
 * @param {string} wxid
 * @returns {Buffer}
 */
export function decryptV1mmwx(buf, wxid) {
  if (!isEncrypted(buf)) {
    throw new Error('不是 V1MMWX 加密包');
  }
  if (!wxid) {
    throw new Error('解密需要 wxid（小程序 AppId，形如 wx + 16 位十六进制）');
  }
  if (buf.length < 6 + 16) throw new Error('加密包过短');

  const key = deriveKey(wxid);
  const encLen = Math.min(1024, buf.length - 6);
  if (encLen % 16 !== 0) {
    throw new Error(`加密头长度 ${encLen} 不是 16 的倍数`);
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, IV);
  decipher.setAutoPadding(false);
  const decHeader = Buffer.concat([
    decipher.update(buf.subarray(6, 6 + encLen)),
    decipher.final(),
  ]);

  if (buf.length <= 6 + 1024) {
    return encLen === 1024 ? decHeader.subarray(0, 1023) : decHeader;
  }

  const rest = Buffer.from(buf.subarray(6 + 1024));
  const xorKey = xorKeyOf(wxid);
  for (let i = 0; i < rest.length; i += 1) rest[i] ^= xorKey;
  return Buffer.concat([decHeader.subarray(0, 1023), rest]);
}

/** 测试用：把明文打成 V1MMWX。明文至少 1023 字节，且与 decrypt 互逆。 */
export function encryptV1mmwx(plain, wxid) {
  if (plain.length < 1023) {
    throw new Error('明文至少 1023 字节才能按桌面微信格式加密');
  }
  const key = deriveKey(wxid);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, IV);
  cipher.setAutoPadding(false);
  const headerPlain = Buffer.alloc(1024);
  plain.subarray(0, 1023).copy(headerPlain);
  const encHeader = Buffer.concat([cipher.update(headerPlain), cipher.final()]);
  const rest = Buffer.from(plain.subarray(1023));
  const xorKey = xorKeyOf(wxid);
  for (let i = 0; i < rest.length; i += 1) rest[i] ^= xorKey;
  return Buffer.concat([MAGIC, encHeader, rest]);
}

/**
 * 拆未加密 wxapkg。偏移为大端，文件偏移相对包起点。
 * @param {Buffer} buf
 * @returns {{ name: string, data: Buffer }[]}
 */
export function unpackWxapkg(buf) {
  if (!isPlainWxapkg(buf)) {
    const head = buf.subarray(0, 8).toString('hex');
    throw new Error(`不是 wxapkg（头 ${head}）`);
  }
  const fileCount = buf.readUInt32BE(14);
  if (fileCount > 100000) throw new Error(`文件数异常: ${fileCount}`);
  const files = [];
  let off = 18;
  for (let i = 0; i < fileCount; i += 1) {
    if (off + 4 > buf.length) throw new Error('索引越界');
    const nameLen = buf.readUInt32BE(off);
    off += 4;
    if (nameLen > 4096 || off + nameLen + 8 > buf.length) {
      throw new Error(`文件名长度异常: ${nameLen}`);
    }
    const name = buf.subarray(off, off + nameLen).toString('utf8');
    off += nameLen;
    const fileOff = buf.readUInt32BE(off);
    off += 4;
    const size = buf.readUInt32BE(off);
    off += 4;
    if (fileOff + size > buf.length) {
      throw new Error(`文件数据越界: ${name}`);
    }
    files.push({ name, data: buf.subarray(fileOff, fileOff + size) });
  }
  return files;
}

/** 打包，供自测。name 用绝对虚拟路径（以 / 开头）。 */
export function packWxapkg(entries) {
  let listBytes = 4;
  for (const e of entries) listBytes += 12 + Buffer.byteLength(e.name);
  const bodyStart = 14 + listBytes;
  const chunks = entries.map((e) => e.data);
  const bodyLen = chunks.reduce((n, c) => n + c.length, 0);
  const buf = Buffer.alloc(bodyStart + bodyLen);
  buf.writeUInt8(PLAIN_MARK, 0);
  buf.writeUInt32BE(0, 1);
  buf.writeUInt32BE(listBytes, 5);
  buf.writeUInt32BE(bodyLen, 9);
  buf.writeUInt8(INDEX_MARK, 13);
  buf.writeUInt32BE(entries.length, 14);
  let off = 18;
  let dataOff = bodyStart;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    buf.writeUInt32BE(name.length, off);
    off += 4;
    name.copy(buf, off);
    off += name.length;
    buf.writeUInt32BE(dataOff, off);
    off += 4;
    buf.writeUInt32BE(e.data.length, off);
    off += 4;
    e.data.copy(buf, dataOff);
    dataOff += e.data.length;
  }
  return buf;
}

/** 拒绝跳出输出目录的文件名。 */
export function safeDest(root, name) {
  const cleaned = String(name).replace(/^[/\\]+/, '');
  if (!cleaned || cleaned.includes('\0')) {
    throw new Error(`非法路径: ${name}`);
  }
  const dest = path.resolve(root, cleaned);
  const rel = path.relative(path.resolve(root), dest);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`非法路径: ${name}`);
  }
  return dest;
}

export function writeUnpacked(root, files) {
  fs.mkdirSync(root, { recursive: true });
  const written = [];
  for (const file of files) {
    const dest = safeDest(root, file.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.data);
    written.push(dest);
  }
  return written;
}

/**
 * 实际要扫的目录：每个登录用户的 applet，以及试玩广告 udr/playable。
 * 不扫整个用户目录（里面有网页缓存，又慢又容易误报）。
 */
export function macScanRoots() {
  const roots = [];
  const usersRoot = macAppletRoots()[0];
  if (!fs.existsSync(usersRoot)) return macAppletRoots();
  let users = [];
  try {
    users = fs.readdirSync(usersRoot);
  } catch {
    return macAppletRoots();
  }
  for (const user of users) {
    const base = path.join(usersRoot, user);
    for (const rel of ['applet', path.join('udr', 'playable')]) {
      const dir = path.join(base, rel);
      if (fs.existsSync(dir)) roots.push(dir);
    }
  }
  return roots.length ? roots : macAppletRoots();
}

/** macOS 微信 4.x 小程序缓存根（用户目录下的 applet）。 */
export function macAppletRoots() {
  const home = os.homedir();
  const data = path.join(
    home,
    'Library/Containers/com.tencent.xinWeChat/Data',
  );
  return [
    path.join(data, 'Documents/app_data/radium/users'),
    path.join(data, '.wxapplet'),
    path.join(
      home,
      'Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat',
    ),
  ];
}

const SKIP_DIR = new Set(['icon', 'Cache', 'Code Cache', 'GPUCache']);

/**
 * 在目录下找可能的包：扩展名 wxapkg/wxpkg，或文件头为 V1MMWX / 0xBE。
 * 跳过数据库和明显无关的缓存目录。
 */
export function findPackages(root, { maxFiles = 200 } = {}) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  const stack = [root];
  while (stack.length && found.length < maxFiles) {
    const dir = stack.pop();
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (found.length >= maxFiles) break;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIR.has(name) && !name.endsWith('.db')) stack.push(full);
        continue;
      }
      if (!st.isFile() || st.size < 14 || st.size > 512 * 1024 * 1024) continue;
      if (name.endsWith('.db') || name.endsWith('.db-wal')) continue;
      const ext = path.extname(name).toLowerCase();
      const named = ext === '.wxapkg' || ext === '.wxpkg';
      let kind = '';
      if (named) kind = 'named';
      else {
        const fd = fs.openSync(full, 'r');
        const head = Buffer.alloc(14);
        const n = fs.readSync(fd, head, 0, 14, 0);
        fs.closeSync(fd);
        if (n >= 6 && head.subarray(0, 6).equals(MAGIC)) kind = 'V1MMWX';
        else if (n >= 14 && head[0] === PLAIN_MARK && head[13] === INDEX_MARK) {
          kind = 'plain';
        }
      }
      if (!kind) continue;
      found.push({
        path: full,
        size: st.size,
        kind,
        wxid: inferWxid(full),
      });
    }
  }
  return found;
}

/** 读 game.json / app.json，判断是小游戏还是小程序。 */
export function describePackage(files) {
  const names = files.map((f) => f.name.replace(/^[/\\]+/, ''));
  const game = files.find((f) => /(^|[/\\])game\.json$/.test(f.name));
  const app = files.find((f) => /(^|[/\\])app\.json$/.test(f.name));
  let device = '';
  let subpackages = 0;
  const metaName = game ? 'game.json' : app ? 'app.json' : '';
  const meta = game || app;
  if (meta) {
    try {
      const json = JSON.parse(meta.data.toString('utf8'));
      device = json.deviceOrientation || '';
      subpackages = Array.isArray(json.subpackages) ? json.subpackages.length : 0;
    } catch {
      /* 配置损坏时仍返回文件列表 */
    }
  }
  const kind = game ? 'minigame' : app ? 'miniprogram' : 'unknown';
  return {
    kind,
    metaName,
    deviceOrientation: device,
    subpackages,
    fileCount: files.length,
    top: [...new Set(names.map((n) => n.split(/[/\\]/)[0]))].slice(0, 20),
  };
}
