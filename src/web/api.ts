import type { ProjectDocument, ProjectSummary } from '../shared/project';

export class ConflictError extends Error {
  constructor(public readonly serverProject: ProjectDocument) {
    super('This project was changed on another device.');
  }
}

async function requestJson<ResponseShape>(path: string, init: RequestInit = {}): Promise<ResponseShape> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 409 && payload.project !== undefined) throw new ConflictError(payload.project as ProjectDocument);
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Server answered ${response.status}.`);
  return payload as ResponseShape;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return (await requestJson<{ projects: ProjectSummary[] }>('/api/projects')).projects;
}

export async function createProject(projectName: string): Promise<ProjectDocument> {
  return (await requestJson<{ project: ProjectDocument }>('/api/projects', { method: 'POST', body: JSON.stringify({ name: projectName }) })).project;
}

export async function fetchProject(projectIdentifier: string): Promise<ProjectDocument> {
  return (await requestJson<{ project: ProjectDocument }>(`/api/projects/${projectIdentifier}`)).project;
}

export async function saveProject(project: ProjectDocument, baseRevision: number): Promise<ProjectDocument> {
  return (
    await requestJson<{ project: ProjectDocument }>(`/api/projects/${project.id}`, {
      method: 'PUT',
      body: JSON.stringify({ project, baseRevision }),
    })
  ).project;
}

export async function deleteProject(projectIdentifier: string): Promise<void> {
  await requestJson(`/api/projects/${projectIdentifier}`, { method: 'DELETE' });
}

export function framePixelsUrl(projectIdentifier: string, frameIdentifier: string): string {
  return `/api/projects/${projectIdentifier}/frames/${frameIdentifier}.png`;
}

export async function uploadFramePixels(projectIdentifier: string, frameIdentifier: string, pngBlob: Blob): Promise<void> {
  const response = await fetch(framePixelsUrl(projectIdentifier, frameIdentifier), {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: pngBlob,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Frame upload failed (${response.status}).`);
  }
}
