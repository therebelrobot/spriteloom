// Editor state, project mutations, autosave, and the in-memory frame pixels.
import {
  createIdentifier,
  type AnimationRecord,
  type FrameRecord,
  type ProjectDocument,
} from '../shared/project';
import * as api from './api';

export type StageMode = 'play' | 'align' | 'draw';
export type DrawTool = 'pencil' | 'eraser' | 'picker';
export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'conflict' | 'offline';

export interface EditorState {
  project: ProjectDocument | null;
  focusedFrameId: string | null;
  selectedAnimationId: string | null;
  timelineCursor: number;
  stageMode: StageMode;
  isPlaying: boolean;
  onionSkinEnabled: boolean;
  onionSkinDepth: number;
  isPlacingPivot: boolean;
  isSelectingInLibrary: boolean;
  librarySelection: Set<string>;
  drawTool: DrawTool;
  brushSize: number;
  brushColor: string;
  brushOpacity: number;
  saveStatus: SaveStatus;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let notifyScheduled = false;

export const state: EditorState = {
  project: null,
  focusedFrameId: null,
  selectedAnimationId: null,
  timelineCursor: 0,
  stageMode: 'align',
  isPlaying: false,
  onionSkinEnabled: true,
  onionSkinDepth: 1,
  isPlacingPivot: false,
  isSelectingInLibrary: false,
  librarySelection: new Set(),
  drawTool: 'pencil',
  brushSize: 4,
  brushColor: '#2b2d42',
  brushOpacity: 1,
  saveStatus: 'saved',
};

/** Frame pixels, one canvas per frame, plus a version number that bumps on every edit. */
export const frameCanvases = new Map<string, HTMLCanvasElement>();
export const frameVersions = new Map<string, number>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Batches notifications into one per animation frame. */
export function notify(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  requestAnimationFrame(() => {
    notifyScheduled = false;
    for (const listener of listeners) listener();
  });
}

export function setState(partialState: Partial<EditorState>): void {
  Object.assign(state, partialState);
  notify();
}

// ---------- derived lookups ----------

export function requireProject(): ProjectDocument {
  if (state.project === null) throw new Error('No project is open.');
  return state.project;
}

export function findFrame(frameIdentifier: string | null): FrameRecord | undefined {
  if (frameIdentifier === null) return undefined;
  return state.project?.frames.find((frame) => frame.id === frameIdentifier);
}

export function selectedAnimation(): AnimationRecord | undefined {
  return state.project?.animations.find((animation) => animation.id === state.selectedAnimationId);
}

/** The frame the stage shows when not playing. */
export function focusedFrame(): FrameRecord | undefined {
  return findFrame(state.focusedFrameId);
}

export function bumpFrameVersion(frameIdentifier: string): void {
  frameVersions.set(frameIdentifier, (frameVersions.get(frameIdentifier) ?? 0) + 1);
}

// ---------- opening projects ----------

async function loadFramePixels(projectIdentifier: string, frame: FrameRecord): Promise<void> {
  const response = await fetch(api.framePixelsUrl(projectIdentifier, frame.id));
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = frame.width;
  frameCanvas.height = frame.height;
  if (response.ok) {
    const bitmap = await createImageBitmap(await response.blob());
    frameCanvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  frameCanvases.set(frame.id, frameCanvas);
  bumpFrameVersion(frame.id);
}

export async function openProject(projectIdentifier: string): Promise<void> {
  const project = await api.fetchProject(projectIdentifier);
  frameCanvases.clear();
  frameVersions.clear();
  undoStacks.clear();
  redoStacks.clear();
  const framesToLoad = [...project.frames];
  const parallelLoaders = Array.from({ length: 6 }, async () => {
    for (let frame = framesToLoad.shift(); frame !== undefined; frame = framesToLoad.shift()) {
      await loadFramePixels(project.id, frame);
    }
  });
  await Promise.all(parallelLoaders);
  lastSavedRevision = project.revision;
  const firstAnimation = project.animations[0];
  setState({
    project,
    selectedAnimationId: firstAnimation?.id ?? null,
    timelineCursor: 0,
    focusedFrameId: firstAnimation?.cells[0]?.frameId ?? project.frames[0]?.id ?? null,
    isPlaying: false,
    stageMode: firstAnimation !== undefined && firstAnimation.cells.length > 1 ? 'play' : 'align',
    isSelectingInLibrary: false,
    librarySelection: new Set(),
    saveStatus: 'saved',
  });
}

export function closeProject(): void {
  void flushSave();
  frameCanvases.clear();
  frameVersions.clear();
  setState({ project: null, focusedFrameId: null, selectedAnimationId: null, isPlaying: false });
}

// ---------- autosave ----------

let lastSavedRevision = 0;
let saveTimer: number | undefined;
let saveInFlight: Promise<void> | null = null;
let changedSinceLastSave = false;

export function mutateProject(mutation: (project: ProjectDocument) => void): void {
  const project = requireProject();
  mutation(project);
  changedSinceLastSave = true;
  state.saveStatus = state.saveStatus === 'conflict' ? 'conflict' : 'unsaved';
  notify();
  scheduleSave();
}

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), 600);
}

export async function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer);
  if (saveInFlight !== null) {
    await saveInFlight;
    if (changedSinceLastSave) return flushSave();
    return;
  }
  const project = state.project;
  if (project === null || !changedSinceLastSave || state.saveStatus === 'conflict') return;
  changedSinceLastSave = false;
  setState({ saveStatus: 'saving' });
  saveInFlight = (async () => {
    try {
      const savedProject = await api.saveProject(project, lastSavedRevision);
      lastSavedRevision = savedProject.revision;
      if (state.project === project) {
        project.revision = savedProject.revision;
        project.updatedAt = savedProject.updatedAt;
      }
      setState({ saveStatus: changedSinceLastSave ? 'unsaved' : 'saved' });
    } catch (error) {
      if (error instanceof api.ConflictError) {
        setState({ saveStatus: 'conflict' });
      } else {
        changedSinceLastSave = true;
        setState({ saveStatus: 'offline' });
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void flushSave(), 5000);
      }
    } finally {
      saveInFlight = null;
    }
  })();
  await saveInFlight;
  if (changedSinceLastSave && (state.saveStatus as SaveStatus) !== 'conflict') scheduleSave();
}

export function hasUnsavedWork(): boolean {
  return changedSinceLastSave || saveInFlight !== null || pendingFrameUploads.size > 0;
}

// ---------- frame pixel uploads ----------

const pendingFrameUploads = new Map<string, number>();

export function canvasToPngBlob(sourceCanvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolvePromise, rejectPromise) => {
    sourceCanvas.toBlob((blob) => (blob === null ? rejectPromise(new Error('Could not encode PNG.')) : resolvePromise(blob)), 'image/png');
  });
}

export async function uploadFrameNow(frameIdentifier: string): Promise<void> {
  const project = requireProject();
  const frameCanvas = frameCanvases.get(frameIdentifier);
  if (frameCanvas === undefined) return;
  await api.uploadFramePixels(project.id, frameIdentifier, await canvasToPngBlob(frameCanvas));
}

/** Debounced upload after drawing, so a flurry of strokes sends one PNG. */
export function scheduleFrameUpload(frameIdentifier: string): void {
  window.clearTimeout(pendingFrameUploads.get(frameIdentifier));
  state.saveStatus = 'unsaved';
  pendingFrameUploads.set(
    frameIdentifier,
    window.setTimeout(async () => {
      try {
        await uploadFrameNow(frameIdentifier);
        pendingFrameUploads.delete(frameIdentifier);
        if (!changedSinceLastSave && saveInFlight === null && state.saveStatus !== 'conflict') setState({ saveStatus: 'saved' });
      } catch {
        pendingFrameUploads.delete(frameIdentifier);
        setState({ saveStatus: 'offline' });
        scheduleFrameUpload(frameIdentifier);
      }
    }, 800),
  );
  notify();
}

// ---------- frame operations ----------

export function addFramesToProject(newFrames: { record: FrameRecord; canvas: HTMLCanvasElement }[]): void {
  for (const { record, canvas } of newFrames) {
    frameCanvases.set(record.id, canvas);
    bumpFrameVersion(record.id);
  }
  mutateProject((project) => project.frames.push(...newFrames.map((newFrame) => newFrame.record)));
}

export async function duplicateFrame(frameIdentifier: string): Promise<FrameRecord | undefined> {
  const project = requireProject();
  const sourceFrame = findFrame(frameIdentifier);
  const sourceCanvas = frameCanvases.get(frameIdentifier);
  if (sourceFrame === undefined || sourceCanvas === undefined) return undefined;
  const copyCanvas = document.createElement('canvas');
  copyCanvas.width = sourceCanvas.width;
  copyCanvas.height = sourceCanvas.height;
  copyCanvas.getContext('2d')!.drawImage(sourceCanvas, 0, 0);
  const copyRecord: FrameRecord = { ...sourceFrame, id: createIdentifier(), name: `${sourceFrame.name} copy` };
  frameCanvases.set(copyRecord.id, copyCanvas);
  bumpFrameVersion(copyRecord.id);
  await api.uploadFramePixels(project.id, copyRecord.id, await canvasToPngBlob(copyCanvas));
  mutateProject((mutableProject) => {
    const sourceIndex = mutableProject.frames.findIndex((frame) => frame.id === frameIdentifier);
    mutableProject.frames.splice(sourceIndex + 1, 0, copyRecord);
  });
  return copyRecord;
}

export function deleteFrames(frameIdentifiers: Set<string>): void {
  mutateProject((project) => {
    project.frames = project.frames.filter((frame) => !frameIdentifiers.has(frame.id));
    for (const animation of project.animations) {
      animation.cells = animation.cells.filter((cell) => !frameIdentifiers.has(cell.frameId));
    }
  });
  for (const frameIdentifier of frameIdentifiers) frameCanvases.delete(frameIdentifier);
  if (state.focusedFrameId !== null && frameIdentifiers.has(state.focusedFrameId)) {
    const animation = selectedAnimation();
    setState({ focusedFrameId: animation?.cells[0]?.frameId ?? state.project?.frames[0]?.id ?? null, timelineCursor: 0 });
  }
}

/** Grows a frame's canvas to the full cell so you can draw anywhere in it. */
export async function expandFrameToCell(frameIdentifier: string): Promise<void> {
  const project = requireProject();
  const frame = findFrame(frameIdentifier);
  const sourceCanvas = frameCanvases.get(frameIdentifier);
  if (frame === undefined || sourceCanvas === undefined) return;
  // Expanding is lossless and changes the canvas size, so older snapshots no longer fit.
  undoStacks.delete(frameIdentifier);
  redoStacks.delete(frameIdentifier);
  const expandedCanvas = document.createElement('canvas');
  expandedCanvas.width = project.cellWidth;
  expandedCanvas.height = project.cellHeight;
  expandedCanvas.getContext('2d')!.drawImage(sourceCanvas, frame.offsetX, frame.offsetY);
  frameCanvases.set(frameIdentifier, expandedCanvas);
  bumpFrameVersion(frameIdentifier);
  mutateProject(() => {
    frame.width = project.cellWidth;
    frame.height = project.cellHeight;
    frame.offsetX = 0;
    frame.offsetY = 0;
  });
  scheduleFrameUpload(frameIdentifier);
}

// ---------- animations ----------

export function createAnimation(animationName: string, frameIdentifiers: string[] = [], ticksPerSecond = 12): AnimationRecord {
  const animation: AnimationRecord = {
    id: createIdentifier(),
    name: animationName,
    ticksPerSecond,
    loopMode: 'loop',
    cells: frameIdentifiers.map((frameId) => ({ frameId, holdTicks: 1 })),
  };
  mutateProject((project) => project.animations.push(animation));
  setState({ selectedAnimationId: animation.id, timelineCursor: 0, focusedFrameId: frameIdentifiers[0] ?? state.focusedFrameId });
  return animation;
}

export function uniqueAnimationName(baseName: string): string {
  const existingNames = new Set(state.project?.animations.map((animation) => animation.name) ?? []);
  if (!existingNames.has(baseName)) return baseName;
  for (let suffix = 2; ; suffix++) if (!existingNames.has(`${baseName} ${suffix}`)) return `${baseName} ${suffix}`;
}

export function addFramesToSelectedAnimation(frameIdentifiers: string[]): void {
  let animation = selectedAnimation();
  if (animation === undefined) {
    createAnimation(uniqueAnimationName('idle'), frameIdentifiers);
    return;
  }
  const targetAnimation = animation;
  const insertIndex = Math.min(targetAnimation.cells.length, state.timelineCursor + 1);
  mutateProject(() => {
    targetAnimation.cells.splice(insertIndex, 0, ...frameIdentifiers.map((frameId) => ({ frameId, holdTicks: 1 })));
  });
  animation = targetAnimation;
  setState({ timelineCursor: insertIndex + frameIdentifiers.length - 1, focusedFrameId: frameIdentifiers.at(-1) ?? state.focusedFrameId });
}

export function selectTimelineCell(cellIndex: number): void {
  const animation = selectedAnimation();
  const cell = animation?.cells[cellIndex];
  if (cell === undefined) return;
  setState({ timelineCursor: cellIndex, focusedFrameId: cell.frameId });
}

export function stepTimeline(direction: 1 | -1): void {
  const animation = selectedAnimation();
  if (animation === undefined || animation.cells.length === 0) {
    const frames = state.project?.frames ?? [];
    const currentIndex = frames.findIndex((frame) => frame.id === state.focusedFrameId);
    const nextFrame = frames[(currentIndex + direction + frames.length) % Math.max(1, frames.length)];
    if (nextFrame !== undefined) setState({ focusedFrameId: nextFrame.id });
    return;
  }
  selectTimelineCell((state.timelineCursor + direction + animation.cells.length) % animation.cells.length);
}

// ---------- undo for drawing ----------

const undoStacks = new Map<string, ImageData[]>();
const redoStacks = new Map<string, ImageData[]>();
const maximumUndoDepth = 25;

export function pushUndoSnapshot(frameIdentifier: string): void {
  const frameCanvas = frameCanvases.get(frameIdentifier);
  if (frameCanvas === undefined) return;
  const snapshot = frameCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
  const undoStack = undoStacks.get(frameIdentifier) ?? [];
  undoStack.push(snapshot);
  if (undoStack.length > maximumUndoDepth) undoStack.shift();
  undoStacks.set(frameIdentifier, undoStack);
  redoStacks.delete(frameIdentifier);
}

function restoreSnapshot(frameIdentifier: string, fromStacks: Map<string, ImageData[]>, toStacks: Map<string, ImageData[]>): boolean {
  const frameCanvas = frameCanvases.get(frameIdentifier);
  const frame = findFrame(frameIdentifier);
  const snapshot = fromStacks.get(frameIdentifier)?.pop();
  if (frameCanvas === undefined || frame === undefined || snapshot === undefined) return false;
  if (snapshot.width !== frameCanvas.width || snapshot.height !== frameCanvas.height) return false;
  const currentSnapshot = frameCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
  const destinationStack = toStacks.get(frameIdentifier) ?? [];
  destinationStack.push(currentSnapshot);
  toStacks.set(frameIdentifier, destinationStack);
  frameCanvas.getContext('2d')!.putImageData(snapshot, 0, 0);
  bumpFrameVersion(frameIdentifier);
  scheduleFrameUpload(frameIdentifier);
  return true;
}

export function undoDrawing(): boolean {
  return state.focusedFrameId !== null && restoreSnapshot(state.focusedFrameId, undoStacks, redoStacks);
}

export function redoDrawing(): boolean {
  return state.focusedFrameId !== null && restoreSnapshot(state.focusedFrameId, redoStacks, undoStacks);
}

export function canUndo(): boolean {
  return state.focusedFrameId !== null && (undoStacks.get(state.focusedFrameId)?.length ?? 0) > 0;
}

export function canRedo(): boolean {
  return state.focusedFrameId !== null && (redoStacks.get(state.focusedFrameId)?.length ?? 0) > 0;
}
