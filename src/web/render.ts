// Shared drawing helpers: composing a frame into its cell, onion-skin tints, timing.
import type { AnimationRecord, FrameRecord, ProjectDocument } from '../shared/project';
import { frameCanvases, frameVersions } from './store';

export interface TimedCell {
  cellIndex: number;
  frameId: string;
  holdTicks: number;
}

/** Expands loop modes into the order cells are actually shown. */
export function playbackOrder(animation: AnimationRecord): TimedCell[] {
  const forward = animation.cells.map((cell, cellIndex) => ({ cellIndex, frameId: cell.frameId, holdTicks: cell.holdTicks }));
  if (animation.loopMode !== 'pingpong' || forward.length < 3) return forward;
  return [...forward, ...forward.slice(1, -1).reverse()];
}

export function totalTicks(animation: AnimationRecord): number {
  return playbackOrder(animation).reduce((sum, timedCell) => sum + timedCell.holdTicks, 0);
}

export function formatDuration(animation: AnimationRecord): string {
  const ticks = totalTicks(animation);
  const seconds = ticks / animation.ticksPerSecond;
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s · ${ticks} tick${ticks === 1 ? '' : 's'}`;
}

/** Draws a frame into cell space on the given context (the caller sets transforms). */
export function drawFrameInCell(context: CanvasRenderingContext2D, frame: FrameRecord): void {
  const frameCanvas = frameCanvases.get(frame.id);
  if (frameCanvas !== undefined) context.drawImage(frameCanvas, frame.offsetX, frame.offsetY);
}

/** Renders one frame at full cell size, clipped to the cell, for exporting. */
export function composeCellCanvas(project: ProjectDocument, frame: FrameRecord, backgroundColor: string | null = null): HTMLCanvasElement {
  const cellCanvas = document.createElement('canvas');
  cellCanvas.width = project.cellWidth;
  cellCanvas.height = project.cellHeight;
  const cellContext = cellCanvas.getContext('2d', { willReadFrequently: true })!;
  if (backgroundColor !== null) {
    cellContext.fillStyle = backgroundColor;
    cellContext.fillRect(0, 0, cellCanvas.width, cellCanvas.height);
  }
  drawFrameInCell(cellContext, frame);
  return cellCanvas;
}

const tintCache = new Map<string, { version: number; canvas: HTMLCanvasElement }>();

/** A flat-colored silhouette of a frame, used for onion skins (blue = before, red = after). */
export function tintedFrameCanvas(frame: FrameRecord, tintColor: string): HTMLCanvasElement | undefined {
  const sourceCanvas = frameCanvases.get(frame.id);
  if (sourceCanvas === undefined) return undefined;
  const cacheKey = `${frame.id}:${tintColor}`;
  const currentVersion = frameVersions.get(frame.id) ?? 0;
  const cached = tintCache.get(cacheKey);
  if (cached !== undefined && cached.version === currentVersion) return cached.canvas;
  const tintCanvas = cached?.canvas ?? document.createElement('canvas');
  tintCanvas.width = sourceCanvas.width;
  tintCanvas.height = sourceCanvas.height;
  const tintContext = tintCanvas.getContext('2d')!;
  tintContext.clearRect(0, 0, tintCanvas.width, tintCanvas.height);
  tintContext.drawImage(sourceCanvas, 0, 0);
  tintContext.globalCompositeOperation = 'source-in';
  tintContext.fillStyle = tintColor;
  tintContext.fillRect(0, 0, tintCanvas.width, tintCanvas.height);
  tintContext.globalCompositeOperation = 'source-over';
  tintCache.set(cacheKey, { version: currentVersion, canvas: tintCanvas });
  return tintCanvas;
}

const thumbnailCache = new Map<string, { version: number; dataUrl: string }>();
const thumbnailSize = 112;

/** A small preview of a frame as it sits in its cell. Cached by frame version + offset. */
export function frameThumbnailUrl(project: ProjectDocument, frame: FrameRecord): string {
  const cacheKey = `${frame.id}:${frame.offsetX}:${frame.offsetY}:${project.cellWidth}x${project.cellHeight}:${project.renderMode}`;
  const currentVersion = frameVersions.get(frame.id) ?? 0;
  const cached = thumbnailCache.get(cacheKey);
  if (cached !== undefined && cached.version === currentVersion) return cached.dataUrl;
  const scale = Math.min(thumbnailSize / project.cellWidth, thumbnailSize / project.cellHeight);
  const thumbnailCanvas = document.createElement('canvas');
  thumbnailCanvas.width = Math.max(1, Math.round(project.cellWidth * scale));
  thumbnailCanvas.height = Math.max(1, Math.round(project.cellHeight * scale));
  const thumbnailContext = thumbnailCanvas.getContext('2d')!;
  thumbnailContext.imageSmoothingEnabled = project.renderMode === 'smooth' || scale < 1;
  thumbnailContext.imageSmoothingQuality = 'high';
  thumbnailContext.scale(scale, scale);
  drawFrameInCell(thumbnailContext, frame);
  const dataUrl = thumbnailCanvas.toDataURL('image/png');
  for (const existingKey of thumbnailCache.keys()) if (existingKey.startsWith(`${frame.id}:`)) thumbnailCache.delete(existingKey);
  thumbnailCache.set(cacheKey, { version: currentVersion, dataUrl });
  return dataUrl;
}

/** Bounding box of non-transparent pixels, or null if the image is empty. */
export function opaqueBounds(imageData: ImageData): { x: number; y: number; width: number; height: number } | null {
  const { width, height, data } = imageData;
  let minimumX = width, minimumY = height, maximumX = -1, maximumY = -1;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const rowStart = rowIndex * width * 4;
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      if (data[rowStart + columnIndex * 4 + 3] !== 0) {
        if (columnIndex < minimumX) minimumX = columnIndex;
        if (columnIndex > maximumX) maximumX = columnIndex;
        if (rowIndex < minimumY) minimumY = rowIndex;
        maximumY = rowIndex;
      }
    }
  }
  if (maximumX < 0) return null;
  return { x: minimumX, y: minimumY, width: maximumX - minimumX + 1, height: maximumY - minimumY + 1 };
}
