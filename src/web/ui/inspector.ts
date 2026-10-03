// Settings for the current animation, the focused frame, and the project.
import type { LoopMode, RenderMode } from '../../shared/project';
import { formatDuration } from '../render';
import {
  deleteFrames,
  duplicateFrame,
  expandFrameToCell,
  focusedFrame,
  mutateProject,
  selectedAnimation,
  setState,
  state,
  subscribe,
} from '../store';
import { h, icon, iconButton, showToast } from './dom';

interface BoundField {
  element: HTMLElement;
  refresh: () => void;
}

function numberField(labelText: string, readValue: () => number | undefined, writeValue: (nextValue: number) => void, options: { minimum?: number; maximum?: number; step?: number; suffix?: string } = {}): BoundField {
  const { minimum = -100_000, maximum = 100_000, step = 1, suffix } = options;
  const input = h('input', { type: 'number', inputMode: 'numeric', step: String(step), min: String(minimum), max: String(maximum) });
  const commit = (nextValue: number): void => {
    if (!Number.isFinite(nextValue)) return;
    writeValue(Math.min(maximum, Math.max(minimum, Math.round(nextValue))));
  };
  input.addEventListener('change', () => commit(Number(input.value)));
  input.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.key === 'Enter') input.blur();
  });
  const element = h('label', { className: 'field number-field' },
    h('span', { className: 'field-label' }, labelText),
    h('span', { className: 'stepper' },
      iconButton('minus', `${labelText} down`, () => commit((readValue() ?? 0) - step)),
      input,
      iconButton('plus', `${labelText} up`, () => commit((readValue() ?? 0) + step)),
      suffix !== undefined ? h('span', { className: 'field-suffix' }, suffix) : null,
    ),
  );
  return {
    element,
    refresh: () => {
      if (document.activeElement !== input) input.value = String(readValue() ?? '');
    },
  };
}

function textField(labelText: string, readValue: () => string | undefined, writeValue: (nextValue: string) => void): BoundField {
  const input = h('input', { type: 'text', autocomplete: 'off', spellcheck: false });
  input.addEventListener('change', () => {
    const trimmedValue = input.value.trim();
    if (trimmedValue !== '') writeValue(trimmedValue.slice(0, 80));
  });
  input.addEventListener('keydown', (keyboardEvent) => {
    if (keyboardEvent.key === 'Enter') input.blur();
  });
  return {
    element: h('label', { className: 'field' }, h('span', { className: 'field-label' }, labelText), input),
    refresh: () => {
      if (document.activeElement !== input) input.value = readValue() ?? '';
    },
  };
}

function segmentedField<Value extends string>(labelText: string, choices: [Value, string][], readValue: () => Value | undefined, writeValue: (nextValue: Value) => void): BoundField {
  const buttons = choices.map(([value, label]) => {
    const button = h('button', { type: 'button', role: 'radio', onclick: () => writeValue(value) }, label);
    return { value, button };
  });
  return {
    element: h('div', { className: 'field' }, h('span', { className: 'field-label' }, labelText),
      h('div', { className: 'segmented', role: 'radiogroup', 'aria-label': labelText }, buttons.map(({ button }) => button))),
    refresh: () => {
      const currentValue = readValue();
      for (const { value, button } of buttons) button.setAttribute('aria-checked', String(value === currentValue));
    },
  };
}

export function createInspector(): HTMLElement {
  // ----- animation -----
  const animationName = textField('Name', () => selectedAnimation()?.name, (nextName) => mutateProject(() => { const animation = selectedAnimation(); if (animation) animation.name = nextName; }));
  const ticksPerSecond = numberField('Speed', () => selectedAnimation()?.ticksPerSecond, (nextRate) => mutateProject(() => { const animation = selectedAnimation(); if (animation) animation.ticksPerSecond = nextRate; }), { minimum: 1, maximum: 60, suffix: 'fps' });
  const ratePresets = h('div', { className: 'chip-row' },
    [8, 12, 15, 24].map((presetRate) => h('button', { type: 'button', className: 'chip', onclick: () => mutateProject(() => { const animation = selectedAnimation(); if (animation) animation.ticksPerSecond = presetRate; }) }, `${presetRate}`)),
  );
  const loopMode = segmentedField<LoopMode>('Plays', [['loop', 'Loop'], ['pingpong', 'Ping-pong'], ['once', 'Once']], () => selectedAnimation()?.loopMode, (nextMode) => mutateProject(() => { const animation = selectedAnimation(); if (animation) animation.loopMode = nextMode; }));
  const durationLine = h('p', { className: 'readout-line' });
  const animationSection = h('section', { className: 'inspector-section' },
    h('h3', null, 'Animation'),
    animationName.element, ticksPerSecond.element, ratePresets, loopMode.element, durationLine,
    h('div', { className: 'section-actions' },
      h('button', {
        type: 'button', className: 'text-button is-danger',
        onclick: () => {
          const animation = selectedAnimation();
          if (animation === undefined || !window.confirm(`Delete the animation “${animation.name}”? Its frames stay in the library.`)) return;
          mutateProject((project) => (project.animations = project.animations.filter((candidate) => candidate.id !== animation.id)));
          setState({ selectedAnimationId: state.project?.animations[0]?.id ?? null, timelineCursor: 0, isPlaying: false });
        },
      }, 'Delete animation'),
    ),
  );

  // ----- frame -----
  const nudge = (deltaX: number, deltaY: number): void => {
    const frame = focusedFrame();
    if (frame === undefined) return;
    mutateProject(() => {
      frame.offsetX += deltaX;
      frame.offsetY += deltaY;
    });
  };
  const frameName = textField('Name', () => focusedFrame()?.name, (nextName) => mutateProject(() => { const frame = focusedFrame(); if (frame) frame.name = nextName; }));
  const offsetX = numberField('X', () => focusedFrame()?.offsetX, (nextValue) => mutateProject(() => { const frame = focusedFrame(); if (frame) frame.offsetX = nextValue; }));
  const offsetY = numberField('Y', () => focusedFrame()?.offsetY, (nextValue) => mutateProject(() => { const frame = focusedFrame(); if (frame) frame.offsetY = nextValue; }));
  const frameSizeLine = h('p', { className: 'readout-line' });
  const nudgePad = h('div', { className: 'nudge-pad', role: 'group', 'aria-label': 'Nudge frame one pixel' },
    h('span'), iconButton('up', 'Nudge up', () => nudge(0, -1)), h('span'),
    iconButton('left', 'Nudge left', () => nudge(-1, 0)), h('span', { className: 'nudge-center' }, icon('center')), iconButton('right', 'Nudge right', () => nudge(1, 0)),
    h('span'), iconButton('down', 'Nudge down', () => nudge(0, 1)), h('span'),
  );
  const frameSection = h('section', { className: 'inspector-section' },
    h('h3', null, 'Frame'),
    frameName.element,
    h('p', { className: 'section-note' }, 'Drag on the table in Align mode, or nudge a pixel at a time. Arrow keys work too; hold Shift for 10.'),
    h('div', { className: 'offset-row' }, h('div', { className: 'offset-fields' }, offsetX.element, offsetY.element), nudgePad),
    frameSizeLine,
    h('div', { className: 'section-actions' },
      h('button', { type: 'button', className: 'text-button', onclick: () => { const frame = focusedFrame(); const project = state.project; if (frame && project) mutateProject(() => { frame.offsetX = Math.round((project.cellWidth - frame.width) / 2); frame.offsetY = project.cellHeight - frame.height; }); } }, 'Stand on floor'),
      h('button', { type: 'button', className: 'text-button', onclick: async () => { const frame = focusedFrame(); if (frame) { const copy = await duplicateFrame(frame.id); if (copy) { setState({ focusedFrameId: copy.id }); showToast('Duplicated. Add the copy to the timeline with its + button.'); } } } }, 'Duplicate'),
      h('button', { type: 'button', className: 'text-button', title: 'Grow this frame to the full cell so you can draw anywhere in it', onclick: () => { const frame = focusedFrame(); if (frame) void expandFrameToCell(frame.id); } }, 'Fill cell'),
      h('button', { type: 'button', className: 'text-button is-danger', onclick: () => { const frame = focusedFrame(); if (frame && window.confirm(`Delete “${frame.name}”? It also leaves every animation that uses it.`)) deleteFrames(new Set([frame.id])); } }, 'Delete'),
    ),
  );

  // ----- project -----
  const cellWidth = numberField('Width', () => state.project?.cellWidth, (nextValue) => mutateProject((project) => (project.cellWidth = nextValue)), { minimum: 1, maximum: 8192, suffix: 'px' });
  const cellHeight = numberField('Height', () => state.project?.cellHeight, (nextValue) => mutateProject((project) => (project.cellHeight = nextValue)), { minimum: 1, maximum: 8192, suffix: 'px' });
  const pivotX = numberField('Pivot X', () => state.project?.pivotX, (nextValue) => mutateProject((project) => (project.pivotX = nextValue)));
  const pivotY = numberField('Pivot Y', () => state.project?.pivotY, (nextValue) => mutateProject((project) => (project.pivotY = nextValue)));
  const placePivotButton = h('button', { type: 'button', className: 'text-button', onclick: () => setState({ isPlacingPivot: !state.isPlacingPivot, isPlaying: false }) }, icon('pivot'), 'Place on table');
  const renderMode = segmentedField<RenderMode>('Art style', [['smooth', 'Painted'], ['pixel', 'Pixel art']], () => state.project?.renderMode, (nextMode) => mutateProject((project) => (project.renderMode = nextMode)));
  const stageBackground = segmentedField<string>('Table', [['lighttable', 'Light'], ['checker', 'Checker'], ['grey', 'Grey'], ['dark', 'Dark']], () => state.project?.stageBackground, (nextBackground) => mutateProject((project) => (project.stageBackground = nextBackground)));
  const projectSection = h('section', { className: 'inspector-section' },
    h('h3', null, 'Cell'),
    h('p', { className: 'section-note' }, 'Every frame sits in a cell of this size. The pivot becomes the sprite’s anchor in PixiJS.'),
    h('div', { className: 'pair-row' }, cellWidth.element, cellHeight.element),
    h('div', { className: 'pair-row' }, pivotX.element, pivotY.element),
    h('div', { className: 'chip-row' },
      placePivotButton,
      h('button', { type: 'button', className: 'chip', onclick: () => mutateProject((project) => { project.pivotX = Math.round(project.cellWidth / 2); project.pivotY = project.cellHeight; }) }, 'Feet'),
      h('button', { type: 'button', className: 'chip', onclick: () => mutateProject((project) => { project.pivotX = Math.round(project.cellWidth / 2); project.pivotY = Math.round(project.cellHeight / 2); }) }, 'Center'),
    ),
    renderMode.element,
    stageBackground.element,
  );

  const fields = [animationName, ticksPerSecond, loopMode, frameName, offsetX, offsetY, cellWidth, cellHeight, pivotX, pivotY, renderMode, stageBackground];
  const root = h('aside', { className: 'panel inspector', 'aria-label': 'Inspector' }, animationSection, frameSection, projectSection);

  subscribe(() => {
    if (state.project === null) return;
    const animation = selectedAnimation();
    const frame = focusedFrame();
    animationSection.hidden = animation === undefined;
    frameSection.hidden = frame === undefined;
    for (const field of fields) field.refresh();
    if (animation !== undefined) durationLine.textContent = animation.cells.length > 0 ? `Runs ${formatDuration(animation)}` : 'No cells yet';
    if (frame !== undefined) frameSizeLine.textContent = `${frame.width} × ${frame.height} px canvas`;
    placePivotButton.setAttribute('aria-pressed', String(state.isPlacingPivot));
  });
  return root;
}
