// The project shelf: every sprite project on this server.
import type { ProjectSummary } from '../../shared/project';
import * as api from '../api';
import { h, icon, replaceChildren, showToast } from './dom';

function relativeTime(isoTimestamp: string): string {
  const elapsedSeconds = (Date.now() - new Date(isoTimestamp).getTime()) / 1000;
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (elapsedSeconds < 60) return 'just now';
  if (elapsedSeconds < 3600) return formatter.format(-Math.round(elapsedSeconds / 60), 'minute');
  if (elapsedSeconds < 86_400) return formatter.format(-Math.round(elapsedSeconds / 3600), 'hour');
  if (elapsedSeconds < 86_400 * 30) return formatter.format(-Math.round(elapsedSeconds / 86_400), 'day');
  return new Date(isoTimestamp).toLocaleDateString();
}

export function createHome(openProject: (projectIdentifier: string) => void): { element: HTMLElement; refresh: () => Promise<void> } {
  const list = h('div', { className: 'project-list' });
  const nameInput = h('input', { type: 'text', placeholder: 'Name it, e.g. “Weaver idle”', 'aria-label': 'New project name', maxLength: 120 });
  const createForm = h('form', {
    className: 'new-project',
    onsubmit: async (submitEvent: SubmitEvent) => {
      submitEvent.preventDefault();
      try {
        const project = await api.createProject(nameInput.value.trim() || 'Untitled sprite');
        nameInput.value = '';
        openProject(project.id);
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Could not create the project.', 'error');
      }
    },
  }, nameInput, h('button', { type: 'submit', className: 'primary-button' }, icon('plus'), 'New project'));

  const element = h('main', { className: 'home' },
    h('header', { className: 'home-header' },
      h('div', { className: 'wordmark' }, h('span', { className: 'wordmark-mark', 'aria-hidden': 'true' }), h('h1', null, 'spriteloom')),
      h('p', { className: 'home-lede' }, 'Draw in Procreate. Line up, time and export your sprites here.'),
    ),
    createForm,
    list,
  );

  function projectCard(summary: ProjectSummary): HTMLElement {
    const cover = summary.coverFrameId !== null
      ? h('img', { src: api.framePixelsUrl(summary.id, summary.coverFrameId), alt: '', loading: 'lazy' })
      : h('span', { className: 'cover-empty' }, icon('import'));
    return h('article', { className: 'project-card' },
      h('button', { type: 'button', className: 'project-open', onclick: () => openProject(summary.id) },
        h('div', { className: 'project-cover' }, cover),
        h('div', { className: 'project-text' },
          h('h2', null, summary.name),
          h('p', null, `${summary.frameCount} frame${summary.frameCount === 1 ? '' : 's'}, ${summary.animationCount} animation${summary.animationCount === 1 ? '' : 's'}`),
          h('p', { className: 'muted small' }, `Edited ${relativeTime(summary.updatedAt)}`),
        ),
      ),
      h('button', {
        type: 'button', className: 'icon-button is-danger project-delete', title: `Delete ${summary.name}`, 'aria-label': `Delete ${summary.name}`,
        onclick: async () => {
          if (!window.confirm(`Delete “${summary.name}” and all of its frames? This can’t be undone.`)) return;
          await api.deleteProject(summary.id);
          showToast(`Deleted “${summary.name}”.`);
          await refresh();
        },
      }, icon('trash')),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const summaries = await api.listProjects();
      replaceChildren(list, summaries.length === 0
        ? h('p', { className: 'empty-shelf' }, 'No projects yet. Name one above to start.')
        : summaries.map(projectCard));
    } catch (error) {
      replaceChildren(list, h('p', { className: 'form-error' }, `Can’t reach the server: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
  }

  return { element, refresh };
}
