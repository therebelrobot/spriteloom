// Minimal zip support: read stored/deflated entries, write stored entries.
// PNGs are already compressed, so storing them in the archive costs nothing.
import { ByteWriter, concatenateBytes, crc32, rawInflate } from './bytes';

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

export async function readZipArchive(archiveBytes: Uint8Array): Promise<ZipEntry[]> {
  const dataView = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength);
  let endRecordPosition = -1;
  for (let searchPosition = archiveBytes.length - 22; searchPosition >= Math.max(0, archiveBytes.length - 65557); searchPosition--) {
    if (dataView.getUint32(searchPosition, true) === 0x06054b50) {
      endRecordPosition = searchPosition;
      break;
    }
  }
  if (endRecordPosition < 0) throw new Error('This zip file looks damaged (no central directory).');

  const entryCount = dataView.getUint16(endRecordPosition + 10, true);
  let directoryPosition = dataView.getUint32(endRecordPosition + 16, true);
  const textDecoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    if (dataView.getUint32(directoryPosition, true) !== 0x02014b50) throw new Error('This zip file looks damaged.');
    const compressionMethod = dataView.getUint16(directoryPosition + 10, true);
    const compressedSize = dataView.getUint32(directoryPosition + 20, true);
    const fileNameLength = dataView.getUint16(directoryPosition + 28, true);
    const extraFieldLength = dataView.getUint16(directoryPosition + 30, true);
    const commentLength = dataView.getUint16(directoryPosition + 32, true);
    const localHeaderPosition = dataView.getUint32(directoryPosition + 42, true);
    const entryPath = textDecoder.decode(archiveBytes.subarray(directoryPosition + 46, directoryPosition + 46 + fileNameLength));
    directoryPosition += 46 + fileNameLength + extraFieldLength + commentLength;

    if (entryPath.endsWith('/')) continue;
    const localNameLength = dataView.getUint16(localHeaderPosition + 26, true);
    const localExtraLength = dataView.getUint16(localHeaderPosition + 28, true);
    const dataStart = localHeaderPosition + 30 + localNameLength + localExtraLength;
    const compressedBytes = archiveBytes.subarray(dataStart, dataStart + compressedSize);
    if (compressionMethod === 0) entries.push({ path: entryPath, bytes: compressedBytes });
    else if (compressionMethod === 8) entries.push({ path: entryPath, bytes: await rawInflate(compressedBytes) });
    // Other compression methods are skipped rather than failing the whole import.
  }
  return entries;
}

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function writeZipArchive(entries: readonly ZipEntry[]): Uint8Array {
  const textEncoder = new TextEncoder();
  const { dosTime, dosDate } = dosDateTime(new Date());
  const localParts: Uint8Array[] = [];
  const centralDirectory = new ByteWriter();
  let localOffset = 0;

  for (const entry of entries) {
    const encodedPath = textEncoder.encode(entry.path);
    const entryCrc = crc32(entry.bytes);
    const localHeader = new ByteWriter()
      .uint32LittleEndian(0x04034b50)
      .uint16LittleEndian(20)
      .uint16LittleEndian(0x0800) // UTF-8 file names
      .uint16LittleEndian(0) // stored
      .uint16LittleEndian(dosTime)
      .uint16LittleEndian(dosDate)
      .uint32LittleEndian(entryCrc)
      .uint32LittleEndian(entry.bytes.length)
      .uint32LittleEndian(entry.bytes.length)
      .uint16LittleEndian(encodedPath.length)
      .uint16LittleEndian(0)
      .bytes(encodedPath)
      .toBytes();
    localParts.push(localHeader, entry.bytes);

    centralDirectory
      .uint32LittleEndian(0x02014b50)
      .uint16LittleEndian(20)
      .uint16LittleEndian(20)
      .uint16LittleEndian(0x0800)
      .uint16LittleEndian(0)
      .uint16LittleEndian(dosTime)
      .uint16LittleEndian(dosDate)
      .uint32LittleEndian(entryCrc)
      .uint32LittleEndian(entry.bytes.length)
      .uint32LittleEndian(entry.bytes.length)
      .uint16LittleEndian(encodedPath.length)
      .uint16LittleEndian(0)
      .uint16LittleEndian(0)
      .uint16LittleEndian(0)
      .uint16LittleEndian(0)
      .uint32LittleEndian(0)
      .uint32LittleEndian(localOffset)
      .bytes(encodedPath);
    localOffset += localHeader.length + entry.bytes.length;
  }

  const centralDirectoryBytes = centralDirectory.toBytes();
  const endRecord = new ByteWriter()
    .uint32LittleEndian(0x06054b50)
    .uint16LittleEndian(0)
    .uint16LittleEndian(0)
    .uint16LittleEndian(entries.length)
    .uint16LittleEndian(entries.length)
    .uint32LittleEndian(centralDirectoryBytes.length)
    .uint32LittleEndian(localOffset)
    .uint16LittleEndian(0)
    .toBytes();
  return concatenateBytes([...localParts, centralDirectoryBytes, endRecord]);
}
