// App shell: routing between the project shelf and the editor, top bar, shortcuts.
import {
  closeProject,
  flushSave,
  focusedFrame,
  hasUnsavedWork,
  mutateProject,
  openProject,
  redoDrawing,
  setState,
  state,
  stepTimeline,
  subscribe,
  undoDrawing,
  type SaveStatus,
} from './store';
import { createExportDialog } from './ui/exportDialog';
import { createHome } from './ui/home';
import { createImportDialog } from './ui/importDialog';
import { createInspector } from './ui/inspector';
import { createLibrary } from './ui/library';
import { createStage } from './ui/stage';
import { createTimeline } from './ui/timeline';
import { h, icon, showToast } from './ui/dom';

const appRoot = document.getElementById('app')!;

const importDialog = createImportDialog();
const exportDialog = createExportDialog();
document.body.append(importDialog.dialog, exportDialog.dialog);

const home = createHome((projectIdentifier) => {
  location.hash = `#/p/${projectIdentifier}`;
});

// ----- editor shell -----
const projectNameInput = h('input', { type: 'text', className: 'project-name', 'aria-label': 'Project name', maxLength: 120, spellcheck: false });
projectNameInput.addEventListener('change', () => {
  const nextName = projectNameInput.value.trim();
  if (nextName !== '') mutateProject((project) => (project.name = nextName));
});
projectNameInput.addEventListener('keydown', (keyboardEvent) => {
  if (keyboardEvent.key === 'Enter') projectNameInput.blur();
});

const saveStatusLabels: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Saving soon',
  offline: 'Can’t reach the server, retrying',
  conflict: 'Changed on another device',
};
const saveStatus = h('span', { className: 'save-status', role: 'status' });
const conflictBanner = h('div', { className: 'conflict-banner', hidden: true, role: 'alert' },
  h('span', null, 'This project was changed on another device. Reload to get the latest; edits made here since then won’t be kept.'),
  h('button', { type: 'button', className: 'primary-button', onclick: () => location.reload() }, 'Reload'),
);

const topBar = h('header', { className: 'top-bar' },
  h('button', { type: 'button', className: 'text-button back-button', onclick: () => { location.hash = '#/'; } }, icon('back'), h('span', null, 'Projects')),
  projectNameInput,
  saveStatus,
  h('div', { className: 'top-actions' },
    h('button', { type: 'button', className: 'secondary-button', onclick: () => importDialog.open() }, icon('import'), h('span', null, 'Import')),
    h('button', { type: 'button', className: 'primary-button', onclick: () => exportDialog.open() }, icon('export'), h('span', null, 'Export')),
  ),
);

const editor = h('div', { className: 'editor' },
  topBar,
  conflictBanner,
  createLibrary(() => importDialog.open()),
  createStage(),
  createInspector(),
  createTimeline(),
);

subscribe(() => {
  if (state.project === null) return;
  if (document.activeElement !== projectNameInput) projectNameInput.value = state.project.name;
  saveStatus.textContent = saveStatusLabels[state.saveStatus];
  saveStatus.dataset.status = state.saveStatus;
  conflictBanner.hidden = state.saveStatus !== 'conflict';
  document.title = `${state.project.name} · spriteloom`;
});

// Files dropped anywhere on the editor go to the import dialog.
editor.addEventListener('dragover', (dragEvent) => {
  if (dragEvent.dataTransfer?.types.includes('Files')) dragEvent.preventDefault();
});
editor.addEventListener('drop', (dragEvent) => {
  const files = [...(dragEvent.dataTransfer?.files ?? [])];
  if (files.length === 0) return;
  dragEvent.preventDefault();
  importDialog.open(files);
});

// ----- routing -----
async function route(): Promise<void> {
  const projectMatch = /^#\/p\/([a-z0-9-]+)/.exec(location.hash);
  if (projectMatch !== null) {
    const projectIdentifier = projectMatch[1]!;
    if (state.project?.id === projectIdentifier) return;
    appRoot.replaceChildren(h('p', { className: 'loading' }, 'Laying out the frames…'));
    try {
      await openProject(projectIdentifier);
      appRoot.replaceChildren(editor);
    } catch (error) {
      showToast(error instanceof Error ? `Couldn’t open that project: ${error.message}` : 'Couldn’t open that project.', 'error');
      location.hash = '#/';
    }
    return;
  }
  if (state.project !== null) closeProject();
  document.title = 'spriteloom';
  appRoot.replaceChildren(home.element);
  await home.refresh();
}

window.addEventListener('hashchange', () => void route());
void route();

// ----- keyboard -----
window.addEventListener('keydown', (keyboardEvent) => {
  if (state.project === null) return;
  const target = keyboardEvent.target as HTMLElement;
  if (target.closest('input, textarea, select, dialog[open]')) return;
  const isCommand = keyboardEvent.metaKey || keyboardEvent.ctrlKey;

  if (isCommand && keyboardEvent.key.toLowerCase() === 'z') {
    keyboardEvent.preventDefault();
    if (keyboardEvent.shiftKey) redoDrawing();
    else undoDrawing();
    setState({});
    return;
  }
  if (isCommand) return;

  const frame = focusedFrame();
  const nudgeDistance = keyboardEvent.shiftKey ? 10 : 1;
  const arrowNudges: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const nudge = arrowNudges[keyboardEvent.key];
  if (nudge !== undefined && state.stageMode === 'align' && frame !== undefined) {
    keyboardEvent.preventDefault();
    mutateProject(() => {
      frame.offsetX += nudge[0] * nudgeDistance;
      frame.offsetY += nudge[1] * nudgeDistance;
    });
    return;
  }
  switch (keyboardEvent.key) {
    case ' ':
      if (target.tagName === 'BUTTON') return;
      keyboardEvent.preventDefault();
      setState({ isPlaying: !state.isPlaying, stageMode: !state.isPlaying ? 'play' : state.stageMode });
      break;
    case ',':
    case 'ArrowLeft':
      setState({ isPlaying: false });
      stepTimeline(-1);
      break;
    case '.':
    case 'ArrowRight':
      setState({ isPlaying: false });
      stepTimeline(1);
      break;
    case '1': setState({ stageMode: 'play' }); break;
    case '2': setState({ stageMode: 'align', isPlaying: false }); break;
    case '3': setState({ stageMode: 'draw', isPlaying: false }); break;
    case 'o': setState({ onionSkinEnabled: !state.onionSkinEnabled }); break;
    case 'b': setState({ drawTool: 'pencil', stageMode: 'draw', isPlaying: false }); break;
    case 'e': setState({ drawTool: 'eraser', stageMode: 'draw', isPlaying: false }); break;
    case 'i': setState({ drawTool: 'picker', stageMode: 'draw', isPlaying: false }); break;
    case '[': setState({ brushSize: Math.max(1, state.brushSize - 1) }); break;
    case ']': setState({ brushSize: Math.min(64, state.brushSize + 1) }); break;
    default: return;
  }
});

window.addEventListener('beforeunload', (unloadEvent) => {
  if (!hasUnsavedWork()) return;
  void flushSave();
  unloadEvent.preventDefault();
});

document.addEventListener('visibilitychange', () => {
  // iPad Safari may freeze a backgrounded tab without firing beforeunload.
  if (document.visibilityState === 'hidden') void flushSave();
});
