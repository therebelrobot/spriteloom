// The frame library: every frame in the project, ready to drop into animations.
import { frameThumbnailUrl } from '../render';
import {
  addFramesToSelectedAnimation,
  deleteFrames,
  duplicateFrame,
  selectedAnimation,
  setState,
  state,
  subscribe,
} from '../store';
import { h, icon, iconButton, replaceChildren, showToast } from './dom';

export function createLibrary(openImport: () => void): HTMLElement {
  const countLabel = h('span', { className: 'panel-count' });
  const selectToggle = h('button', { type: 'button', className: 'text-button', onclick: () => setState({ isSelectingInLibrary: !state.isSelectingInLibrary, librarySelection: new Set() }) });
  const grid = h('div', { className: 'frame-grid', role: 'listbox', 'aria-label': 'Frames', 'aria-multiselectable': 'true' });
  const selectionBar = h('div', { className: 'selection-bar' });
  const root = h('aside', { className: 'panel library', 'aria-label': 'Frames' },
    h('header', { className: 'panel-header' }, h('h2', null, 'Frames'), countLabel, selectToggle),
    grid,
    selectionBar,
  );

  const tilesByFrameIdentifier = new Map<string, { tile: HTMLElement; image: HTMLImageElement; label: HTMLElement; usage: HTMLElement; thumbnailUrl: string }>();
  let lastOrderSignature = '';

  function usageCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const animation of state.project?.animations ?? []) {
      for (const cell of animation.cells) counts.set(cell.frameId, (counts.get(cell.frameId) ?? 0) + 1);
    }
    return counts;
  }

  function onTileActivated(frameIdentifier: string): void {
    if (state.isSelectingInLibrary) {
      const nextSelection = new Set(state.librarySelection);
      if (nextSelection.has(frameIdentifier)) nextSelection.delete(frameIdentifier);
      else nextSelection.add(frameIdentifier);
      setState({ librarySelection: nextSelection });
      return;
    }
    // Jump the timeline to this frame if the current animation uses it.
    const animation = selectedAnimation();
    const cellIndex = animation?.cells.findIndex((cell) => cell.frameId === frameIdentifier) ?? -1;
    setState({ focusedFrameId: frameIdentifier, isPlaying: false, stageMode: state.stageMode === 'play' ? 'align' : state.stageMode, ...(cellIndex >= 0 ? { timelineCursor: cellIndex } : {}) });
  }

  function createTile(frameIdentifier: string) {
    const image = h('img', { alt: '', draggable: false });
    const label = h('span', { className: 'frame-name' });
    const usage = h('span', { className: 'frame-usage' });
    const addButton = h('button', {
      type: 'button',
      className: 'tile-add',
      title: 'Add to the current animation',
      'aria-label': 'Add to the current animation',
      onclick: (clickEvent: MouseEvent) => {
        clickEvent.stopPropagation();
        addFramesToSelectedAnimation([frameIdentifier]);
      },
    }, icon('plus'));
    const tile = h('div', {
      className: 'frame-tile',
      role: 'option',
      tabIndex: 0,
      onclick: () => onTileActivated(frameIdentifier),
      onkeydown: (keyboardEvent: KeyboardEvent) => {
        if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
          keyboardEvent.preventDefault();
          onTileActivated(frameIdentifier);
        }
      },
    }, h('div', { className: 'tile-thumb' }, image), label, usage, addButton);
    const entry = { tile, image, label, usage, thumbnailUrl: '' };
    tilesByFrameIdentifier.set(frameIdentifier, entry);
    return entry;
  }

  function render(): void {
    const project = state.project;
    if (project === null) return;
    countLabel.textContent = String(project.frames.length);
    selectToggle.textContent = state.isSelectingInLibrary ? 'Done' : 'Select';
    selectToggle.hidden = project.frames.length === 0;

    if (project.frames.length === 0) {
      lastOrderSignature = '';
      tilesByFrameIdentifier.clear();
      replaceChildren(grid, h('div', { className: 'empty-panel' },
        h('p', null, 'Export your animation from Procreate as an Animated PNG, then bring it in here.'),
        h('button', { type: 'button', className: 'primary-button', onclick: openImport }, icon('import'), 'Import frames'),
      ));
    } else {
      const orderSignature = project.frames.map((frame) => frame.id).join(',');
      if (orderSignature !== lastOrderSignature) {
        lastOrderSignature = orderSignature;
        const liveIdentifiers = new Set(project.frames.map((frame) => frame.id));
        for (const frameIdentifier of tilesByFrameIdentifier.keys()) if (!liveIdentifiers.has(frameIdentifier)) tilesByFrameIdentifier.delete(frameIdentifier);
        replaceChildren(grid, project.frames.map((frame) => (tilesByFrameIdentifier.get(frame.id) ?? createTile(frame.id)).tile));
      }
      const counts = usageCounts();
      for (const frame of project.frames) {
        const entry = tilesByFrameIdentifier.get(frame.id)!;
        const thumbnailUrl = frameThumbnailUrl(project, frame);
        if (entry.thumbnailUrl !== thumbnailUrl) {
          entry.thumbnailUrl = thumbnailUrl;
          entry.image.src = thumbnailUrl;
        }
        entry.image.style.imageRendering = project.renderMode === 'pixel' ? 'pixelated' : 'auto';
        entry.label.textContent = frame.name;
        const usedCount = counts.get(frame.id) ?? 0;
        entry.usage.textContent = usedCount > 1 ? `×${usedCount}` : '';
        entry.usage.title = usedCount > 0 ? `Used ${usedCount} time${usedCount === 1 ? '' : 's'} in animations` : '';
        const isSelected = state.isSelectingInLibrary ? state.librarySelection.has(frame.id) : state.focusedFrameId === frame.id;
        entry.tile.classList.toggle('is-selected', isSelected);
        entry.tile.classList.toggle('is-unused', usedCount === 0);
        entry.tile.setAttribute('aria-selected', String(isSelected));
      }
    }

    const selectedCount = state.librarySelection.size;
    selectionBar.hidden = !state.isSelectingInLibrary;
    replaceChildren(selectionBar,
      h('span', { className: 'selection-count' }, selectedCount === 0 ? 'Tap frames to select' : `${selectedCount} selected`),
      h('button', {
        type: 'button', className: 'text-button', disabled: selectedCount === 0,
        onclick: () => {
          const orderedSelection = project.frames.filter((frame) => state.librarySelection.has(frame.id)).map((frame) => frame.id);
          addFramesToSelectedAnimation(orderedSelection);
          setState({ isSelectingInLibrary: false, librarySelection: new Set() });
        },
      }, 'Add to animation'),
      iconButton('copy', 'Duplicate selected frames', async () => {
        for (const frameIdentifier of [...state.librarySelection]) await duplicateFrame(frameIdentifier);
        setState({ isSelectingInLibrary: false, librarySelection: new Set() });
      }, { disabled: selectedCount === 0 }),
      iconButton('trash', 'Delete selected frames', () => {
        const removedCount = state.librarySelection.size;
        if (!window.confirm(`Delete ${removedCount} frame${removedCount === 1 ? '' : 's'}? They'll also leave any animation that uses them.`)) return;
        deleteFrames(new Set(state.librarySelection));
        setState({ isSelectingInLibrary: false, librarySelection: new Set() });
        showToast(`Deleted ${removedCount} frame${removedCount === 1 ? '' : 's'}.`);
      }, { disabled: selectedCount === 0, className: 'icon-button is-danger' }),
    );
  }

  subscribe(render);
  return root;
}
