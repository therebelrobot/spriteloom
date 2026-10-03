// The exposure strip: animations as tabs, each cell as wide as it is held.
import { frameThumbnailUrl } from '../render';
import {
  createAnimation,
  findFrame,
  frameVersions,
  mutateProject,
  selectTimelineCell,
  selectedAnimation,
  setState,
  state,
  subscribe,
  uniqueAnimationName,
} from '../store';
import { h, icon, iconButton, replaceChildren } from './dom';

const baseCellWidth = 64;
const extraWidthPerHeldTick = 26;

export function createTimeline(): HTMLElement {
  const tabs = h('div', { className: 'animation-tabs', role: 'tablist', 'aria-label': 'Animations' });
  const strip = h('div', { className: 'cell-strip', role: 'listbox', 'aria-label': 'Cells' });
  const cellActions = h('div', { className: 'cell-actions' });
  const root = h('footer', { className: 'timeline', 'aria-label': 'Timeline' }, tabs, strip, cellActions);

  let lastStripSignature = '';
  let lastTabsSignature = '';
  const cellElements: HTMLElement[] = [];

  function renderTabs(): void {
    const project = state.project!;
    const signature = `${project.animations.map((animation) => `${animation.id}:${animation.name}:${animation.cells.length}`).join('|')}#${state.selectedAnimationId}`;
    if (signature === lastTabsSignature) return;
    lastTabsSignature = signature;
    replaceChildren(tabs,
      project.animations.map((animation) =>
        h('button', {
          type: 'button',
          role: 'tab',
          className: 'animation-tab',
          'aria-selected': String(animation.id === state.selectedAnimationId),
          onclick: () => setState({ selectedAnimationId: animation.id, timelineCursor: 0, focusedFrameId: animation.cells[0]?.frameId ?? state.focusedFrameId }),
        }, animation.name, h('span', { className: 'tab-count' }, String(animation.cells.length))),
      ),
      h('button', {
        type: 'button',
        className: 'animation-tab is-new',
        onclick: () => {
          const animationName = window.prompt('Name the new animation', uniqueAnimationName(project.animations.length === 0 ? 'idle' : 'walk'));
          if (animationName !== null && animationName.trim() !== '') createAnimation(uniqueAnimationName(animationName.trim()));
        },
      }, icon('plus'), 'New animation'),
    );
  }

  function renderStrip(): void {
    const project = state.project!;
    const animation = selectedAnimation();
    const cells = animation?.cells ?? [];
    const signature = `${animation?.id}:${project.cellWidth}x${project.cellHeight}:${project.renderMode}:${cells
      .map((cell) => {
        const frame = findFrame(cell.frameId);
        return `${cell.frameId}*${cell.holdTicks}@${frameVersions.get(cell.frameId)}:${frame?.offsetX},${frame?.offsetY}`;
      })
      .join(',')}`;
    if (signature !== lastStripSignature) {
      const thumbnails = cells.map((cell) => {
        const frame = findFrame(cell.frameId);
        return frame === undefined ? '' : frameThumbnailUrl(project, frame);
      });
      lastStripSignature = signature;
      cellElements.length = 0;
      if (animation === undefined) {
        replaceChildren(strip, h('p', { className: 'strip-empty' }, project.frames.length === 0 ? 'Your animations will line up here.' : 'Make an animation, then add frames to it from the library with their + button.'));
      } else if (cells.length === 0) {
        replaceChildren(strip, h('p', { className: 'strip-empty' }, 'Empty. Tap + on a frame in the library to add it here, or use Select to add several at once.'));
      } else {
        replaceChildren(strip, cells.map((cell, cellIndex) => {
          const frame = findFrame(cell.frameId);
          const cellElement = h('button', {
            type: 'button',
            role: 'option',
            className: 'timeline-cell',
            style: { width: `${baseCellWidth + Math.min(cell.holdTicks - 1, 10) * extraWidthPerHeldTick}px` },
            title: `${frame?.name ?? 'missing frame'}, held ${cell.holdTicks} tick${cell.holdTicks === 1 ? '' : 's'}`,
            onclick: () => {
              setState({ isPlaying: false, stageMode: state.stageMode === 'play' ? 'align' : state.stageMode });
              selectTimelineCell(cellIndex);
            },
          },
          h('span', { className: 'cell-index' }, String(cellIndex + 1)),
          h('img', { alt: '', src: thumbnails[cellIndex] ?? '', draggable: false, style: { imageRendering: project.renderMode === 'pixel' ? 'pixelated' : 'auto' } }),
          cell.holdTicks > 1 ? h('span', { className: 'cell-hold' }, `×${cell.holdTicks}`) : null,
          );
          cellElements.push(cellElement);
          return cellElement;
        }));
      }
    }
    cellElements.forEach((cellElement, cellIndex) => {
      const isCurrent = cellIndex === state.timelineCursor;
      cellElement.classList.toggle('is-current', isCurrent);
      cellElement.setAttribute('aria-selected', String(isCurrent));
      if (isCurrent && state.isPlaying) cellElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function renderCellActions(): void {
    const animation = selectedAnimation();
    const cell = animation?.cells[state.timelineCursor];
    if (animation === undefined || cell === undefined || state.isPlaying) {
      cellActions.hidden = true;
      return;
    }
    cellActions.hidden = false;
    const cellIndex = state.timelineCursor;
    const changeHold = (delta: number): void => mutateProject(() => (cell.holdTicks = Math.min(240, Math.max(1, cell.holdTicks + delta))));
    const moveCell = (direction: -1 | 1): void => {
      const targetIndex = cellIndex + direction;
      if (targetIndex < 0 || targetIndex >= animation.cells.length) return;
      mutateProject(() => {
        animation.cells.splice(cellIndex, 1);
        animation.cells.splice(targetIndex, 0, cell);
      });
      setState({ timelineCursor: targetIndex });
    };
    replaceChildren(cellActions,
      h('span', { className: 'cell-actions-label' }, `Cell ${cellIndex + 1}`),
      h('div', { className: 'hold-control', role: 'group', 'aria-label': 'Hold' },
        iconButton('minus', 'Hold one tick less', () => changeHold(-1), { disabled: cell.holdTicks <= 1 }),
        h('span', { className: 'hold-readout' }, cell.holdTicks === 1 ? 'On ones' : cell.holdTicks <= 4 ? `On ${['', '', 'twos', 'threes', 'fours'][cell.holdTicks]}` : `Held ${cell.holdTicks}`),
        iconButton('plus', 'Hold one tick more', () => changeHold(1)),
      ),
      iconButton('left', 'Move cell earlier', () => moveCell(-1), { disabled: cellIndex === 0 }),
      iconButton('right', 'Move cell later', () => moveCell(1), { disabled: cellIndex === animation.cells.length - 1 }),
      iconButton('copy', 'Repeat this frame in the next cell', () => {
        mutateProject(() => animation.cells.splice(cellIndex + 1, 0, { ...cell }));
        selectTimelineCell(cellIndex + 1);
      }),
      iconButton('trash', 'Remove cell from animation (frame stays in the library)', () => {
        mutateProject(() => animation.cells.splice(cellIndex, 1));
        selectTimelineCell(Math.max(0, Math.min(cellIndex, animation.cells.length - 1)));
      }, { className: 'icon-button is-danger' }),
    );
  }

  subscribe(() => {
    if (state.project === null) return;
    renderTabs();
    renderStrip();
    renderCellActions();
  });
  return root;
}
