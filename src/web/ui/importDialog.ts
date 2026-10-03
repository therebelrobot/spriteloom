// Bringing frames in: pick or drop files, review what was found, then add them.
import { commitImport, readImportFiles, sliceSheet, suggestTiming, type ImportedImage, type ImportedSource } from '../importing';
import { state } from '../store';
import { h, icon, iconButton, replaceChildren, showToast } from './dom';

interface SourcePlan {
  source: ImportedSource;
  includeInImport: boolean;
  makeAnimation: boolean;
  animationName: string;
  sheetColumns: number;
  sheetRows: number;
}

export function createImportDialog(): { dialog: HTMLDialogElement; open: (files?: File[]) => void } {
  const fileInput = h('input', {
    type: 'file',
    multiple: true,
    accept: 'image/png,image/gif,image/webp,image/jpeg,.png,.apng,.gif,.zip,application/zip',
    className: 'visually-hidden',
    id: 'import-file-input',
  });
  const body = h('div', { className: 'dialog-body' });
  const footer = h('div', { className: 'dialog-footer' });
  const dialog = h('dialog', { className: 'sheet-dialog import-dialog', 'aria-labelledby': 'import-title' },
    h('header', { className: 'dialog-header' },
      h('h2', { id: 'import-title' }, 'Import frames'),
      iconButton('close', 'Close', () => dialog.close()),
    ),
    body,
    footer,
    fileInput,
  );

  let plans: SourcePlan[] = [];
  let mergeRepeatedFrames = true;
  let skipEmptyFrames = true;
  let isWorking = false;

  function renderPicker(message?: string): void {
    plans = [];
    const dropZone = h('label', { className: 'drop-zone', htmlFor: 'import-file-input' },
      icon('import'),
      h('strong', null, 'Choose files or drop them here'),
      h('span', null, 'Animated PNG or GIF, a set of PNGs, a zip of PNGs, or a finished spritesheet.'),
    );
    for (const eventName of ['dragenter', 'dragover'] as const) {
      dropZone.addEventListener(eventName, (dragEvent) => {
        dragEvent.preventDefault();
        dropZone.classList.add('is-dragging');
      });
    }
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-dragging'));
    dropZone.addEventListener('drop', (dragEvent) => {
      dragEvent.preventDefault();
      dropZone.classList.remove('is-dragging');
      void readFiles([...(dragEvent.dataTransfer?.files ?? [])]);
    });
    replaceChildren(body,
      dropZone,
      message !== undefined ? h('p', { className: 'form-error', role: 'alert' }, message) : null,
      h('details', { className: 'how-to' },
        h('summary', null, 'Getting frames out of Procreate'),
        h('ol', null,
          h('li', null, 'Turn on Animation Assist and hide the background layer so the frames keep transparency.'),
          h('li', null, 'Open Actions › Share and pick Animated PNG under Share Layers. Choose the frame rate you animated at.'),
          h('li', null, 'Save it to Files, then choose it here. Every frame comes in at full canvas size, already lined up, with its timing.'),
        ),
        h('p', null, 'Prefer separate files? Share › PNG Files exports each layer as its own PNG; select them all, or zip the folder first. Groups need to be flattened into single layers for that route.'),
      ),
    );
    replaceChildren(footer, h('button', { type: 'button', className: 'text-button', onclick: () => dialog.close() }, 'Cancel'));
  }

  async function readFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    replaceChildren(body, h('p', { className: 'working' }, `Reading ${files.length} file${files.length === 1 ? '' : 's'}…`));
    try {
      const sources = await readImportFiles(files);
      if (sources.every((source) => source.images.length === 0)) {
        renderPicker('No images were found in those files.');
        return;
      }
      plans = sources.filter((source) => source.images.length > 0).map((source) => ({
        source,
        includeInImport: true,
        makeAnimation: source.images.length > 1,
        animationName: source.sourceName.slice(0, 60) || 'animation',
        sheetColumns: 1,
        sheetRows: 1,
      }));
      renderReview();
    } catch (error) {
      renderPicker(error instanceof Error ? `Couldn’t read that: ${error.message}` : 'Couldn’t read those files.');
    }
  }

  function imagesForPlan(plan: SourcePlan): ImportedImage[] {
    if (plan.source.images.length === 1 && (plan.sheetColumns > 1 || plan.sheetRows > 1)) {
      return sliceSheet(plan.source.images[0]!, plan.sheetColumns, plan.sheetRows);
    }
    return plan.source.images;
  }

  function previewStrip(images: readonly ImportedImage[]): HTMLElement {
    const shownImages = images.slice(0, 10);
    return h('div', { className: 'import-preview' },
      shownImages.map((image) => {
        const thumbnail = h('canvas', { className: 'import-thumb' });
        const scale = Math.min(56 / image.canvas.width, 56 / image.canvas.height, 4);
        thumbnail.width = Math.max(1, Math.round(image.canvas.width * scale));
        thumbnail.height = Math.max(1, Math.round(image.canvas.height * scale));
        const thumbnailContext = thumbnail.getContext('2d')!;
        thumbnailContext.imageSmoothingEnabled = scale < 1;
        thumbnailContext.drawImage(image.canvas, 0, 0, thumbnail.width, thumbnail.height);
        return thumbnail;
      }),
      images.length > shownImages.length ? h('span', { className: 'import-more' }, `+${images.length - shownImages.length}`) : null,
    );
  }

  function renderReview(): void {
    const sourceCards = plans.map((plan) => {
      const images = imagesForPlan(plan);
      const timing = suggestTiming(images);
      const first = plan.source.images[0]!;
      const card = h('article', { className: 'import-source' },
        h('label', { className: 'check-row source-title' },
          h('input', { type: 'checkbox', checked: plan.includeInImport, onchange: (changeEvent: Event) => { plan.includeInImport = (changeEvent.target as HTMLInputElement).checked; renderReview(); } }),
          h('strong', null, plan.source.sourceName),
          h('span', { className: 'muted' }, `${images.length} frame${images.length === 1 ? '' : 's'} · ${first.canvas.width}×${first.canvas.height}`),
        ),
        previewStrip(images),
        plan.source.notes.map((note) => h('p', { className: 'muted small' }, note)),
        plan.source.images.length === 1
          ? h('div', { className: 'sheet-slicer' },
              h('span', null, 'Is this a sheet? Cut it into'),
              h('input', { type: 'number', min: '1', max: '64', value: String(plan.sheetColumns), 'aria-label': 'Columns', onchange: (changeEvent: Event) => { plan.sheetColumns = Math.max(1, Number((changeEvent.target as HTMLInputElement).value) || 1); plan.makeAnimation = plan.sheetColumns * plan.sheetRows > 1; renderReview(); } }),
              h('span', null, 'columns ×'),
              h('input', { type: 'number', min: '1', max: '64', value: String(plan.sheetRows), 'aria-label': 'Rows', onchange: (changeEvent: Event) => { plan.sheetRows = Math.max(1, Number((changeEvent.target as HTMLInputElement).value) || 1); plan.makeAnimation = plan.sheetColumns * plan.sheetRows > 1; renderReview(); } }),
              h('span', null, 'rows'),
            )
          : null,
        h('label', { className: 'check-row' },
          h('input', { type: 'checkbox', checked: plan.makeAnimation, onchange: (changeEvent: Event) => { plan.makeAnimation = (changeEvent.target as HTMLInputElement).checked; renderReview(); } }),
          h('span', null, 'Make an animation named'),
          h('input', { type: 'text', value: plan.animationName, disabled: !plan.makeAnimation, className: 'inline-text', oninput: (inputEvent: Event) => { plan.animationName = (inputEvent.target as HTMLInputElement).value; } }),
          plan.makeAnimation && plan.source.wasAnimated ? h('span', { className: 'muted small' }, `at ${timing.ticksPerSecond} fps, from the file’s timing`) : null,
        ),
      );
      card.classList.toggle('is-skipped', !plan.includeInImport);
      return card;
    });

    const isFirstImport = (state.project?.frames.length ?? 0) === 0;
    replaceChildren(body,
      sourceCards,
      h('div', { className: 'import-options' },
        h('label', { className: 'check-row' }, h('input', { type: 'checkbox', checked: mergeRepeatedFrames, onchange: (changeEvent: Event) => { mergeRepeatedFrames = (changeEvent.target as HTMLInputElement).checked; } }), h('span', null, 'Turn repeated frames into holds')),
        h('label', { className: 'check-row' }, h('input', { type: 'checkbox', checked: skipEmptyFrames, onchange: (changeEvent: Event) => { skipEmptyFrames = (changeEvent.target as HTMLInputElement).checked; } }), h('span', null, 'Skip empty frames')),
        isFirstImport ? h('p', { className: 'muted small' }, 'The cell size will match your largest frame. You can change it later.') : null,
      ),
    );
    const totalFrames = plans.filter((plan) => plan.includeInImport).reduce((sum, plan) => sum + imagesForPlan(plan).length, 0);
    replaceChildren(footer,
      h('button', { type: 'button', className: 'text-button', onclick: () => renderPicker() }, 'Choose different files'),
      h('button', { type: 'button', className: 'primary-button', disabled: totalFrames === 0 || isWorking, onclick: () => void runImport() }, `Import ${totalFrames} frame${totalFrames === 1 ? '' : 's'}`),
    );
  }

  async function runImport(): Promise<void> {
    isWorking = true;
    const progressLine = h('p', { className: 'working', role: 'status' }, 'Saving frames…');
    replaceChildren(body, progressLine);
    replaceChildren(footer);
    const summaries: string[] = [];
    try {
      for (const plan of plans.filter((candidate) => candidate.includeInImport)) {
        const result = await commitImport(imagesForPlan(plan), {
          createAnimationNamed: plan.makeAnimation ? plan.animationName.trim() || 'animation' : null,
          ticksPerSecond: null,
          mergeRepeatedFrames,
          skipEmptyFrames,
        }, (completedCount, totalCount) => {
          progressLine.textContent = `Saving ${plan.source.sourceName}: ${completedCount} of ${totalCount}`;
        });
        summaries.push(result.animationName !== null ? `${result.addedFrameCount} frames as “${result.animationName}”` : `${result.addedFrameCount} frames`);
      }
      dialog.close();
      showToast(`Imported ${summaries.join(', ')}.`);
    } catch (error) {
      renderPicker(error instanceof Error ? `Import stopped: ${error.message}` : 'Import stopped.');
    } finally {
      isWorking = false;
    }
  }

  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    void readFiles(files);
  });

  return {
    dialog,
    open: (files?: File[]) => {
      renderPicker();
      if (!dialog.open) dialog.showModal();
      if (files !== undefined && files.length > 0) void readFiles(files);
    },
  };
}
