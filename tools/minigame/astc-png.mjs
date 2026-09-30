/**
 * ASTC (magic 0x5CA1AB13) → PNG. Browser <img> cannot display .astc.
 * texture2ddecoder-wasm returns BGRA; this writes a standard RGBA PNG.
 */
import zlib from 'node:zlib';
import { decode_astc } from 'texture2ddecoder-wasm';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function parseAstcHeader(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf.readUInt32LE(0) !== 0x5ca1ab13) return null;
  const blockWidth = buf[4];
  const blockHeight = buf[5];
  const blockDepth = buf[6];
  const width = buf[7] | (buf[8] << 8) | (buf[9] << 16);
  const height = buf[10] | (buf[11] << 8) | (buf[12] << 16);
  if (!blockWidth || !blockHeight || !width || !height || blockDepth !== 1) return null;
  if (width > 8192 || height > 8192) return null;
  return { blockWidth, blockHeight, width, height };
}

function bgraToPng(bgra, width, height) {
  const stride = width * 4;
  const row = stride + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const dst = y * row;
    raw[dst] = 0;
    const src = y * stride;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + 1 + x * 4;
      raw[d] = bgra[s + 2];
      raw[d + 1] = bgra[s + 1];
      raw[d + 2] = bgra[s];
      raw[d + 3] = bgra[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @returns {Promise<{ png: Buffer, width: number, height: number } | null>} */
export async function decodeAstcToPng(buf) {
  const header = parseAstcHeader(buf);
  if (!header) return null;
  const pixels = await decode_astc(
    buf.subarray(16),
    header.width,
    header.height,
    header.blockWidth,
    header.blockHeight,
  );
  if (!pixels || pixels.length < header.width * header.height * 4) return null;
  return {
    png: bgraToPng(pixels, header.width, header.height),
    width: header.width,
    height: header.height,
  };
}
