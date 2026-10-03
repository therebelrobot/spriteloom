// Every export format, plus the zip bundle that gathers them.
import type { AnimationRecord, FrameRecord, ProjectDocument } from '../../shared/project';
import { encodeAnimatedGif, type GifFrame } from '../formats/gif';
import { encodeAnimatedPng } from '../formats/png';
import { writeZipArchive, type ZipEntry } from '../formats/zip';
import { composeCellCanvas, opaqueBounds, playbackOrder } from '../render';
import { canvasToPngBlob } from '../store';
import { slugify } from '../ui/dom';

export interface ExportChoices {
  includePixiAtlas: boolean;
  includeGridSheet: boolean;
  includeGifs: boolean;
  includeAnimatedPngs: boolean;
  includeFramePngs: boolean;
  animationIdentifiers: Set<string>;
}

type ProgressReporter = (message: string) => void;

async function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Uint8Array(await (await canvasToPngBlob(canvas)).arrayBuffer());
}

function uniqueNames<Item>(items: readonly Item[], nameOf: (item: Item) => string): Map<Item, string> {
  const usedNames = new Set<string>();
  const names = new Map<Item, string>();
  for (const item of items) {
    const baseName = slugify(nameOf(item));
    let candidateName = baseName;
    for (let suffix = 2; usedNames.has(candidateName); suffix++) candidateName = `${baseName}-${suffix}`;
    usedNames.add(candidateName);
    names.set(item, candidateName);
  }
  return names;
}

function framesForExport(project: ProjectDocument, animations: readonly AnimationRecord[]): FrameRecord[] {
  const usedFrameIdentifiers = new Set(animations.flatMap((animation) => animation.cells.map((cell) => cell.frameId)));
  if (usedFrameIdentifiers.size === 0) return project.frames;
  return project.frames.filter((frame) => usedFrameIdentifiers.has(frame.id));
}

// ---------- PixiJS atlas ----------

interface PackedRectangle {
  frame: FrameRecord;
  sourceCanvas: HTMLCanvasElement;
  trimX: number;
  trimY: number;
  width: number;
  height: number;
  atlasX: number;
  atlasY: number;
}

/** Shelf packing: tallest first, rows left to right. Tries several widths and keeps the smallest sheet. */
function packRectangles(rectangles: PackedRectangle[], padding: number, maximumSize: number): { width: number; height: number } {
  const sortedRectangles = [...rectangles].sort((left, right) => right.height - left.height || right.width - left.width);
  const widestRectangle = Math.max(...rectangles.map((rectangle) => rectangle.width)) + padding * 2;
  const totalArea = rectangles.reduce((sum, rectangle) => sum + (rectangle.width + padding) * (rectangle.height + padding), 0);
  const candidateWidths = new Set<number>();
  for (let candidateWidth = 64; candidateWidth <= maximumSize; candidateWidth *= 2) {
    if (candidateWidth >= widestRectangle) candidateWidths.add(candidateWidth);
  }
  candidateWidths.add(Math.max(widestRectangle, Math.ceil(Math.sqrt(totalArea) * 1.05)));
  const averageWidth = rectangles.reduce((sum, rectangle) => sum + rectangle.width + padding, 0) / rectangles.length;
  for (let columnGuess = 1; columnGuess <= Math.min(64, rectangles.length); columnGuess++) {
    const candidateWidth = Math.ceil(columnGuess * averageWidth + padding);
    if (candidateWidth >= widestRectangle && candidateWidth <= maximumSize) candidateWidths.add(candidateWidth);
  }

  let bestLayout: { width: number; height: number; positions: [number, number][] } | null = null;
  for (const sheetWidth of candidateWidths) {
    const positions: [number, number][] = [];
    let cursorX = padding, cursorY = padding, shelfHeight = 0, usedWidth = 0;
    for (const rectangle of sortedRectangles) {
      if (cursorX + rectangle.width + padding > sheetWidth && cursorX > padding) {
        cursorX = padding;
        cursorY += shelfHeight + padding;
        shelfHeight = 0;
      }
      positions.push([cursorX, cursorY]);
      cursorX += rectangle.width + padding;
      usedWidth = Math.max(usedWidth, cursorX);
      shelfHeight = Math.max(shelfHeight, rectangle.height);
    }
    const sheetHeight = cursorY + shelfHeight + padding;
    const finalWidth = usedWidth;
    const fitsLimit = finalWidth <= maximumSize && sheetHeight <= maximumSize;
    // GPUs care about the longest side, so prefer the squarest sheet, then the smallest.
    const longestSide = Math.max(finalWidth, sheetHeight);
    const area = finalWidth * sheetHeight;
    const bestLongestSide = bestLayout === null ? Infinity : Math.max(bestLayout.width, bestLayout.height);
    const bestArea = bestLayout === null ? Infinity : bestLayout.width * bestLayout.height;
    if (bestLayout === null || (fitsLimit && (longestSide < bestLongestSide || (longestSide === bestLongestSide && area < bestArea)))) {
      bestLayout = { width: finalWidth, height: sheetHeight, positions };
    }
  }
  sortedRectangles.forEach((rectangle, rectangleIndex) => {
    const [atlasX, atlasY] = bestLayout!.positions[rectangleIndex]!;
    rectangle.atlasX = atlasX;
    rectangle.atlasY = atlasY;
  });
  return { width: bestLayout!.width, height: bestLayout!.height };
}

export async function buildPixiAtlas(
  project: ProjectDocument,
  animations: readonly AnimationRecord[],
): Promise<{ imageBytes: Uint8Array; json: string; imageFileName: string; jsonFileName: string; warning: string | null }> {
  const settings = project.exportSettings;
  const frames = framesForExport(project, animations);
  if (frames.length === 0) throw new Error('There are no frames to export yet.');
  const frameNames = uniqueNames(frames, (frame) => frame.name);
  const projectSlug = slugify(project.name);

  const rectangles: PackedRectangle[] = frames.map((frame) => {
    const cellCanvas = composeCellCanvas(project, frame);
    let trimX = 0, trimY = 0, width = cellCanvas.width, height = cellCanvas.height;
    if (settings.trimTransparentEdges) {
      const bounds = opaqueBounds(cellCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, cellCanvas.width, cellCanvas.height));
      if (bounds === null) {
        width = 1;
        height = 1;
      } else {
        ({ x: trimX, y: trimY, width, height } = bounds);
      }
    }
    return { frame, sourceCanvas: cellCanvas, trimX, trimY, width, height, atlasX: 0, atlasY: 0 };
  });

  const sheetSize = packRectangles(rectangles, settings.atlasPadding, settings.maximumAtlasSize);
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = sheetSize.width;
  atlasCanvas.height = sheetSize.height;
  const atlasContext = atlasCanvas.getContext('2d')!;
  for (const rectangle of rectangles) {
    atlasContext.drawImage(rectangle.sourceCanvas, rectangle.trimX, rectangle.trimY, rectangle.width, rectangle.height, rectangle.atlasX, rectangle.atlasY, rectangle.width, rectangle.height);
  }

  const anchor = { x: project.pivotX / project.cellWidth, y: project.pivotY / project.cellHeight };
  const framesJson: Record<string, unknown> = {};
  for (const rectangle of rectangles) {
    framesJson[frameNames.get(rectangle.frame)!] = {
      frame: { x: rectangle.atlasX, y: rectangle.atlasY, w: rectangle.width, h: rectangle.height },
      rotated: false,
      trimmed: rectangle.width !== project.cellWidth || rectangle.height !== project.cellHeight,
      spriteSourceSize: { x: rectangle.trimX, y: rectangle.trimY, w: rectangle.width, h: rectangle.height },
      sourceSize: { w: project.cellWidth, h: project.cellHeight },
      anchor,
    };
  }

  const frameNameByIdentifier = new Map(frames.map((frame) => [frame.id, frameNames.get(frame)!]));
  const animationNames = uniqueNames(animations, (animation) => animation.name);
  const animationsJson: Record<string, string[]> = {};
  const timingJson: Record<string, unknown> = {};
  for (const animation of animations) {
    const animationName = animationNames.get(animation)!;
    // PixiJS plays one texture per tick, so holds become repeated names.
    animationsJson[animationName] = playbackOrder(animation).flatMap((timedCell) =>
      Array.from({ length: timedCell.holdTicks }, () => frameNameByIdentifier.get(timedCell.frameId)!),
    );
    timingJson[animationName] = {
      ticksPerSecond: animation.ticksPerSecond,
      loopMode: animation.loopMode,
      // AnimatedSprite.animationSpeed when the ticker runs at 60 fps.
      pixiAnimationSpeed: animation.ticksPerSecond / 60,
      cells: animation.cells.map((cell) => ({ frame: frameNameByIdentifier.get(cell.frameId), holdTicks: cell.holdTicks })),
    };
  }

  const imageFileName = `${projectSlug}.png`;
  const json = JSON.stringify(
    {
      frames: framesJson,
      animations: animationsJson,
      meta: {
        app: 'spriteloom',
        version: '1',
        image: imageFileName,
        format: 'RGBA8888',
        size: { w: sheetSize.width, h: sheetSize.height },
        scale: 1,
        spriteloom: {
          renderMode: project.renderMode,
          scaleMode: project.renderMode === 'pixel' ? 'nearest' : 'linear',
          cellSize: { w: project.cellWidth, h: project.cellHeight },
          pivot: { x: project.pivotX, y: project.pivotY },
          animations: timingJson,
        },
      },
    },
    null,
    2,
  );
  const warning =
    sheetSize.width > settings.maximumAtlasSize || sheetSize.height > settings.maximumAtlasSize
      ? `The atlas is ${sheetSize.width}×${sheetSize.height}, larger than the ${settings.maximumAtlasSize}px limit. Some devices won't load it; consider trimming or smaller frames.`
      : null;
  return { imageBytes: await canvasPngBytes(atlasCanvas), json, imageFileName, jsonFileName: `${projectSlug}.json`, warning };
}

// ---------- uniform grid ----------

export async function buildGridSheet(project: ProjectDocument, animations: readonly AnimationRecord[]): Promise<{ imageBytes: Uint8Array; json: string }> {
  const rows: { name: string; frames: FrameRecord[] }[] =
    animations.length > 0
      ? animations.map((animation) => ({
          name: animation.name,
          frames: animation.cells.map((cell) => project.frames.find((frame) => frame.id === cell.frameId)!).filter(Boolean),
        }))
      : [];
  let columnCount: number;
  if (rows.length === 0) {
    columnCount = Math.max(1, Math.ceil(Math.sqrt(project.frames.length)));
    for (let rowStart = 0; rowStart < project.frames.length; rowStart += columnCount) {
      rows.push({ name: `row ${rows.length + 1}`, frames: project.frames.slice(rowStart, rowStart + columnCount) });
    }
  } else {
    columnCount = Math.max(1, ...rows.map((row) => row.frames.length));
  }
  if (rows.length === 0) throw new Error('There are no frames to export yet.');

  const gridCanvas = document.createElement('canvas');
  gridCanvas.width = columnCount * project.cellWidth;
  gridCanvas.height = rows.length * project.cellHeight;
  const gridContext = gridCanvas.getContext('2d')!;
  rows.forEach((row, rowIndex) => {
    row.frames.forEach((frame, columnIndex) => {
      gridContext.save();
      gridContext.beginPath();
      gridContext.rect(columnIndex * project.cellWidth, rowIndex * project.cellHeight, project.cellWidth, project.cellHeight);
      gridContext.clip();
      gridContext.translate(columnIndex * project.cellWidth, rowIndex * project.cellHeight);
      gridContext.drawImage(composeCellCanvas(project, frame), 0, 0);
      gridContext.restore();
    });
  });
  const json = JSON.stringify(
    {
      cellWidth: project.cellWidth,
      cellHeight: project.cellHeight,
      columns: columnCount,
      rows: rows.map((row, rowIndex) => {
        const animation = animations[rowIndex];
        return {
          name: row.name,
          row: rowIndex,
          frameCount: row.frames.length,
          ticksPerSecond: animation?.ticksPerSecond,
          loopMode: animation?.loopMode,
          holdTicks: animation?.cells.map((cell) => cell.holdTicks),
        };
      }),
      pivot: { x: project.pivotX, y: project.pivotY },
    },
    null,
    2,
  );
  return { imageBytes: await canvasPngBytes(gridCanvas), json };
}

// ---------- animated previews ----------

function scaledCellPixels(project: ProjectDocument, frame: FrameRecord, scale: number, background: string | null): Uint8ClampedArray {
  const cellCanvas = composeCellCanvas(project, frame);
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = project.cellWidth * scale;
  outputCanvas.height = project.cellHeight * scale;
  const outputContext = outputCanvas.getContext('2d', { willReadFrequently: true })!;
  if (background !== null) {
    outputContext.fillStyle = background;
    outputContext.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
  }
  outputContext.imageSmoothingEnabled = project.renderMode === 'smooth';
  outputContext.imageSmoothingQuality = 'high';
  outputContext.drawImage(cellCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
  return outputContext.getImageData(0, 0, outputCanvas.width, outputCanvas.height).data;
}

export function buildAnimatedGif(project: ProjectDocument, animation: AnimationRecord): Uint8Array {
  const { previewScale, previewBackground } = project.exportSettings;
  const frameById = new Map(project.frames.map((frame) => [frame.id, frame]));
  const gifFrames: GifFrame[] = [];
  // GIF delays are whole centiseconds; carry the rounding error forward so long loops stay on time.
  let accumulatedError = 0;
  for (const timedCell of playbackOrder(animation)) {
    const frame = frameById.get(timedCell.frameId);
    if (frame === undefined) continue;
    const exactDelay = (timedCell.holdTicks / animation.ticksPerSecond) * 100 + accumulatedError;
    const roundedDelay = Math.max(2, Math.round(exactDelay));
    accumulatedError = exactDelay - roundedDelay;
    gifFrames.push({ rgbaPixels: scaledCellPixels(project, frame, previewScale, previewBackground), delayInCentiseconds: roundedDelay });
  }
  return encodeAnimatedGif(project.cellWidth * previewScale, project.cellHeight * previewScale, gifFrames, animation.loopMode !== 'once');
}

export async function buildAnimatedPng(project: ProjectDocument, animation: AnimationRecord): Promise<Uint8Array> {
  const { previewScale, previewBackground } = project.exportSettings;
  const frameById = new Map(project.frames.map((frame) => [frame.id, frame]));
  const frames = playbackOrder(animation)
    .filter((timedCell) => frameById.has(timedCell.frameId))
    .map((timedCell) => ({
      rgbaPixels: scaledCellPixels(project, frameById.get(timedCell.frameId)!, previewScale, previewBackground),
      delayNumerator: timedCell.holdTicks,
      delayDenominator: animation.ticksPerSecond,
    }));
  return encodeAnimatedPng(project.cellWidth * previewScale, project.cellHeight * previewScale, frames, animation.loopMode === 'once' ? 1 : 0);
}

// ---------- bundle ----------

export async function buildExportBundle(
  project: ProjectDocument,
  choices: ExportChoices,
  reportProgress: ProgressReporter,
): Promise<{ zipBytes: Uint8Array; fileName: string; warnings: string[] }> {
  const animations = project.animations.filter((animation) => choices.animationIdentifiers.has(animation.id) && animation.cells.length > 0);
  const animationNames = uniqueNames(animations, (animation) => animation.name);
  const projectSlug = slugify(project.name);
  const entries: ZipEntry[] = [];
  const warnings: string[] = [];
  const textEncoder = new TextEncoder();

  if (choices.includePixiAtlas) {
    reportProgress('Packing the atlas');
    const atlas = await buildPixiAtlas(project, animations);
    entries.push({ path: `pixi/${atlas.imageFileName}`, bytes: atlas.imageBytes }, { path: `pixi/${atlas.jsonFileName}`, bytes: textEncoder.encode(atlas.json) });
    if (atlas.warning !== null) warnings.push(atlas.warning);
  }
  if (choices.includeGridSheet) {
    reportProgress('Laying out the grid sheet');
    const grid = await buildGridSheet(project, animations);
    entries.push({ path: `grid/${projectSlug}-grid.png`, bytes: grid.imageBytes }, { path: `grid/${projectSlug}-grid.json`, bytes: textEncoder.encode(grid.json) });
  }
  for (const animation of animations) {
    const animationSlug = animationNames.get(animation)!;
    if (choices.includeGifs) {
      reportProgress(`Encoding ${animation.name}.gif`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      entries.push({ path: `gif/${animationSlug}.gif`, bytes: buildAnimatedGif(project, animation) });
    }
    if (choices.includeAnimatedPngs) {
      reportProgress(`Encoding ${animation.name}.png (animated)`);
      entries.push({ path: `apng/${animationSlug}.png`, bytes: await buildAnimatedPng(project, animation) });
    }
    if (choices.includeFramePngs) {
      reportProgress(`Writing ${animation.name} frames`);
      for (const [cellIndex, cell] of animation.cells.entries()) {
        const frame = project.frames.find((candidate) => candidate.id === cell.frameId);
        if (frame === undefined) continue;
        entries.push({
          path: `frames/${animationSlug}/${animationSlug}_${String(cellIndex).padStart(3, '0')}.png`,
          bytes: await canvasPngBytes(composeCellCanvas(project, frame)),
        });
      }
    }
  }
  if (choices.includeFramePngs && animations.length === 0) {
    const frameNames = uniqueNames(project.frames, (frame) => frame.name);
    for (const frame of project.frames) {
      entries.push({ path: `frames/${frameNames.get(frame)}.png`, bytes: await canvasPngBytes(composeCellCanvas(project, frame)) });
    }
  }
  if (entries.length === 0) throw new Error('Pick at least one format, and make sure the chosen animations have frames.');
  reportProgress('Zipping');
  return { zipBytes: writeZipArchive(entries), fileName: `${projectSlug}-sprites.zip`, warnings };
}
