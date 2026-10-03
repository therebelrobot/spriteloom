// Small byte helpers shared by the PNG, APNG, GIF and zip code.

const crc32LookupTable = (() => {
  const table = new Uint32Array(256);
  for (let tableIndex = 0; tableIndex < 256; tableIndex++) {
    let remainder = tableIndex;
    for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
      remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
    }
    table[tableIndex] = remainder >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, startingCrc = 0): number {
  let runningCrc = (startingCrc ^ 0xffffffff) >>> 0;
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
    runningCrc = crc32LookupTable[(runningCrc ^ bytes[byteIndex]!) & 0xff]! ^ (runningCrc >>> 8);
  }
  return (runningCrc ^ 0xffffffff) >>> 0;
}

export function concatenateBytes(byteArrays: readonly Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const byteArray of byteArrays) totalLength += byteArray.length;
  const combined = new Uint8Array(totalLength);
  let writePosition = 0;
  for (const byteArray of byteArrays) {
    combined.set(byteArray, writePosition);
    writePosition += byteArray.length;
  }
  return combined;
}

async function runThroughStream(
  inputBytes: Uint8Array,
  transformStream: ReadableWritablePair<Uint8Array, Uint8Array>,
): Promise<Uint8Array> {
  const resultStream = new Blob([inputBytes as BlobPart]).stream().pipeThrough(transformStream);
  return new Uint8Array(await new Response(resultStream).arrayBuffer());
}

/** zlib-wrapped deflate, the format PNG IDAT data uses. */
export function zlibCompress(inputBytes: Uint8Array): Promise<Uint8Array> {
  return runThroughStream(inputBytes, new CompressionStream('deflate') as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/** Raw deflate without a zlib header, the format zip entries use. */
export function rawInflate(inputBytes: Uint8Array): Promise<Uint8Array> {
  return runThroughStream(
    inputBytes,
    new DecompressionStream('deflate-raw') as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
}

export class ByteWriter {
  private chunks: Uint8Array[] = [];

  bytes(byteArray: Uint8Array): this {
    this.chunks.push(byteArray);
    return this;
  }

  uint8(value: number): this {
    this.chunks.push(Uint8Array.of(value & 0xff));
    return this;
  }

  uint16LittleEndian(value: number): this {
    this.chunks.push(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff));
    return this;
  }

  uint32LittleEndian(value: number): this {
    this.chunks.push(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff));
    return this;
  }

  uint16BigEndian(value: number): this {
    this.chunks.push(Uint8Array.of((value >>> 8) & 0xff, value & 0xff));
    return this;
  }

  uint32BigEndian(value: number): this {
    this.chunks.push(Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff));
    return this;
  }

  ascii(text: string): this {
    this.chunks.push(Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff));
    return this;
  }

  get length(): number {
    let totalLength = 0;
    for (const chunk of this.chunks) totalLength += chunk.length;
    return totalLength;
  }

  toBytes(): Uint8Array {
    return concatenateBytes(this.chunks);
  }
}
