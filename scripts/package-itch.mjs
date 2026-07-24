import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";
import { deflateRawSync } from "node:zlib";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const buildDirectory = path.join(projectRoot, "dist");
const outputFile = path.join(projectRoot, "the-order-of-order.zip");

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    (date.getSeconds() >>> 1);
  const day =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function assertZip32(value, description) {
  if (value > 0xffffffff) {
    throw new Error(`${description} is too large for this ZIP packager.`);
  }
}

async function createZip() {
  const files = await collectFiles(buildDirectory);
  if (files.length === 0) {
    throw new Error(`No files found in ${buildDirectory}.`);
  }

  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const absolutePath of files) {
    const source = await readFile(absolutePath);
    const compressed = deflateRawSync(source, { level: 9 });
    const checksum = crc32(source);
    const { mtime } = await stat(absolutePath);
    const { time, day } = dosTimestamp(mtime);

    // ZIP paths always use forward slashes, including when this script runs on Windows.
    const entryName = path
      .relative(buildDirectory, absolutePath)
      .split(path.sep)
      .join("/");
    const name = Buffer.from(entryName, "utf8");

    assertZip32(source.length, `${entryName} (uncompressed)`);
    assertZip32(compressed.length, `${entryName} (compressed)`);
    assertZip32(localOffset, "ZIP offset");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(day, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(source.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(day, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(source.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);

    localRecords.push(localHeader, name, compressed);
    centralRecords.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  assertZip32(localOffset, "Central directory offset");
  assertZip32(centralDirectory.length, "Central directory");

  if (files.length > 0xffff) {
    throw new Error("Too many files for this ZIP packager.");
  }

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  await writeFile(
    outputFile,
    Buffer.concat([...localRecords, centralDirectory, endRecord]),
  );
  console.log(
    `Created ${path.relative(projectRoot, outputFile)} with ${files.length} files.`,
  );
}

try {
  await createZip();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
