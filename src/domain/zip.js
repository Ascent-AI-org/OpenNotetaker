// Minimal ZIP writer. The repo ships zero runtime dependencies beyond playwright-core,
// so multi-meeting exports are packaged with node:zlib's raw deflate plus hand-written
// ZIP32 headers rather than an archiver library.
import { deflateRawSync } from "node:zlib";

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
// ZIP32 stores sizes and offsets in 32 bits; anything larger would need ZIP64 headers.
const SIZE_LIMIT = 0xffffffff;
const VERSION_NEEDED = 20;
const UTF8_NAME_FLAG = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = buildCrcTable();

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @param {{modifiedAt?: Date}} [options]
 * @returns {Buffer}
 */
export function createZip(entries, { modifiedAt = new Date() } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Cannot build a zip with no entries.");
  }

  const { time, date } = dosTimestamp(modifiedAt);
  const seen = new Set();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = String(entry.name);
    // Duplicate names produce an archive whose entries silently shadow each other.
    if (seen.has(name)) throw new Error(`Duplicate zip entry name: ${name}`);
    seen.add(name);

    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const deflated = deflateRawSync(data, { level: 6 });
    // Tiny or already-compressed payloads can inflate under deflate; store those as-is.
    const compress = deflated.length < data.length;
    const payload = compress ? deflated : data;
    const method = compress ? METHOD_DEFLATE : METHOD_STORE;
    const crc = crc32(data);

    if (data.length > SIZE_LIMIT || payload.length > SIZE_LIMIT || offset > SIZE_LIMIT) {
      throw new Error("Export is too large for a zip32 archive.");
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    localHeader.writeUInt16LE(VERSION_NEEDED, 4);
    localHeader.writeUInt16LE(UTF8_NAME_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    centralHeader.writeUInt16LE(VERSION_NEEDED, 4);
    centralHeader.writeUInt16LE(VERSION_NEEDED, 6);
    centralHeader.writeUInt16LE(UTF8_NAME_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    chunks.push(localHeader, nameBytes, payload);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBytes, eocd]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function dosTimestamp(value) {
  const at = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  // MS-DOS timestamps start at 1980 and have two-second resolution. UTC keeps archives
  // byte-identical regardless of the server's timezone.
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate()
  };
}
