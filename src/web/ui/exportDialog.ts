// Choosing formats and downloading the sprite bundle.
import { buildExportBundle, type ExportChoices } from '../export/exporters';
import { mutateProject, requireProject, state } from '../store';
import { downloadBytes, h, iconButton, replaceChildren, slugify } from './dom';

export function createExportDialog(): { dialog: HTMLDialogElement; open: () => void } {
  const body = h('div', { className: 'dialog-body' });
  const footer = h('div', { className: 'dialog-footer' });
  const dialog = h('dialog', { className: 'sheet-dialog export-dialog', 'aria-labelledby': 'export-title' },
    h('header', { className: 'dialog-header' }, h('h2', { id: 'export-title' }, 'Export sprites'), iconButton('close', 'Close', () => dialog.close())),
    body,
    footer,
  );

  const choices: ExportChoices = {
    includePixiAtlas: true,
    includeGridSheet: false,
    includeGifs: true,
    includeAnimatedPngs: false,
    includeFramePngs: false,
    animationIdentifiers: new Set(),
  };

  function checkbox(labelText: string, description: string, isChecked: boolean, onToggle: (nextValue: boolean) => void): HTMLElement {
    return h('label', { className: 'format-option' },
      h('input', { type: 'checkbox', checked: isChecked, onchange: (changeEvent: Event) => onToggle((changeEvent.target as HTMLInputElement).checked) }),
      h('span', { className: 'format-text' }, h('strong', null, labelText), h('span', null, description)),
    );
  }

  function settingNumber(labelText: string, value: number, minimum: number, maximum: number, onChange: (nextValue: number) => void): HTMLElement {
    return h('label', { className: 'field inline-field' }, h('span', { className: 'field-label' }, labelText),
      h('input', { type: 'number', min: String(minimum), max: String(maximum), value: String(value), onchange: (changeEvent: Event) => {
        const nextValue = Math.round(Number((changeEvent.target as HTMLInputElement).value));
        if (Number.isFinite(nextValue)) onChange(Math.min(maximum, Math.max(minimum, nextValue)));
      } }));
  }

  function render(): void {
    const project = requireProject();
    const settings = project.exportSettings;
    const projectSlug = slugify(project.name);
    const firstAnimationSlug = slugify(project.animations[0]?.name ?? 'idle');
    const firstAnimationRate = project.animations[0]?.ticksPerSecond ?? 12;

    replaceChildren(body,
      h('section', { className: 'export-group' },
        h('h3', null, 'Formats'),
        checkbox('PixiJS spritesheet', 'Packed atlas PNG + JSON in the format PixiJS’s Assets loader reads, with anchors and named animations.', choices.includePixiAtlas, (nextValue) => { choices.includePixiAtlas = nextValue; render(); }),
        checkbox('Grid sheet', 'One row per animation, every cell the same size. For engines that slice by grid.', choices.includeGridSheet, (nextValue) => (choices.includeGridSheet = nextValue)),
        checkbox('Animated GIF', 'One per animation, for sharing. 1-bit transparency.', choices.includeGifs, (nextValue) => { choices.includeGifs = nextValue; render(); }),
        checkbox('Animated PNG', 'One per animation, full transparency and exact timing.', choices.includeAnimatedPngs, (nextValue) => { choices.includeAnimatedPngs = nextValue; render(); }),
        checkbox('Frame PNGs', 'Every cell as its own image, numbered, in a folder per animation.', choices.includeFramePngs, (nextValue) => (choices.includeFramePngs = nextValue)),
      ),
      project.animations.length > 0
        ? h('section', { className: 'export-group' },
            h('h3', null, 'Animations'),
            h('div', { className: 'chip-row wrap' }, project.animations.map((animation) =>
              h('label', { className: 'check-chip' },
                h('input', { type: 'checkbox', checked: choices.animationIdentifiers.has(animation.id), disabled: animation.cells.length === 0, onchange: (changeEvent: Event) => {
                  if ((changeEvent.target as HTMLInputElement).checked) choices.animationIdentifiers.add(animation.id);
                  else choices.animationIdentifiers.delete(animation.id);
                } }),
                h('span', null, animation.name, h('span', { className: 'muted' }, ` ${animation.cells.length}`)),
              ),
            )),
          )
        : h('p', { className: 'muted' }, 'No animations yet, so every frame in the library is exported on its own.'),
      choices.includePixiAtlas
        ? h('section', { className: 'export-group' },
            h('h3', null, 'Atlas'),
            h('div', { className: 'settings-row' },
              settingNumber('Padding', settings.atlasPadding, 0, 32, (nextValue) => mutateProject(() => (settings.atlasPadding = nextValue))),
              settingNumber('Max size', settings.maximumAtlasSize, 256, 16384, (nextValue) => mutateProject(() => (settings.maximumAtlasSize = nextValue))),
              h('label', { className: 'check-row' }, h('input', { type: 'checkbox', checked: settings.trimTransparentEdges, onchange: (changeEvent: Event) => mutateProject(() => (settings.trimTransparentEdges = (changeEvent.target as HTMLInputElement).checked)) }), h('span', null, 'Trim transparent edges')),
            ),
          )
        : null,
      choices.includeGifs || choices.includeAnimatedPngs
        ? h('section', { className: 'export-group' },
            h('h3', null, 'Animated previews'),
            h('div', { className: 'settings-row' },
              settingNumber('Scale', settings.previewScale, 1, 16, (nextValue) => mutateProject(() => (settings.previewScale = nextValue))),
              h('label', { className: 'check-row' },
                h('input', { type: 'checkbox', checked: settings.previewBackground !== null, onchange: (changeEvent: Event) => { mutateProject(() => (settings.previewBackground = (changeEvent.target as HTMLInputElement).checked ? '#f3ecd8' : null)); render(); } }),
                h('span', null, 'Solid background'),
              ),
              settings.previewBackground !== null
                ? h('input', { type: 'color', className: 'color-input', value: settings.previewBackground, 'aria-label': 'Background color', onchange: (changeEvent: Event) => mutateProject(() => (settings.previewBackground = (changeEvent.target as HTMLInputElement).value)) })
                : null,
            ),
          )
        : null,
      choices.includePixiAtlas
        ? h('details', { className: 'how-to' },
            h('summary', null, 'Using the spritesheet in PixiJS'),
            h('pre', null, h('code', null,
`import { Assets, AnimatedSprite } from 'pixi.js';

const sheet = await Assets.load('pixi/${projectSlug}.json');
const sprite = new AnimatedSprite(sheet.animations['${firstAnimationSlug}']);
sprite.animationSpeed = ${firstAnimationRate} / 60; // holds are baked in as repeated frames
sprite.play();`)),
            h('p', { className: 'muted small' }, project.renderMode === 'pixel'
              ? 'Pixel art: set the texture source scaleMode to nearest so it stays crisp. Each animation’s fps and loop mode is also in meta.spriteloom.'
              : 'Each animation’s fps and loop mode is also in meta.spriteloom, and every frame carries the pivot as its anchor.'),
          )
        : null,
    );
  }

  function renderFooter(statusText = ''): void {
    replaceChildren(footer,
      h('span', { className: 'export-status', role: 'status' }, statusText),
      h('button', { type: 'button', className: 'text-button', onclick: () => dialog.close() }, 'Close'),
      h('button', { type: 'button', className: 'primary-button', onclick: () => void runExport() }, 'Download .zip'),
    );
  }

  async function runExport(): Promise<void> {
    const project = requireProject();
    const statusLine = h('span', { className: 'export-status', role: 'status' }, 'Starting…');
    replaceChildren(footer, statusLine);
    try {
      const { zipBytes, fileName, warnings } = await buildExportBundle(project, choices, (message) => {
        statusLine.textContent = `${message}…`;
      });
      downloadBytes(zipBytes, fileName, 'application/zip');
      renderFooter(warnings.length > 0 ? warnings.join(' ') : `Downloaded ${fileName} (${(zipBytes.length / 1024).toFixed(0)} KB).`);
    } catch (error) {
      renderFooter(error instanceof Error ? error.message : 'Export failed.');
    }
  }

  return {
    dialog,
    open: () => {
      const project = state.project;
      if (project === null) return;
      choices.animationIdentifiers = new Set(project.animations.filter((animation) => animation.cells.length > 0).map((animation) => animation.id));
      render();
      renderFooter();
      dialog.showModal();
    },
  };
}
