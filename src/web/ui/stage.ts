// The light table: preview playback, frame alignment with onion skins, and touch-up drawing.
import type { FrameRecord, ProjectDocument } from '../../shared/project';
import { drawFrameInCell, formatDuration, playbackOrder, tintedFrameCanvas, type TimedCell } from '../render';
import {
  bumpFrameVersion,
  canRedo,
  canUndo,
  findFrame,
  focusedFrame,
  frameCanvases,
  mutateProject,
  notify,
  pushUndoSnapshot,
  redoDrawing,
  scheduleFrameUpload,
  selectedAnimation,
  setState,
  state,
  stepTimeline,
  subscribe,
  undoDrawing,
  type DrawTool,
  type StageMode,
} from '../store';
import { h, icon, iconButton } from './dom';

const onionBeforeColor = '#3d8fd1';
const onionAfterColor = '#d9483b';

interface ViewTransform {
  scale: number;
  originX: number;
  originY: number;
  isFitted: boolean;
}

interface ActivePointer {
  clientX: number;
  clientY: number;
  pointerType: string;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; startClientX: number; startClientY: number; startOriginX: number; startOriginY: number }
  | { kind: 'pinch'; startDistance: number; startMidX: number; startMidY: number; startView: ViewTransform }
  | { kind: 'move-frame'; frame: FrameRecord; startClientX: number; startClientY: number; startOffsetX: number; startOffsetY: number; moved: boolean }
  | { kind: 'stroke'; frame: FrameRecord; tool: DrawTool; lastX: number; lastY: number; pointerId: number; snapshot: ImageData }
  | { kind: 'tap-play'; startClientX: number; startClientY: number };

export function createStage(): HTMLElement {
  const canvas = h('canvas', { className: 'stage-canvas', 'aria-label': 'Sprite preview' });
  const context = canvas.getContext('2d')!;
  const lightTable = h('div', { className: 'lighttable' }, h('div', { className: 'peg-bar', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')), canvas);
  const strokeLayer = document.createElement('canvas');
  const strokeLayerContext = strokeLayer.getContext('2d')!;

  const view: ViewTransform = { scale: 1, originX: 0, originY: 0, isFitted: true };
  const activePointers = new Map<number, ActivePointer>();
  let gesture: Gesture = { kind: 'none' };
  let hasSeenPen = false;
  let isSpaceHeld = false;
  let lastFitSignature = '';
  let needsRender = true;

  // Playback clock
  let playbackStartTime = 0;
  let playbackSequence: TimedCell[] = [];
  let playbackSignature = '';
  let displayedCellIndex = 0;

  // ----- toolbar -----
  const modeButtons = new Map<StageMode, HTMLButtonElement>();
  const modeLabels: Record<StageMode, string> = { play: 'Play', align: 'Align', draw: 'Touch up' };
  const modeGroup = h('div', { className: 'segmented', role: 'tablist', 'aria-label': 'Stage mode' });
  for (const mode of ['play', 'align', 'draw'] as const) {
    const modeButton = h('button', { type: 'button', role: 'tab', onclick: () => switchMode(mode) }, modeLabels[mode]);
    modeButtons.set(mode, modeButton);
    modeGroup.appendChild(modeButton);
  }
  const onionButton = h('button', { type: 'button', className: 'toggle-button', title: 'Onion skin (O)', onclick: () => setState({ onionSkinEnabled: !state.onionSkinEnabled }) }, icon('onion'), h('span', null, 'Onion'));
  const onionDepthSelect = h('select', { className: 'compact-select', 'aria-label': 'Onion skin depth', onchange: () => setState({ onionSkinDepth: Number(onionDepthSelect.value) }) },
    h('option', { value: '1' }, '±1'), h('option', { value: '2' }, '±2'), h('option', { value: '3' }, '±3'));
  const zoomReadout = h('span', { className: 'zoom-readout' });
  const toolbar = h('div', { className: 'stage-toolbar' },
    modeGroup,
    h('div', { className: 'toolbar-cluster' }, onionButton, onionDepthSelect),
    h('div', { className: 'toolbar-cluster' },
      iconButton('minus', 'Zoom out', () => zoomBy(1 / 1.5)),
      zoomReadout,
      iconButton('plus', 'Zoom in', () => zoomBy(1.5)),
      iconButton('fit', 'Fit to table', () => { view.isFitted = true; fitView(); }),
    ),
  );

  // ----- transport -----
  const playButton = h('button', { type: 'button', className: 'play-button', onclick: () => togglePlayback() });
  const positionReadout = h('span', { className: 'position-readout' });
  const durationReadout = h('span', { className: 'duration-readout' });
  const transport = h('div', { className: 'transport' },
    iconButton('previous', 'Previous cell (,)', () => { setState({ isPlaying: false }); stepTimeline(-1); }),
    playButton,
    iconButton('next', 'Next cell (.)', () => { setState({ isPlaying: false }); stepTimeline(1); }),
    positionReadout,
    durationReadout,
  );

  // ----- draw tools -----
  const toolButtons = new Map<DrawTool, HTMLButtonElement>();
  const toolLabels: Record<DrawTool, string> = { pencil: 'Pencil (B)', eraser: 'Eraser (E)', picker: 'Pick color (I)' };
  const toolGroup = h('div', { className: 'segmented icon-segmented', role: 'radiogroup', 'aria-label': 'Drawing tool' });
  for (const tool of ['pencil', 'eraser', 'picker'] as const) {
    const toolButton = h('button', { type: 'button', role: 'radio', title: toolLabels[tool], 'aria-label': toolLabels[tool], onclick: () => setState({ drawTool: tool }) }, icon(tool));
    toolButtons.set(tool, toolButton);
    toolGroup.appendChild(toolButton);
  }
  const sizeInput = h('input', { type: 'range', min: '1', max: '64', 'aria-label': 'Brush size', oninput: () => setState({ brushSize: Number(sizeInput.value) }) });
  const sizeReadout = h('span', { className: 'tool-readout' });
  const colorInput = h('input', { type: 'color', className: 'color-input', 'aria-label': 'Brush color', oninput: () => setState({ brushColor: colorInput.value }) });
  const opacityInput = h('input', { type: 'range', min: '5', max: '100', step: '5', 'aria-label': 'Brush opacity', oninput: () => setState({ brushOpacity: Number(opacityInput.value) / 100 }) });
  const undoButton = iconButton('undo', 'Undo (⌘Z)', () => { undoDrawing(); notify(); });
  const redoButton = iconButton('redo', 'Redo (⇧⌘Z)', () => { redoDrawing(); notify(); });
  const drawTools = h('div', { className: 'draw-tools' },
    toolGroup,
    h('label', { className: 'tool-field' }, h('span', null, 'Size'), sizeInput, sizeReadout),
    h('label', { className: 'tool-field' }, h('span', null, 'Color'), colorInput),
    h('label', { className: 'tool-field' }, h('span', null, 'Opacity'), opacityInput),
    h('div', { className: 'toolbar-cluster' }, undoButton, redoButton),
  );

  const pivotHint = h('div', { className: 'stage-hint', hidden: true }, 'Tap the table to place the pivot.');
  const emptyHint = h('div', { className: 'stage-hint stage-empty', hidden: true }, 'Import frames to put them on the light table.');
  lightTable.append(pivotHint, emptyHint);

  const root = h('section', { className: 'stage', 'aria-label': 'Light table' }, toolbar, lightTable, drawTools, transport);

  // ----- view math -----
  function cellToScreen(cellX: number, cellY: number): [number, number] {
    return [view.originX + cellX * view.scale, view.originY + cellY * view.scale];
  }

  function clientToCell(clientX: number, clientY: number): [number, number] {
    const bounds = canvas.getBoundingClientRect();
    return [(clientX - bounds.left - view.originX) / view.scale, (clientY - bounds.top - view.originY) / view.scale];
  }

  function fitView(): void {
    const project = state.project;
    if (project === null) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;
    const marginTop = 36; // room for the peg bar
    const availableWidth = bounds.width - 48;
    const availableHeight = bounds.height - marginTop - 32;
    let fitScale = Math.min(availableWidth / project.cellWidth, availableHeight / project.cellHeight);
    if (project.renderMode === 'pixel') fitScale = fitScale >= 1 ? Math.floor(fitScale) : 1 / Math.ceil(1 / fitScale);
    else fitScale = Math.min(fitScale, 4);
    view.scale = Math.max(0.05, fitScale);
    view.originX = Math.round((bounds.width - project.cellWidth * view.scale) / 2);
    view.originY = Math.round(marginTop + (availableHeight + 32 - project.cellHeight * view.scale) / 2);
    view.isFitted = true;
    needsRender = true;
  }

  function zoomBy(factor: number, anchorClientX?: number, anchorClientY?: number): void {
    const project = state.project;
    if (project === null) return;
    const bounds = canvas.getBoundingClientRect();
    const anchorX = anchorClientX !== undefined ? anchorClientX - bounds.left : bounds.width / 2;
    const anchorY = anchorClientY !== undefined ? anchorClientY - bounds.top : bounds.height / 2;
    let nextScale = view.scale * factor;
    if (project.renderMode === 'pixel' && nextScale >= 1) nextScale = factor > 1 ? Math.max(Math.ceil(view.scale + 0.01), Math.round(nextScale)) : Math.max(1, Math.min(Math.floor(view.scale - 0.01), Math.round(nextScale)));
    nextScale = Math.min(64, Math.max(0.05, nextScale));
    view.originX = anchorX - ((anchorX - view.originX) / view.scale) * nextScale;
    view.originY = anchorY - ((anchorY - view.originY) / view.scale) * nextScale;
    view.scale = nextScale;
    view.isFitted = false;
    needsRender = true;
    updateChrome();
  }

  function resizeCanvas(): void {
    const bounds = lightTable.getBoundingClientRect();
    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(bounds.width * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(bounds.height * devicePixelRatio));
    canvas.style.width = `${bounds.width}px`;
    canvas.style.height = `${bounds.height}px`;
    if (view.isFitted) fitView();
    needsRender = true;
  }

  // ----- what to show -----
  function sequenceForStage(): TimedCell[] {
    const animation = selectedAnimation();
    if (animation !== undefined && animation.cells.length > 0) return playbackOrder(animation);
    return (state.project?.frames ?? []).map((frame, frameIndex) => ({ cellIndex: frameIndex, frameId: frame.id, holdTicks: 1 }));
  }

  function neighbouringFrames(direction: 1 | -1, depth: number): FrameRecord[] {
    const animation = selectedAnimation();
    const neighbours: FrameRecord[] = [];
    if (animation !== undefined && animation.cells.length > 1) {
      for (let step = 1; step <= depth; step++) {
        let neighbourIndex = state.timelineCursor + direction * step;
        if (animation.loopMode !== 'once') neighbourIndex = (neighbourIndex + animation.cells.length * 4) % animation.cells.length;
        const neighbour = findFrame(animation.cells[neighbourIndex]?.frameId ?? null);
        if (neighbour !== undefined && neighbour.id !== state.focusedFrameId) neighbours.push(neighbour);
      }
      return neighbours;
    }
    const frames = state.project?.frames ?? [];
    const focusedIndex = frames.findIndex((frame) => frame.id === state.focusedFrameId);
    for (let step = 1; step <= depth; step++) {
      const neighbour = frames[focusedIndex + direction * step];
      if (neighbour !== undefined) neighbours.push(neighbour);
    }
    return neighbours;
  }

  function advancePlayback(now: number): FrameRecord | undefined {
    const animation = selectedAnimation();
    const sequence = sequenceForStage();
    const signature = `${animation?.id}:${sequence.map((timedCell) => `${timedCell.frameId}*${timedCell.holdTicks}`).join(',')}:${animation?.ticksPerSecond}:${animation?.loopMode}`;
    if (signature !== playbackSignature) {
      playbackSignature = signature;
      playbackSequence = sequence;
      playbackStartTime = now;
    }
    if (playbackSequence.length === 0) return undefined;
    const ticksPerSecond = animation?.ticksPerSecond ?? 12;
    const sequenceTicks = playbackSequence.reduce((sum, timedCell) => sum + timedCell.holdTicks, 0);
    let elapsedTicks = Math.floor(((now - playbackStartTime) / 1000) * ticksPerSecond);
    if (animation?.loopMode === 'once' && elapsedTicks >= sequenceTicks) {
      setState({ isPlaying: false });
      elapsedTicks = sequenceTicks - 1;
    }
    elapsedTicks %= sequenceTicks;
    let sequenceIndex = 0;
    for (; sequenceIndex < playbackSequence.length; sequenceIndex++) {
      elapsedTicks -= playbackSequence[sequenceIndex]!.holdTicks;
      if (elapsedTicks < 0) break;
    }
    const timedCell = playbackSequence[Math.min(sequenceIndex, playbackSequence.length - 1)]!;
    if (timedCell.cellIndex !== displayedCellIndex || state.focusedFrameId !== timedCell.frameId) {
      displayedCellIndex = timedCell.cellIndex;
      if (animation !== undefined) {
        state.timelineCursor = timedCell.cellIndex;
        state.focusedFrameId = timedCell.frameId;
        notify();
      }
    }
    return findFrame(timedCell.frameId);
  }

  // ----- painting the table -----
  function drawCellBackground(project: ProjectDocument): void {
    const [screenX, screenY] = cellToScreen(0, 0);
    const screenWidth = project.cellWidth * view.scale;
    const screenHeight = project.cellHeight * view.scale;
    context.save();
    if (project.stageBackground === 'checker') {
      const checkSize = Math.max(6, Math.min(16, view.scale * 8));
      context.fillStyle = '#d9dde3';
      context.fillRect(screenX, screenY, screenWidth, screenHeight);
      context.beginPath();
      context.rect(screenX, screenY, screenWidth, screenHeight);
      context.clip();
      context.fillStyle = '#f4f6f8';
      for (let checkY = 0; checkY < screenHeight; checkY += checkSize) {
        for (let checkX = (Math.floor(checkY / checkSize) % 2) * checkSize; checkX < screenWidth; checkX += checkSize * 2) {
          context.fillRect(screenX + checkX, screenY + checkY, checkSize, checkSize);
        }
      }
    } else if (project.stageBackground === 'dark') {
      context.fillStyle = '#2b3240';
      context.fillRect(screenX, screenY, screenWidth, screenHeight);
    } else if (project.stageBackground === 'grey') {
      context.fillStyle = '#8a8f98';
      context.fillRect(screenX, screenY, screenWidth, screenHeight);
    } else {
      // Light table: a sheet of animation paper over the lamp.
      context.fillStyle = 'rgba(255, 253, 246, 0.55)';
      context.fillRect(screenX, screenY, screenWidth, screenHeight);
    }
    context.restore();
  }

  function drawPixelGrid(project: ProjectDocument): void {
    if (project.renderMode !== 'pixel' || view.scale < 8) return;
    const [screenX, screenY] = cellToScreen(0, 0);
    context.save();
    context.strokeStyle = 'rgba(40, 60, 90, 0.12)';
    context.lineWidth = 1;
    context.beginPath();
    for (let column = 0; column <= project.cellWidth; column++) {
      const lineX = Math.round(screenX + column * view.scale) + 0.5;
      context.moveTo(lineX, screenY);
      context.lineTo(lineX, screenY + project.cellHeight * view.scale);
    }
    for (let row = 0; row <= project.cellHeight; row++) {
      const lineY = Math.round(screenY + row * view.scale) + 0.5;
      context.moveTo(screenX, lineY);
      context.lineTo(screenX + project.cellWidth * view.scale, lineY);
    }
    context.stroke();
    context.restore();
  }

  function drawPivotMarker(project: ProjectDocument): void {
    const [pivotScreenX, pivotScreenY] = cellToScreen(project.pivotX, project.pivotY);
    context.save();
    context.strokeStyle = state.isPlacingPivot ? '#d9483b' : 'rgba(217, 72, 59, 0.85)';
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(pivotScreenX, pivotScreenY, 5, 0, Math.PI * 2);
    context.moveTo(pivotScreenX - 11, pivotScreenY);
    context.lineTo(pivotScreenX - 3, pivotScreenY);
    context.moveTo(pivotScreenX + 3, pivotScreenY);
    context.lineTo(pivotScreenX + 11, pivotScreenY);
    context.moveTo(pivotScreenX, pivotScreenY - 11);
    context.lineTo(pivotScreenX, pivotScreenY - 3);
    context.moveTo(pivotScreenX, pivotScreenY + 3);
    context.lineTo(pivotScreenX, pivotScreenY + 11);
    context.stroke();
    context.restore();
  }

  function render(now: number): void {
    const project = state.project;
    const devicePixelRatio = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (project === null) return;
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    const shownFrame = state.isPlaying ? advancePlayback(now) : focusedFrame();
    drawCellBackground(project);
    context.imageSmoothingEnabled = project.renderMode === 'smooth';
    context.imageSmoothingQuality = 'high';

    const [cellScreenX, cellScreenY] = cellToScreen(0, 0);
    const cellScreenWidth = project.cellWidth * view.scale;
    const cellScreenHeight = project.cellHeight * view.scale;

    const drawCellSpace = (paint: () => void, clipToCell: boolean, alpha = 1): void => {
      context.save();
      if (clipToCell) {
        context.beginPath();
        context.rect(cellScreenX, cellScreenY, cellScreenWidth, cellScreenHeight);
        context.clip();
      }
      context.globalAlpha = alpha;
      context.translate(view.originX, view.originY);
      context.scale(view.scale, view.scale);
      paint();
      context.restore();
    };

    if (!state.isPlaying && state.onionSkinEnabled && state.stageMode !== 'play') {
      for (const [direction, tintColor] of [[-1, onionBeforeColor], [1, onionAfterColor]] as const) {
        neighbouringFrames(direction, state.onionSkinDepth).forEach((neighbour, depthIndex) => {
          const tinted = tintedFrameCanvas(neighbour, tintColor);
          if (tinted !== undefined) drawCellSpace(() => context.drawImage(tinted, neighbour.offsetX, neighbour.offsetY), true, 0.38 / (depthIndex + 1));
        });
      }
    }

    if (shownFrame !== undefined) {
      if (state.stageMode !== 'play') drawCellSpace(() => drawFrameInCell(context, shownFrame), false, 0.22);
      drawCellSpace(() => {
        drawFrameInCell(context, shownFrame);
        if (gesture.kind === 'stroke' && gesture.tool === 'pencil' && gesture.frame.id === shownFrame.id) {
          context.globalAlpha = state.brushOpacity;
          context.drawImage(strokeLayer, shownFrame.offsetX, shownFrame.offsetY);
        }
      }, true);
      if (state.stageMode !== 'play') {
        // Outline of the frame's own canvas, so trimmed frames show their extent.
        const [frameScreenX, frameScreenY] = cellToScreen(shownFrame.offsetX, shownFrame.offsetY);
        context.save();
        context.strokeStyle = 'rgba(61, 143, 209, 0.55)';
        context.setLineDash([2, 3]);
        context.strokeRect(Math.round(frameScreenX) + 0.5, Math.round(frameScreenY) + 0.5, Math.round(shownFrame.width * view.scale), Math.round(shownFrame.height * view.scale));
        context.restore();
      }
    }

    drawPixelGrid(project);
    context.save();
    context.strokeStyle = 'rgba(31, 38, 48, 0.45)';
    context.setLineDash([5, 4]);
    context.strokeRect(Math.round(cellScreenX) - 0.5, Math.round(cellScreenY) - 0.5, Math.round(cellScreenWidth) + 1, Math.round(cellScreenHeight) + 1);
    context.restore();
    drawPivotMarker(project);
  }

  function renderLoop(now: number): void {
    if (state.project !== null) {
      const fitSignature = `${state.project.id}:${state.project.cellWidth}x${state.project.cellHeight}:${state.project.renderMode}`;
      if (fitSignature !== lastFitSignature) {
        lastFitSignature = fitSignature;
        view.isFitted = true;
        fitView();
        updateChrome();
      }
    }
    if (needsRender || state.isPlaying || gesture.kind === 'stroke') {
      needsRender = false;
      render(now);
    }
    requestAnimationFrame(renderLoop);
  }

  // ----- pointer handling -----
  function startStroke(frame: FrameRecord, pointerEvent: PointerEvent): void {
    const frameCanvas = frameCanvases.get(frame.id);
    if (frameCanvas === undefined) return;
    const [cellX, cellY] = clientToCell(pointerEvent.clientX, pointerEvent.clientY);
    const frameX = cellX - frame.offsetX;
    const frameY = cellY - frame.offsetY;

    if (state.drawTool === 'picker') {
      const sample = frameCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(Math.floor(frameX), Math.floor(frameY), 1, 1).data;
      if ((sample[3] ?? 0) > 0) {
        const hexColor = `#${[sample[0], sample[1], sample[2]].map((channel) => (channel ?? 0).toString(16).padStart(2, '0')).join('')}`;
        setState({ brushColor: hexColor, drawTool: 'pencil' });
      }
      return;
    }

    pushUndoSnapshot(frame.id);
    const snapshot = frameCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
    strokeLayer.width = frameCanvas.width;
    strokeLayer.height = frameCanvas.height;
    strokeLayerContext.clearRect(0, 0, strokeLayer.width, strokeLayer.height);
    gesture = { kind: 'stroke', frame, tool: state.drawTool, lastX: frameX, lastY: frameY, pointerId: pointerEvent.pointerId, snapshot };
    paintSegment(frame, frameX, frameY, frameX, frameY, pointerEvent);
  }

  function paintSegment(frame: FrameRecord, fromX: number, fromY: number, toX: number, toY: number, pointerEvent: PointerEvent): void {
    const project = state.project!;
    const frameCanvas = frameCanvases.get(frame.id)!;
    const isEraser = state.drawTool === 'eraser';
    const targetContext = isEraser ? frameCanvas.getContext('2d')! : strokeLayerContext;
    const pressure = pointerEvent.pointerType === 'pen' ? Math.max(0.05, pointerEvent.pressure) : 1;

    if (project.renderMode === 'pixel') {
      const brushSize = Math.max(1, Math.round(state.brushSize / 4));
      const brushOffset = Math.floor(brushSize / 2);
      targetContext.fillStyle = state.brushColor;
      let currentX = Math.floor(fromX), currentY = Math.floor(fromY);
      const endX = Math.floor(toX), endY = Math.floor(toY);
      const stepX = Math.sign(endX - currentX), stepY = Math.sign(endY - currentY);
      const distanceX = Math.abs(endX - currentX), distanceY = -Math.abs(endY - currentY);
      let error = distanceX + distanceY;
      for (let guard = 0; guard < 10_000; guard++) {
        if (isEraser) targetContext.clearRect(currentX - brushOffset, currentY - brushOffset, brushSize, brushSize);
        else targetContext.fillRect(currentX - brushOffset, currentY - brushOffset, brushSize, brushSize);
        if (currentX === endX && currentY === endY) break;
        const doubledError = 2 * error;
        if (doubledError >= distanceY) { error += distanceY; currentX += stepX; }
        if (doubledError <= distanceX) { error += distanceX; currentY += stepY; }
      }
      return;
    }

    targetContext.save();
    if (isEraser) {
      targetContext.globalCompositeOperation = 'destination-out';
      targetContext.globalAlpha = state.brushOpacity;
    }
    targetContext.strokeStyle = state.brushColor;
    targetContext.fillStyle = state.brushColor;
    targetContext.lineCap = 'round';
    targetContext.lineJoin = 'round';
    targetContext.lineWidth = Math.max(0.5, state.brushSize * (pointerEvent.pointerType === 'pen' ? 0.2 + 0.8 * pressure : 1));
    targetContext.beginPath();
    if (fromX === toX && fromY === toY) {
      targetContext.arc(toX, toY, targetContext.lineWidth / 2, 0, Math.PI * 2);
      targetContext.fill();
    } else {
      targetContext.moveTo(fromX, fromY);
      targetContext.lineTo(toX, toY);
      targetContext.stroke();
    }
    targetContext.restore();
  }

  function finishStroke(): void {
    if (gesture.kind !== 'stroke') return;
    const { frame, tool } = gesture;
    if (tool === 'pencil') {
      const frameContext = frameCanvases.get(frame.id)!.getContext('2d')!;
      frameContext.save();
      frameContext.globalAlpha = state.brushOpacity;
      frameContext.drawImage(strokeLayer, 0, 0);
      frameContext.restore();
    }
    gesture = { kind: 'none' };
    bumpFrameVersion(frame.id);
    scheduleFrameUpload(frame.id);
    needsRender = true;
  }

  function cancelStroke(): void {
    if (gesture.kind !== 'stroke') return;
    frameCanvases.get(gesture.frame.id)?.getContext('2d')!.putImageData(gesture.snapshot, 0, 0);
    undoDrawing(); // pops the snapshot pushed at stroke start
    gesture = { kind: 'none' };
    needsRender = true;
  }

  function beginPinch(): void {
    const [first, second] = [...activePointers.values()];
    if (first === undefined || second === undefined) return;
    cancelStroke();
    if (gesture.kind === 'move-frame') {
      gesture.frame.offsetX = gesture.startOffsetX;
      gesture.frame.offsetY = gesture.startOffsetY;
    }
    const bounds = canvas.getBoundingClientRect();
    gesture = {
      kind: 'pinch',
      startDistance: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY) || 1,
      startMidX: (first.clientX + second.clientX) / 2 - bounds.left,
      startMidY: (first.clientY + second.clientY) / 2 - bounds.top,
      startView: { ...view },
    };
  }

  canvas.addEventListener('pointerdown', (pointerEvent) => {
    if (state.project === null) return;
    if (pointerEvent.pointerType === 'pen') hasSeenPen = true;
    canvas.setPointerCapture(pointerEvent.pointerId);
    activePointers.set(pointerEvent.pointerId, { clientX: pointerEvent.clientX, clientY: pointerEvent.clientY, pointerType: pointerEvent.pointerType });
    pointerEvent.preventDefault();

    if (activePointers.size === 2 && [...activePointers.values()].every((pointer) => pointer.pointerType === 'touch')) {
      beginPinch();
      return;
    }
    if (activePointers.size > 1) return;

    const isPanRequest = pointerEvent.button === 1 || isSpaceHeld || (state.stageMode === 'draw' && hasSeenPen && pointerEvent.pointerType === 'touch');
    if (isPanRequest) {
      gesture = { kind: 'pan', startClientX: pointerEvent.clientX, startClientY: pointerEvent.clientY, startOriginX: view.originX, startOriginY: view.originY };
      return;
    }

    if (state.isPlacingPivot) {
      const [cellX, cellY] = clientToCell(pointerEvent.clientX, pointerEvent.clientY);
      mutateProject((project) => {
        project.pivotX = Math.round(cellX);
        project.pivotY = Math.round(cellY);
      });
      setState({ isPlacingPivot: false });
      return;
    }

    const frame = focusedFrame();
    if (state.stageMode === 'play') {
      gesture = { kind: 'tap-play', startClientX: pointerEvent.clientX, startClientY: pointerEvent.clientY };
    } else if (state.stageMode === 'align' && frame !== undefined) {
      gesture = { kind: 'move-frame', frame, startClientX: pointerEvent.clientX, startClientY: pointerEvent.clientY, startOffsetX: frame.offsetX, startOffsetY: frame.offsetY, moved: false };
    } else if (state.stageMode === 'draw' && frame !== undefined) {
      setState({ isPlaying: false });
      startStroke(frame, pointerEvent);
    }
  });

  canvas.addEventListener('pointermove', (pointerEvent) => {
    const activePointer = activePointers.get(pointerEvent.pointerId);
    if (activePointer === undefined) return;
    activePointer.clientX = pointerEvent.clientX;
    activePointer.clientY = pointerEvent.clientY;

    if (gesture.kind === 'pinch') {
      const [first, second] = [...activePointers.values()];
      if (first === undefined || second === undefined) return;
      const bounds = canvas.getBoundingClientRect();
      const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
      const midX = (first.clientX + second.clientX) / 2 - bounds.left;
      const midY = (first.clientY + second.clientY) / 2 - bounds.top;
      const nextScale = Math.min(64, Math.max(0.05, gesture.startView.scale * (distance / gesture.startDistance)));
      const cellAtStartX = (gesture.startMidX - gesture.startView.originX) / gesture.startView.scale;
      const cellAtStartY = (gesture.startMidY - gesture.startView.originY) / gesture.startView.scale;
      view.scale = nextScale;
      view.originX = midX - cellAtStartX * nextScale;
      view.originY = midY - cellAtStartY * nextScale;
      view.isFitted = false;
      needsRender = true;
      updateChrome();
    } else if (gesture.kind === 'pan') {
      view.originX = gesture.startOriginX + (pointerEvent.clientX - gesture.startClientX);
      view.originY = gesture.startOriginY + (pointerEvent.clientY - gesture.startClientY);
      view.isFitted = false;
      needsRender = true;
    } else if (gesture.kind === 'move-frame') {
      const deltaX = Math.round((pointerEvent.clientX - gesture.startClientX) / view.scale);
      const deltaY = Math.round((pointerEvent.clientY - gesture.startClientY) / view.scale);
      if (deltaX !== 0 || deltaY !== 0) gesture.moved = true;
      gesture.frame.offsetX = gesture.startOffsetX + deltaX;
      gesture.frame.offsetY = gesture.startOffsetY + deltaY;
      needsRender = true;
      notify();
    } else if (gesture.kind === 'stroke' && pointerEvent.pointerId === gesture.pointerId) {
      const coalescedEvents = typeof pointerEvent.getCoalescedEvents === 'function' ? pointerEvent.getCoalescedEvents() : [];
      for (const sampleEvent of coalescedEvents.length > 0 ? coalescedEvents : [pointerEvent]) {
        const [cellX, cellY] = clientToCell(sampleEvent.clientX, sampleEvent.clientY);
        const frameX = cellX - gesture.frame.offsetX;
        const frameY = cellY - gesture.frame.offsetY;
        paintSegment(gesture.frame, gesture.lastX, gesture.lastY, frameX, frameY, sampleEvent);
        gesture.lastX = frameX;
        gesture.lastY = frameY;
      }
      needsRender = true;
    }
  });

  const endPointer = (pointerEvent: PointerEvent): void => {
    if (!activePointers.has(pointerEvent.pointerId)) return;
    activePointers.delete(pointerEvent.pointerId);
    if (gesture.kind === 'pinch') {
      if (activePointers.size === 0) gesture = { kind: 'none' };
      return;
    }
    if (gesture.kind === 'stroke' && pointerEvent.pointerId === gesture.pointerId) {
      if (pointerEvent.type === 'pointercancel') cancelStroke();
      else finishStroke();
    } else if (gesture.kind === 'move-frame') {
      const { frame, moved } = gesture;
      if (moved) mutateProject(() => undefined);
      void frame;
    } else if (gesture.kind === 'tap-play') {
      if (Math.hypot(pointerEvent.clientX - gesture.startClientX, pointerEvent.clientY - gesture.startClientY) < 8) togglePlayback();
    }
    if (activePointers.size === 0) gesture = { kind: 'none' };
    notify();
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (wheelEvent) => {
    if (state.project === null) return;
    wheelEvent.preventDefault();
    if (wheelEvent.ctrlKey || wheelEvent.metaKey) {
      zoomBy(Math.exp(-wheelEvent.deltaY * 0.01), wheelEvent.clientX, wheelEvent.clientY);
    } else {
      view.originX -= wheelEvent.deltaX;
      view.originY -= wheelEvent.deltaY;
      view.isFitted = false;
      needsRender = true;
    }
  }, { passive: false });

  window.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.code === 'Space' && !(keyboardEvent.target instanceof HTMLInputElement)) isSpaceHeld = true;
  });
  window.addEventListener('keyup', (keyboardEvent) => {
    if (keyboardEvent.code === 'Space') isSpaceHeld = false;
  });

  // ----- mode & playback -----
  function switchMode(mode: StageMode): void {
    setState({ stageMode: mode, isPlaying: mode === 'play' ? state.isPlaying : false, isPlacingPivot: false });
  }

  function togglePlayback(): void {
    const willPlay = !state.isPlaying;
    playbackSignature = '';
    setState({ isPlaying: willPlay, stageMode: willPlay ? 'play' : state.stageMode });
  }

  // ----- chrome sync -----
  function updateChrome(): void {
    const project = state.project;
    for (const [mode, modeButton] of modeButtons) modeButton.setAttribute('aria-selected', String(state.stageMode === mode));
    onionButton.setAttribute('aria-pressed', String(state.onionSkinEnabled));
    onionDepthSelect.value = String(state.onionSkinDepth);
    zoomReadout.textContent = `${Math.round(view.scale * 100)}%`;
    playButton.replaceChildren(icon(state.isPlaying ? 'pause' : 'play'), h('span', null, state.isPlaying ? 'Pause' : 'Play'));
    playButton.setAttribute('aria-label', state.isPlaying ? 'Pause (space)' : 'Play (space)');
    drawTools.hidden = state.stageMode !== 'draw';
    for (const [tool, toolButton] of toolButtons) toolButton.setAttribute('aria-checked', String(state.drawTool === tool));
    sizeInput.value = String(state.brushSize);
    sizeReadout.textContent = project?.renderMode === 'pixel' ? `${Math.max(1, Math.round(state.brushSize / 4))} px` : `${state.brushSize} px`;
    if (document.activeElement !== colorInput) colorInput.value = state.brushColor;
    opacityInput.value = String(Math.round(state.brushOpacity * 100));
    undoButton.disabled = !canUndo();
    redoButton.disabled = !canRedo();
    pivotHint.hidden = !state.isPlacingPivot;
    emptyHint.hidden = project === null || project.frames.length > 0;
    lightTable.dataset.mode = state.stageMode;
    lightTable.dataset.tool = state.drawTool;

    const animation = selectedAnimation();
    if (animation !== undefined && animation.cells.length > 0) {
      positionReadout.textContent = `Cell ${state.timelineCursor + 1} of ${animation.cells.length}`;
      durationReadout.textContent = `${formatDuration(animation)} at ${animation.ticksPerSecond} fps`;
    } else {
      const frames = project?.frames ?? [];
      const focusedIndex = frames.findIndex((frame) => frame.id === state.focusedFrameId);
      positionReadout.textContent = frames.length > 0 ? `Frame ${focusedIndex + 1} of ${frames.length}` : '';
      durationReadout.textContent = frames.length > 0 ? 'Add frames to an animation to time them' : '';
    }
  }

  subscribe(() => {
    needsRender = true;
    updateChrome();
  });
  new ResizeObserver(() => resizeCanvas()).observe(lightTable);
  requestAnimationFrame(renderLoop);
  updateChrome();

  return root;
}
