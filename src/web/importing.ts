// Turning files (PNGs, Procreate animated PNG/GIF exports, zips, sheets) into frames.
import { createIdentifier, type FrameRecord } from '../shared/project';
import { crc32 } from './formats/bytes';
import { decodeAnimatedPng, isPng } from './formats/png';
import { readZipArchive } from './formats/zip';
import { opaqueBounds } from './render';
import * as api from './api';
import {
  addFramesToProject,
  canvasToPngBlob,
  createAnimation,
  mutateProject,
  requireProject,
  setState,
  state,
  uniqueAnimationName,
} from './store';
import { naturalCompare } from './ui/dom';

export interface ImportedImage {
  name: string;
  canvas: HTMLCanvasElement;
  /** Present when the image came from an animated file. */
  delayInMilliseconds?: number;
}

export interface ImportedSource {
  sourceName: string;
  images: ImportedImage[];
  wasAnimated: boolean;
  notes: string[];
}

const imageFilePattern = /\.(png|apng|gif|webp|jpe?g)$/i;

function bitmapToCanvas(bitmap: ImageBitmap | HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  // Imported canvases get read back (blank and duplicate checks), so keep them CPU-side.
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0);
  return canvas;
}

function baseName(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
}

async function decodeAnimatedGif(bytes: Uint8Array): Promise<ImportedImage[] | null> {
  const ImageDecoderConstructor = (globalThis as unknown as { ImageDecoder?: new (init: { data: Uint8Array; type: string }) => {
    tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
    decode: (options: { frameIndex: number }) => Promise<{ image: VideoFrame }>;
    close: () => void;
  } }).ImageDecoder;
  if (ImageDecoderConstructor === undefined) return null;
  const decoder = new ImageDecoderConstructor({ data: bytes, type: 'image/gif' });
  await decoder.tracks.ready;
  const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
  const images: ImportedImage[] = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const { image } = await decoder.decode({ frameIndex });
    const canvas = document.createElement('canvas');
    canvas.width = image.displayWidth;
    canvas.height = image.displayHeight;
    canvas.getContext('2d', { willReadFrequently: true })!.drawImage(image, 0, 0);
    images.push({ name: `frame ${frameIndex + 1}`, canvas, delayInMilliseconds: (image.duration ?? 100_000) / 1000 });
    image.close();
  }
  decoder.close();
  return images;
}

async function decodeSingleFile(fileName: string, bytes: Uint8Array): Promise<ImportedSource> {
  const sourceName = baseName(fileName);
  if (isPng(bytes)) {
    const animated = await decodeAnimatedPng(bytes);
    if (animated !== null) {
      return {
        sourceName,
        wasAnimated: true,
        notes: [`Animated PNG with ${animated.frames.length} frames.`],
        images: animated.frames.map((canvas, frameIndex) => ({
          name: `${sourceName} ${frameIndex + 1}`,
          canvas,
          delayInMilliseconds: animated.delaysInMilliseconds[frameIndex] ?? 83,
        })),
      };
    }
  }
  if (/\.gif$/i.test(fileName)) {
    const gifFrames = await decodeAnimatedGif(bytes);
    if (gifFrames !== null && gifFrames.length > 1) {
      return {
        sourceName,
        wasAnimated: true,
        notes: [`Animated GIF with ${gifFrames.length} frames.`],
        images: gifFrames.map((image, frameIndex) => ({ ...image, name: `${sourceName} ${frameIndex + 1}` })),
      };
    }
    if (gifFrames === null) {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
      return {
        sourceName,
        wasAnimated: false,
        notes: ['This browser can only read the first frame of a GIF. Export an Animated PNG from Procreate to keep every frame.'],
        images: [{ name: sourceName, canvas: bitmapToCanvas(bitmap) }],
      };
    }
  }
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  const canvas = bitmapToCanvas(bitmap);
  bitmap.close();
  return { sourceName, wasAnimated: false, notes: [], images: [{ name: sourceName, canvas }] };
}

/** Reads every dropped or picked file. Zips are unpacked and their images sorted by name. */
export async function readImportFiles(files: readonly File[]): Promise<ImportedSource[]> {
  const sources: ImportedSource[] = [];
  const looseImages: ImportedImage[] = [];
  const looseNotes: string[] = [];
  const sortedFiles = [...files].sort((left, right) => naturalCompare(left.name, right.name));

  for (const file of sortedFiles) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      const entries = (await readZipArchive(bytes))
        .filter((entry) => imageFilePattern.test(entry.path) && !entry.path.includes('__MACOSX/') && !baseName(entry.path).startsWith('.'))
        .sort((left, right) => naturalCompare(left.path, right.path));
      const zipImages: ImportedImage[] = [];
      for (const entry of entries) {
        const decoded = await decodeSingleFile(entry.path, entry.bytes);
        zipImages.push(...decoded.images);
      }
      sources.push({ sourceName: baseName(file.name), images: zipImages, wasAnimated: false, notes: [`${zipImages.length} images from ${file.name}.`] });
      continue;
    }
    const decoded = await decodeSingleFile(file.name, bytes);
    if (decoded.wasAnimated) sources.push(decoded);
    else {
      looseImages.push(...decoded.images);
      looseNotes.push(...decoded.notes);
    }
  }
  if (looseImages.length > 0) {
    const commonName = looseImages.length === 1 ? looseImages[0]!.name : (looseImages[0]!.name.replace(/[\s_-]*\d+$/, '') || 'frames');
    sources.push({ sourceName: commonName, images: looseImages, wasAnimated: false, notes: looseNotes });
  }
  return sources;
}

/** Cuts a sheet into equal cells, left-to-right then top-to-bottom. */
export function sliceSheet(image: ImportedImage, columnCount: number, rowCount: number): ImportedImage[] {
  const cellWidth = Math.floor(image.canvas.width / columnCount);
  const cellHeight = Math.floor(image.canvas.height / rowCount);
  const slices: ImportedImage[] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = cellWidth;
      sliceCanvas.height = cellHeight;
      sliceCanvas.getContext('2d', { willReadFrequently: true })!.drawImage(image.canvas, columnIndex * cellWidth, rowIndex * cellHeight, cellWidth, cellHeight, 0, 0, cellWidth, cellHeight);
      slices.push({ name: `${image.name} r${rowIndex + 1}c${columnIndex + 1}`, canvas: sliceCanvas });
    }
  }
  return slices;
}

function pixelFingerprint(canvas: HTMLCanvasElement): number {
  const imageData = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  return crc32(new Uint8Array(imageData.data.buffer)) ^ (canvas.width * 65_521 + canvas.height);
}

function isFullyTransparent(canvas: HTMLCanvasElement): boolean {
  return opaqueBounds(canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height)) === null;
}

export interface ImportOptions {
  createAnimationNamed: string | null;
  ticksPerSecond: number | null;
  mergeRepeatedFrames: boolean;
  skipEmptyFrames: boolean;
}

/** Picks a tick rate from frame delays so holds come out as whole numbers. */
export function suggestTiming(images: readonly ImportedImage[]): { ticksPerSecond: number; holds: number[] } {
  const delays = images.map((image) => image.delayInMilliseconds).filter((delay): delay is number => delay !== undefined && delay > 0);
  if (delays.length !== images.length || delays.length === 0) return { ticksPerSecond: 12, holds: images.map(() => 1) };
  const shortestDelay = Math.min(...delays);
  const ticksPerSecond = Math.min(60, Math.max(1, Math.round(1000 / shortestDelay)));
  const tickLength = 1000 / ticksPerSecond;
  return { ticksPerSecond, holds: delays.map((delay) => Math.max(1, Math.round(delay / tickLength))) };
}

export async function commitImport(
  images: readonly ImportedImage[],
  options: ImportOptions,
  reportProgress: (completedCount: number, totalCount: number) => void,
): Promise<{ addedFrameCount: number; animationName: string | null }> {
  const project = requireProject();
  const timing = suggestTiming(images);

  // Collapse consecutive identical frames into holds and drop blanks.
  const keptFrames: { image: ImportedImage; holdTicks: number }[] = [];
  let previousFingerprint: number | null = null;
  images.forEach((image, imageIndex) => {
    if (options.skipEmptyFrames && isFullyTransparent(image.canvas)) return;
    const fingerprint = options.mergeRepeatedFrames ? pixelFingerprint(image.canvas) : null;
    const holdTicks = timing.holds[imageIndex] ?? 1;
    const lastKept = keptFrames.at(-1);
    if (fingerprint !== null && fingerprint === previousFingerprint && lastKept !== undefined) {
      lastKept.holdTicks += holdTicks;
      return;
    }
    previousFingerprint = fingerprint;
    keptFrames.push({ image, holdTicks });
  });
  if (keptFrames.length === 0) return { addedFrameCount: 0, animationName: null };

  const isFirstImport = project.frames.length === 0;
  const largestWidth = Math.max(...keptFrames.map(({ image }) => image.canvas.width));
  const largestHeight = Math.max(...keptFrames.map(({ image }) => image.canvas.height));
  if (isFirstImport) {
    mutateProject((mutableProject) => {
      mutableProject.cellWidth = largestWidth;
      mutableProject.cellHeight = largestHeight;
      mutableProject.pivotX = Math.round(largestWidth / 2);
      mutableProject.pivotY = largestHeight;
      // Small art is almost certainly pixel art; keep it crisp.
      if (largestWidth <= 128 && largestHeight <= 128) mutableProject.renderMode = 'pixel';
    });
  }

  const newFrames = keptFrames.map(({ image }) => {
    const record: FrameRecord = {
      id: createIdentifier(),
      name: image.name.slice(0, 80),
      width: image.canvas.width,
      height: image.canvas.height,
      // Same-size frames line up as-is; smaller ones start centered and standing on the cell floor.
      offsetX: Math.round((project.cellWidth - image.canvas.width) / 2),
      offsetY: project.cellHeight - image.canvas.height,
    };
    return { record, canvas: image.canvas };
  });

  let completedCount = 0;
  reportProgress(0, newFrames.length);
  const uploadQueue = [...newFrames];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let nextFrame = uploadQueue.shift(); nextFrame !== undefined; nextFrame = uploadQueue.shift()) {
        await api.uploadFramePixels(project.id, nextFrame.record.id, await canvasToPngBlob(nextFrame.canvas));
        reportProgress(++completedCount, newFrames.length);
      }
    }),
  );
  addFramesToProject(newFrames);

  let animationName: string | null = null;
  if (options.createAnimationNamed !== null) {
    animationName = uniqueAnimationName(options.createAnimationNamed);
    const animation = createAnimation(animationName, newFrames.map(({ record }) => record.id), options.ticksPerSecond ?? timing.ticksPerSecond);
    mutateProject(() => {
      animation.cells.forEach((cell, cellIndex) => (cell.holdTicks = keptFrames[cellIndex]?.holdTicks ?? 1));
    });
    setState({ stageMode: animation.cells.length > 1 ? 'play' : 'align', isPlaying: animation.cells.length > 1 });
  } else {
    setState({ focusedFrameId: newFrames[0]?.record.id ?? state.focusedFrameId });
  }
  return { addedFrameCount: newFrames.length, animationName };
}
