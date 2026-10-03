// The project document shared by the server (storage + validation) and the web app.
// Frame pixels live next to it as PNG files; this JSON only describes them.

export type RenderMode = 'pixel' | 'smooth';
export type LoopMode = 'loop' | 'pingpong' | 'once';

export interface FrameRecord {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Where the frame's top-left corner sits inside the project cell, in cell pixels. */
  offsetX: number;
  offsetY: number;
}

export interface AnimationCell {
  frameId: string;
  /** How many ticks this frame stays on screen ("on ones", "on twos", ...). */
  holdTicks: number;
}

export interface AnimationRecord {
  id: string;
  name: string;
  /** Ticks per second. A cell held for 2 ticks at 12 fps lasts 1/6 s. */
  ticksPerSecond: number;
  loopMode: LoopMode;
  cells: AnimationCell[];
}

export interface ExportSettings {
  atlasPadding: number;
  trimTransparentEdges: boolean;
  maximumAtlasSize: number;
  previewScale: number;
  previewBackground: string | null;
}

export interface ProjectDocument {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  renderMode: RenderMode;
  cellWidth: number;
  cellHeight: number;
  /** Anchor point in cell pixels; exported as a normalized anchor for PixiJS. */
  pivotX: number;
  pivotY: number;
  stageBackground: string;
  frames: FrameRecord[];
  animations: AnimationRecord[];
  exportSettings: ExportSettings;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  frameCount: number;
  animationCount: number;
  coverFrameId: string | null;
}

export const identifierPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createIdentifier(): string {
  const randomBytes = new Uint8Array(9);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byteValue) => byteValue.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 14);
}

export function defaultExportSettings(): ExportSettings {
  return {
    atlasPadding: 2,
    trimTransparentEdges: true,
    maximumAtlasSize: 4096,
    previewScale: 1,
    previewBackground: null,
  };
}

export function createEmptyProject(projectName: string): ProjectDocument {
  const nowIsoString = new Date().toISOString();
  return {
    id: createIdentifier(),
    name: projectName,
    revision: 0,
    createdAt: nowIsoString,
    updatedAt: nowIsoString,
    renderMode: 'smooth',
    cellWidth: 256,
    cellHeight: 256,
    pivotX: 128,
    pivotY: 256,
    stageBackground: 'lighttable',
    frames: [],
    animations: [],
    exportSettings: defaultExportSettings(),
  };
}

function isFiniteNumber(candidate: unknown): candidate is number {
  return typeof candidate === 'number' && Number.isFinite(candidate);
}

function clampInteger(candidate: unknown, minimum: number, maximum: number, fallback: number): number {
  if (!isFiniteNumber(candidate)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(candidate)));
}

function cleanText(candidate: unknown, fallback: string, maximumLength = 120): string {
  if (typeof candidate !== 'string') return fallback;
  const trimmedText = candidate.trim().slice(0, maximumLength);
  return trimmedText.length > 0 ? trimmedText : fallback;
}

/**
 * Coerces untrusted JSON into a well-formed project. Unknown fields are dropped,
 * numbers are clamped, and animation cells pointing at missing frames are removed.
 * Throws only when the input is not an object at all.
 */
export function sanitizeProject(untrustedInput: unknown, projectIdentifier: string): ProjectDocument {
  if (typeof untrustedInput !== 'object' || untrustedInput === null) {
    throw new Error('Project must be a JSON object.');
  }
  const input = untrustedInput as Record<string, unknown>;
  const fallbackProject = createEmptyProject('Untitled sprite');

  const seenFrameIdentifiers = new Set<string>();
  const frames: FrameRecord[] = [];
  for (const untrustedFrame of Array.isArray(input.frames) ? input.frames : []) {
    if (typeof untrustedFrame !== 'object' || untrustedFrame === null) continue;
    const frameInput = untrustedFrame as Record<string, unknown>;
    if (typeof frameInput.id !== 'string' || !identifierPattern.test(frameInput.id)) continue;
    if (seenFrameIdentifiers.has(frameInput.id)) continue;
    seenFrameIdentifiers.add(frameInput.id);
    frames.push({
      id: frameInput.id,
      name: cleanText(frameInput.name, 'frame'),
      width: clampInteger(frameInput.width, 1, 8192, 1),
      height: clampInteger(frameInput.height, 1, 8192, 1),
      offsetX: clampInteger(frameInput.offsetX, -8192, 8192, 0),
      offsetY: clampInteger(frameInput.offsetY, -8192, 8192, 0),
    });
  }

  const animations: AnimationRecord[] = [];
  const seenAnimationIdentifiers = new Set<string>();
  for (const untrustedAnimation of Array.isArray(input.animations) ? input.animations : []) {
    if (typeof untrustedAnimation !== 'object' || untrustedAnimation === null) continue;
    const animationInput = untrustedAnimation as Record<string, unknown>;
    if (typeof animationInput.id !== 'string' || !identifierPattern.test(animationInput.id)) continue;
    if (seenAnimationIdentifiers.has(animationInput.id)) continue;
    seenAnimationIdentifiers.add(animationInput.id);
    const loopMode: LoopMode =
      animationInput.loopMode === 'pingpong' || animationInput.loopMode === 'once' ? animationInput.loopMode : 'loop';
    const cells: AnimationCell[] = [];
    for (const untrustedCell of Array.isArray(animationInput.cells) ? animationInput.cells : []) {
      if (typeof untrustedCell !== 'object' || untrustedCell === null) continue;
      const cellInput = untrustedCell as Record<string, unknown>;
      if (typeof cellInput.frameId !== 'string' || !seenFrameIdentifiers.has(cellInput.frameId)) continue;
      cells.push({ frameId: cellInput.frameId, holdTicks: clampInteger(cellInput.holdTicks, 1, 240, 1) });
    }
    animations.push({
      id: animationInput.id,
      name: cleanText(animationInput.name, 'animation'),
      ticksPerSecond: clampInteger(animationInput.ticksPerSecond, 1, 120, 12),
      loopMode,
      cells,
    });
  }

  const exportInput = (typeof input.exportSettings === 'object' && input.exportSettings !== null
    ? input.exportSettings
    : {}) as Record<string, unknown>;
  const defaults = defaultExportSettings();
  const previewBackground =
    typeof exportInput.previewBackground === 'string' && /^#[0-9a-f]{6}$/i.test(exportInput.previewBackground)
      ? exportInput.previewBackground
      : null;

  const cellWidth = clampInteger(input.cellWidth, 1, 8192, fallbackProject.cellWidth);
  const cellHeight = clampInteger(input.cellHeight, 1, 8192, fallbackProject.cellHeight);

  return {
    id: projectIdentifier,
    name: cleanText(input.name, 'Untitled sprite'),
    revision: clampInteger(input.revision, 0, Number.MAX_SAFE_INTEGER, 0),
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : fallbackProject.createdAt,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : fallbackProject.updatedAt,
    renderMode: input.renderMode === 'pixel' ? 'pixel' : 'smooth',
    cellWidth,
    cellHeight,
    pivotX: clampInteger(input.pivotX, -8192, 16384, Math.round(cellWidth / 2)),
    pivotY: clampInteger(input.pivotY, -8192, 16384, cellHeight),
    stageBackground: cleanText(input.stageBackground, 'lighttable', 16),
    frames,
    animations,
    exportSettings: {
      atlasPadding: clampInteger(exportInput.atlasPadding, 0, 32, defaults.atlasPadding),
      trimTransparentEdges:
        typeof exportInput.trimTransparentEdges === 'boolean'
          ? exportInput.trimTransparentEdges
          : defaults.trimTransparentEdges,
      maximumAtlasSize: clampInteger(exportInput.maximumAtlasSize, 256, 16384, defaults.maximumAtlasSize),
      previewScale: clampInteger(exportInput.previewScale, 1, 16, defaults.previewScale),
      previewBackground,
    },
  };
}
