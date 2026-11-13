/**
 * Builds the portable release archive.
 *
 * The NSIS setup exe is for installing and for upgrading an existing install.
 * This archive is the other half: one zip that holds nothing but the packaged
 * app — `Colax.exe`, its Electron runtime, locales and `resources/app.asar` — so
 * a GitHub release needs a single upload instead of a hand-collected folder.
 *
 * Entries are written under a `Colax/` folder, so extracting gives a clean
 * portable folder rather than loose DLLs in the Downloads directory. There is no
 * source, no `node_modules`, no build cache and no setup exe inside.
 *
 * The zip is written directly with Node's zlib: no 7-Zip, no PowerShell and no
 * extra dependency, which keeps this working on any machine that can already
 * build the app.
 */
import { existsSync, cpSync, openSync, closeSync, writeSync, readFileSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const unpacked = path.join(root, 'release', 'win-unpacked');
const staging = path.join(root, 'release', 'Colax');
const zipName = `Colax ${version} win-x64.zip`;
const zipPath = path.join(root, 'release', zipName);

if (!existsSync(path.join(unpacked, 'Colax.exe'))) {
  console.error('pack-zip: release/win-unpacked is missing. Run `npm run dist:electron` first.');
  process.exit(1);
}

// Fresh staging copy, so the zip never inherits files from an older build.
rmSync(staging, { recursive: true, force: true });
cpSync(unpacked, staging, { recursive: true });

/* ---- Minimal ZIP writer ---------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosStamp(mtime) {
  const date = new Date(mtime);
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

function listFiles(directory, prefix = '') {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(absolute, name));
    else if (entry.isFile()) found.push({ absolute, name, stat: statSync(absolute) });
  }
  return found;
}

const entries = listFiles(staging).sort((left, right) => left.name.localeCompare(right.name));
const fd = openSync(zipPath, 'w');
let offset = 0;
const central = [];

for (const entry of entries) {
  const nameBytes = Buffer.from(`Colax/${entry.name}`, 'utf8');
  const data = readFileSync(entry.absolute);
  // Deflate gives up only on files large enough to make the buffer spike a
  // problem: everything else, including the Electron binary, is compressed.
  const deflated = data.length > 512 * 1024 * 1024 ? null : deflateRawSync(data, { level: 6 });
  const method = deflated ? 8 : 0;
  const payload = deflated ?? data;
  const crc = crc32(data);
  const { time, day } = dosStamp(entry.stat.mtimeMs);

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(day, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(payload.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);

  writeSync(fd, header);
  writeSync(fd, nameBytes);
  writeSync(fd, payload);

  central.push({ nameBytes, method, time, day, crc, compressed: payload.length, size: data.length, offset });
  offset += header.length + nameBytes.length + payload.length;
}

const centralStart = offset;
for (const entry of central) {
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(0, 8);
  record.writeUInt16LE(entry.method, 10);
  record.writeUInt16LE(entry.time, 12);
  record.writeUInt16LE(entry.day, 14);
  record.writeUInt32LE(entry.crc, 16);
  record.writeUInt32LE(entry.compressed, 20);
  record.writeUInt32LE(entry.size, 24);
  record.writeUInt16LE(entry.nameBytes.length, 28);
  record.writeUInt16LE(0, 30);
  record.writeUInt16LE(0, 32);
  record.writeUInt16LE(0, 34);
  record.writeUInt16LE(0, 36);
  record.writeUInt32LE(0, 38);
  record.writeUInt32LE(entry.offset, 42);
  writeSync(fd, record);
  writeSync(fd, entry.nameBytes);
  offset += record.length + entry.nameBytes.length;
}

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(central.length, 8);
end.writeUInt16LE(central.length, 10);
end.writeUInt32LE(offset - centralStart, 12);
end.writeUInt32LE(centralStart, 16);
end.writeUInt16LE(0, 20);
writeSync(fd, end);
closeSync(fd);

rmSync(staging, { recursive: true, force: true });

// A copy beside the setup exe in the project root, for a quick upload.
copyFileSync(zipPath, path.join(root, zipName));

const megabytes = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`pack-zip: ${entries.length} app files -> ${zipName} (${megabytes} MB)`);
