// Animated GIF encoder: one shared palette (exact when the art has <= 255 colors,
// median-cut otherwise), 1-bit transparency, LZW compression.
import { ByteWriter, concatenateBytes } from './bytes';

export interface GifFrame {
  rgbaPixels: Uint8ClampedArray;
  delayInCentiseconds: number;
}

const transparentPaletteIndex = 255;
const alphaThresholdForOpaque = 128;

interface ColorBox {
  colors: { red: number; green: number; blue: number; count: number }[];
}

function buildPalette(frames: readonly GifFrame[]): number[] {
  const colorCounts = new Map<number, number>();
  for (const frame of frames) {
    const pixels = frame.rgbaPixels;
    for (let byteIndex = 0; byteIndex < pixels.length; byteIndex += 4) {
      if (pixels[byteIndex + 3]! < alphaThresholdForOpaque) continue;
      const packedColor = (pixels[byteIndex]! << 16) | (pixels[byteIndex + 1]! << 8) | pixels[byteIndex + 2]!;
      colorCounts.set(packedColor, (colorCounts.get(packedColor) ?? 0) + 1);
    }
  }
  if (colorCounts.size <= 255) return [...colorCounts.keys()];

  // Median cut over a 5-bit-per-channel histogram.
  const coarseCounts = new Map<number, { red: number; green: number; blue: number; count: number }>();
  for (const [packedColor, count] of colorCounts) {
    const red = packedColor >> 16, green = (packedColor >> 8) & 0xff, blue = packedColor & 0xff;
    const coarseKey = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
    const existing = coarseCounts.get(coarseKey);
    if (existing === undefined) coarseCounts.set(coarseKey, { red: red * count, green: green * count, blue: blue * count, count });
    else {
      existing.red += red * count;
      existing.green += green * count;
      existing.blue += blue * count;
      existing.count += count;
    }
  }
  const histogramColors = [...coarseCounts.values()].map((entry) => ({
    red: entry.red / entry.count,
    green: entry.green / entry.count,
    blue: entry.blue / entry.count,
    count: entry.count,
  }));
  const boxes: ColorBox[] = [{ colors: histogramColors }];
  const channelNames = ['red', 'green', 'blue'] as const;

  while (boxes.length < 255) {
    let widestBoxIndex = -1;
    let widestRange = 0;
    let widestChannel: (typeof channelNames)[number] = 'red';
    boxes.forEach((box, boxIndex) => {
      if (box.colors.length < 2) return;
      for (const channelName of channelNames) {
        let minimum = 255, maximum = 0;
        for (const color of box.colors) {
          minimum = Math.min(minimum, color[channelName]);
          maximum = Math.max(maximum, color[channelName]);
        }
        if (maximum - minimum > widestRange) {
          widestRange = maximum - minimum;
          widestBoxIndex = boxIndex;
          widestChannel = channelName;
        }
      }
    });
    if (widestBoxIndex < 0) break;
    const boxToSplit = boxes[widestBoxIndex]!;
    boxToSplit.colors.sort((left, right) => left[widestChannel] - right[widestChannel]);
    const totalCount = boxToSplit.colors.reduce((sum, color) => sum + color.count, 0);
    let runningCount = 0;
    let splitIndex = 1;
    for (let colorIndex = 0; colorIndex < boxToSplit.colors.length - 1; colorIndex++) {
      runningCount += boxToSplit.colors[colorIndex]!.count;
      splitIndex = colorIndex + 1;
      if (runningCount >= totalCount / 2) break;
    }
    boxes.splice(widestBoxIndex, 1, { colors: boxToSplit.colors.slice(0, splitIndex) }, { colors: boxToSplit.colors.slice(splitIndex) });
  }

  return boxes.map((box) => {
    let red = 0, green = 0, blue = 0, count = 0;
    for (const color of box.colors) {
      red += color.red * color.count;
      green += color.green * color.count;
      blue += color.blue * color.count;
      count += color.count;
    }
    return (Math.round(red / count) << 16) | (Math.round(green / count) << 8) | Math.round(blue / count);
  });
}

function lzwEncode(paletteIndices: Uint8Array, minimumCodeSize: number): Uint8Array {
  const clearCode = 1 << minimumCodeSize;
  const endOfInformationCode = clearCode + 1;
  const outputBytes: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minimumCodeSize + 1;
  let nextCode = endOfInformationCode + 1;
  const codeTable = new Map<number, number>();

  const emitCode = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      outputBytes.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  emitCode(clearCode);
  let currentPrefix = paletteIndices[0] ?? 0;
  for (let pixelIndex = 1; pixelIndex < paletteIndices.length; pixelIndex++) {
    const nextIndex = paletteIndices[pixelIndex]!;
    const tableKey = (currentPrefix << 8) | nextIndex;
    const existingCode = codeTable.get(tableKey);
    if (existingCode !== undefined) {
      currentPrefix = existingCode;
      continue;
    }
    emitCode(currentPrefix);
    if (nextCode === 4096) {
      emitCode(clearCode);
      codeTable.clear();
      codeSize = minimumCodeSize + 1;
      nextCode = endOfInformationCode + 1;
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      codeTable.set(tableKey, nextCode++);
    }
    currentPrefix = nextIndex;
  }
  emitCode(currentPrefix);
  emitCode(endOfInformationCode);
  if (bitCount > 0) outputBytes.push(bitBuffer & 0xff);

  const subBlocks = new ByteWriter().uint8(minimumCodeSize);
  for (let blockStart = 0; blockStart < outputBytes.length; blockStart += 255) {
    const block = outputBytes.slice(blockStart, blockStart + 255);
    subBlocks.uint8(block.length).bytes(Uint8Array.from(block));
  }
  subBlocks.uint8(0);
  return subBlocks.toBytes();
}

/** loopForever=false plays once, which is what "once" animations should do. */
export function encodeAnimatedGif(width: number, height: number, frames: readonly GifFrame[], loopForever: boolean): Uint8Array {
  const palette = buildPalette(frames);
  const paletteBytes = new Uint8Array(256 * 3);
  palette.forEach((packedColor, paletteIndex) => {
    paletteBytes[paletteIndex * 3] = packedColor >> 16;
    paletteBytes[paletteIndex * 3 + 1] = (packedColor >> 8) & 0xff;
    paletteBytes[paletteIndex * 3 + 2] = packedColor & 0xff;
  });

  const nearestIndexCache = new Map<number, number>();
  const exactIndexLookup = new Map<number, number>(palette.map((packedColor, paletteIndex) => [packedColor, paletteIndex]));
  const findPaletteIndex = (red: number, green: number, blue: number): number => {
    const packedColor = (red << 16) | (green << 8) | blue;
    const exactIndex = exactIndexLookup.get(packedColor) ?? nearestIndexCache.get(packedColor);
    if (exactIndex !== undefined) return exactIndex;
    let bestIndex = 0;
    let bestDistance = Infinity;
    palette.forEach((candidateColor, paletteIndex) => {
      const redDifference = red - (candidateColor >> 16);
      const greenDifference = green - ((candidateColor >> 8) & 0xff);
      const blueDifference = blue - (candidateColor & 0xff);
      const distance = redDifference * redDifference * 2 + greenDifference * greenDifference * 4 + blueDifference * blueDifference * 3;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = paletteIndex;
      }
    });
    nearestIndexCache.set(packedColor, bestIndex);
    return bestIndex;
  };

  const output = new ByteWriter()
    .ascii('GIF89a')
    .uint16LittleEndian(width)
    .uint16LittleEndian(height)
    .uint8(0xf7) // global color table, 8 bits per channel, 256 entries
    .uint8(transparentPaletteIndex)
    .uint8(0)
    .bytes(paletteBytes);

  if (loopForever) {
    output.uint8(0x21).uint8(0xff).uint8(11).ascii('NETSCAPE2.0').uint8(3).uint8(1).uint16LittleEndian(0).uint8(0);
  }

  const frameParts: Uint8Array[] = [];
  for (const frame of frames) {
    const paletteIndices = new Uint8Array(width * height);
    const pixels = frame.rgbaPixels;
    for (let pixelIndex = 0; pixelIndex < paletteIndices.length; pixelIndex++) {
      const byteIndex = pixelIndex * 4;
      paletteIndices[pixelIndex] =
        pixels[byteIndex + 3]! < alphaThresholdForOpaque
          ? transparentPaletteIndex
          : findPaletteIndex(pixels[byteIndex]!, pixels[byteIndex + 1]!, pixels[byteIndex + 2]!);
    }
    frameParts.push(
      new ByteWriter()
        // Graphic control: dispose to background (so transparent areas clear), transparency on.
        .uint8(0x21).uint8(0xf9).uint8(4).uint8(0b0000_1001)
        .uint16LittleEndian(Math.max(2, Math.round(frame.delayInCentiseconds)))
        .uint8(transparentPaletteIndex).uint8(0)
        // Image descriptor covering the full canvas, no local palette.
        .uint8(0x2c).uint16LittleEndian(0).uint16LittleEndian(0).uint16LittleEndian(width).uint16LittleEndian(height).uint8(0)
        .bytes(lzwEncode(paletteIndices, 8))
        .toBytes(),
    );
  }
  return concatenateBytes([output.toBytes(), ...frameParts, Uint8Array.of(0x3b)]);
}
