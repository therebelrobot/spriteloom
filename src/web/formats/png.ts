// PNG and APNG reading/writing. Encoding is done by hand (rather than canvas.toBlob)
// so every frame is guaranteed to be 8-bit RGBA, which APNG assembly depends on.
import { ByteWriter, concatenateBytes, crc32, zlibCompress } from './bytes';

export const pngSignature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && pngSignature.every((signatureByte, byteIndex) => bytes[byteIndex] === signatureByte);
}

export function readPngChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new Error('Not a PNG file.');
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let readPosition = 8;
  while (readPosition + 12 <= bytes.length) {
    const chunkLength = dataView.getUint32(readPosition);
    const chunkType = String.fromCharCode(...bytes.subarray(readPosition + 4, readPosition + 8));
    const dataStart = readPosition + 8;
    if (dataStart + chunkLength + 4 > bytes.length) break;
    chunks.push({ type: chunkType, data: bytes.subarray(dataStart, dataStart + chunkLength) });
    readPosition = dataStart + chunkLength + 4;
    if (chunkType === 'IEND') break;
  }
  return chunks;
}

function encodeChunk(chunkType: string, chunkData: Uint8Array): Uint8Array {
  const typeAndData = new ByteWriter().ascii(chunkType).bytes(chunkData).toBytes();
  return new ByteWriter()
    .uint32BigEndian(chunkData.length)
    .bytes(typeAndData)
    .uint32BigEndian(crc32(typeAndData))
    .toBytes();
}

function headerChunkData(width: number, height: number): Uint8Array {
  // bit depth 8, color type 6 (RGBA), deflate, adaptive filtering, no interlace
  return new ByteWriter().uint32BigEndian(width).uint32BigEndian(height).uint8(8).uint8(6).uint8(0).uint8(0).uint8(0).toBytes();
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const distanceToLeft = Math.abs(estimate - left);
  const distanceToAbove = Math.abs(estimate - above);
  const distanceToUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceToLeft <= distanceToAbove && distanceToLeft <= distanceToUpperLeft) return left;
  if (distanceToAbove <= distanceToUpperLeft) return above;
  return upperLeft;
}

/** Applies PNG row filters, choosing per row the filter with the smallest absolute sum. */
function filterScanlines(width: number, height: number, rgbaPixels: Uint8ClampedArray | Uint8Array): Uint8Array {
  const bytesPerPixel = 4;
  const rowByteLength = width * bytesPerPixel;
  const filtered = new Uint8Array(height * (rowByteLength + 1));
  const candidateRows = Array.from({ length: 5 }, () => new Uint8Array(rowByteLength));

  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const rowStart = rowIndex * rowByteLength;
    const previousRowStart = rowStart - rowByteLength;
    let bestFilterType = 0;
    let bestScore = Infinity;
    for (let filterType = 0; filterType < 5; filterType++) {
      const candidateRow = candidateRows[filterType]!;
      let score = 0;
      for (let byteIndex = 0; byteIndex < rowByteLength; byteIndex++) {
        const current = rgbaPixels[rowStart + byteIndex]!;
        const left = byteIndex >= bytesPerPixel ? rgbaPixels[rowStart + byteIndex - bytesPerPixel]! : 0;
        const above = rowIndex > 0 ? rgbaPixels[previousRowStart + byteIndex]! : 0;
        const upperLeft = rowIndex > 0 && byteIndex >= bytesPerPixel ? rgbaPixels[previousRowStart + byteIndex - bytesPerPixel]! : 0;
        let filteredValue: number;
        switch (filterType) {
          case 0: filteredValue = current; break;
          case 1: filteredValue = current - left; break;
          case 2: filteredValue = current - above; break;
          case 3: filteredValue = current - ((left + above) >> 1); break;
          default: filteredValue = current - paethPredictor(left, above, upperLeft);
        }
        const filteredByte = filteredValue & 0xff;
        candidateRow[byteIndex] = filteredByte;
        score += filteredByte < 128 ? filteredByte : 256 - filteredByte;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilterType = filterType;
      }
    }
    // Recompute the winner in full (the scoring loop may have stopped early for it on a tie-break).
    const outputRowStart = rowIndex * (rowByteLength + 1);
    filtered[outputRowStart] = bestFilterType;
    for (let byteIndex = 0; byteIndex < rowByteLength; byteIndex++) {
      const current = rgbaPixels[rowStart + byteIndex]!;
      const left = byteIndex >= bytesPerPixel ? rgbaPixels[rowStart + byteIndex - bytesPerPixel]! : 0;
      const above = rowIndex > 0 ? rgbaPixels[previousRowStart + byteIndex]! : 0;
      const upperLeft = rowIndex > 0 && byteIndex >= bytesPerPixel ? rgbaPixels[previousRowStart + byteIndex - bytesPerPixel]! : 0;
      let filteredValue: number;
      switch (bestFilterType) {
        case 0: filteredValue = current; break;
        case 1: filteredValue = current - left; break;
        case 2: filteredValue = current - above; break;
        case 3: filteredValue = current - ((left + above) >> 1); break;
        default: filteredValue = current - paethPredictor(left, above, upperLeft);
      }
      filtered[outputRowStart + 1 + byteIndex] = filteredValue & 0xff;
    }
  }
  return filtered;
}

async function compressedImageData(width: number, height: number, rgbaPixels: Uint8ClampedArray | Uint8Array): Promise<Uint8Array> {
  return zlibCompress(filterScanlines(width, height, rgbaPixels));
}

export async function encodeRgbaPng(width: number, height: number, rgbaPixels: Uint8ClampedArray | Uint8Array): Promise<Uint8Array> {
  const imageData = await compressedImageData(width, height, rgbaPixels);
  return concatenateBytes([
    pngSignature,
    encodeChunk('IHDR', headerChunkData(width, height)),
    encodeChunk('IDAT', imageData),
    encodeChunk('IEND', new Uint8Array(0)),
  ]);
}

export interface AnimatedPngFrame {
  rgbaPixels: Uint8ClampedArray | Uint8Array;
  /** Frame duration as a fraction of a second: numerator / denominator. */
  delayNumerator: number;
  delayDenominator: number;
}

/** Builds an APNG where every frame covers the whole canvas. loopCount 0 = forever. */
export async function encodeAnimatedPng(
  width: number,
  height: number,
  frames: readonly AnimatedPngFrame[],
  loopCount: number,
): Promise<Uint8Array> {
  if (frames.length === 0) throw new Error('An animated PNG needs at least one frame.');
  const outputParts: Uint8Array[] = [
    pngSignature,
    encodeChunk('IHDR', headerChunkData(width, height)),
    encodeChunk('acTL', new ByteWriter().uint32BigEndian(frames.length).uint32BigEndian(loopCount).toBytes()),
  ];
  let sequenceNumber = 0;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex]!;
    outputParts.push(
      encodeChunk(
        'fcTL',
        new ByteWriter()
          .uint32BigEndian(sequenceNumber++)
          .uint32BigEndian(width)
          .uint32BigEndian(height)
          .uint32BigEndian(0)
          .uint32BigEndian(0)
          .uint16BigEndian(frame.delayNumerator)
          .uint16BigEndian(frame.delayDenominator)
          .uint8(0) // dispose: none
          .uint8(0) // blend: source, so transparent pixels really are transparent
          .toBytes(),
      ),
    );
    const imageData = await compressedImageData(width, height, frame.rgbaPixels);
    if (frameIndex === 0) {
      outputParts.push(encodeChunk('IDAT', imageData));
    } else {
      outputParts.push(encodeChunk('fdAT', new ByteWriter().uint32BigEndian(sequenceNumber++).bytes(imageData).toBytes()));
    }
  }
  outputParts.push(encodeChunk('IEND', new Uint8Array(0)));
  return concatenateBytes(outputParts);
}

export interface DecodedAnimation {
  frames: HTMLCanvasElement[];
  delaysInMilliseconds: number[];
}

/**
 * Returns every fully composited frame of an animated PNG, or null when the PNG
 * is a still image. Handles sub-region frames and all dispose/blend modes, which
 * is how Procreate and most encoders keep APNG files small.
 */
export async function decodeAnimatedPng(bytes: Uint8Array): Promise<DecodedAnimation | null> {
  const chunks = readPngChunks(bytes);
  if (!chunks.some((chunk) => chunk.type === 'acTL')) return null;
  const headerChunk = chunks.find((chunk) => chunk.type === 'IHDR');
  if (headerChunk === undefined) throw new Error('PNG has no header.');
  const headerView = new DataView(headerChunk.data.buffer, headerChunk.data.byteOffset, headerChunk.data.byteLength);
  const canvasWidth = headerView.getUint32(0);
  const canvasHeight = headerView.getUint32(4);

  const sharedChunksBeforeImageData: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (chunk.type === 'IDAT' || chunk.type === 'fcTL' || chunk.type === 'fdAT') break;
    if (chunk.type !== 'IHDR' && chunk.type !== 'acTL') sharedChunksBeforeImageData.push(encodeChunk(chunk.type, chunk.data));
  }

  interface PendingFrame {
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    delayInMilliseconds: number;
    disposeOperation: number;
    blendOperation: number;
    imageDataParts: Uint8Array[];
  }
  const pendingFrames: PendingFrame[] = [];
  let currentFrame: PendingFrame | null = null;
  for (const chunk of chunks) {
    if (chunk.type === 'fcTL') {
      const controlView = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
      const delayNumerator = controlView.getUint16(20);
      const delayDenominator = controlView.getUint16(22) || 100;
      currentFrame = {
        width: controlView.getUint32(4),
        height: controlView.getUint32(8),
        offsetX: controlView.getUint32(12),
        offsetY: controlView.getUint32(16),
        delayInMilliseconds: (delayNumerator / delayDenominator) * 1000,
        disposeOperation: chunk.data[24] ?? 0,
        blendOperation: chunk.data[25] ?? 0,
        imageDataParts: [],
      };
      pendingFrames.push(currentFrame);
    } else if (chunk.type === 'IDAT' && currentFrame !== null) {
      currentFrame.imageDataParts.push(chunk.data);
    } else if (chunk.type === 'fdAT' && currentFrame !== null) {
      currentFrame.imageDataParts.push(chunk.data.subarray(4));
    }
  }

  const compositingCanvas = document.createElement('canvas');
  compositingCanvas.width = canvasWidth;
  compositingCanvas.height = canvasHeight;
  const compositingContext = compositingCanvas.getContext('2d', { willReadFrequently: true })!;
  const decodedFrames: HTMLCanvasElement[] = [];
  const delaysInMilliseconds: number[] = [];

  for (let frameIndex = 0; frameIndex < pendingFrames.length; frameIndex++) {
    const pendingFrame = pendingFrames[frameIndex]!;
    if (pendingFrame.imageDataParts.length === 0) continue;
    const standalonePng = concatenateBytes([
      pngSignature,
      encodeChunk('IHDR', concatenateBytes([
        new ByteWriter().uint32BigEndian(pendingFrame.width).uint32BigEndian(pendingFrame.height).toBytes(),
        headerChunk.data.subarray(8),
      ])),
      ...sharedChunksBeforeImageData,
      encodeChunk('IDAT', concatenateBytes(pendingFrame.imageDataParts)),
      encodeChunk('IEND', new Uint8Array(0)),
    ]);
    const frameBitmap = await createImageBitmap(new Blob([standalonePng as BlobPart], { type: 'image/png' }));

    const disposeOperation = frameIndex === 0 && pendingFrame.disposeOperation === 2 ? 1 : pendingFrame.disposeOperation;
    const regionBeforeDrawing =
      disposeOperation === 2
        ? compositingContext.getImageData(pendingFrame.offsetX, pendingFrame.offsetY, pendingFrame.width, pendingFrame.height)
        : null;
    if (pendingFrame.blendOperation === 0) {
      compositingContext.clearRect(pendingFrame.offsetX, pendingFrame.offsetY, pendingFrame.width, pendingFrame.height);
    }
    compositingContext.drawImage(frameBitmap, pendingFrame.offsetX, pendingFrame.offsetY);
    frameBitmap.close();

    const snapshot = document.createElement('canvas');
    snapshot.width = canvasWidth;
    snapshot.height = canvasHeight;
    snapshot.getContext('2d', { willReadFrequently: true })!.drawImage(compositingCanvas, 0, 0);
    decodedFrames.push(snapshot);
    delaysInMilliseconds.push(pendingFrame.delayInMilliseconds);

    if (disposeOperation === 1) {
      compositingContext.clearRect(pendingFrame.offsetX, pendingFrame.offsetY, pendingFrame.width, pendingFrame.height);
    } else if (regionBeforeDrawing !== null) {
      compositingContext.putImageData(regionBeforeDrawing, pendingFrame.offsetX, pendingFrame.offsetY);
    }
  }
  return { frames: decodedFrames, delaysInMilliseconds };
}
