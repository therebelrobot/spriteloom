import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createEmptyProject,
  identifierPattern,
  sanitizeProject,
  type ProjectDocument,
  type ProjectSummary,
} from '../shared/project';

const pngSignatureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class RevisionConflictError extends Error {
  constructor(public readonly currentProject: ProjectDocument) {
    super('Project was changed somewhere else.');
  }
}

export class NotFoundError extends Error {}

export class ProjectStorage {
  private readonly projectsDirectory: string;
  /** Serializes writes per project so concurrent saves can't interleave. */
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(dataDirectory: string) {
    this.projectsDirectory = join(dataDirectory, 'projects');
  }

  async initialize(): Promise<void> {
    await mkdir(this.projectsDirectory, { recursive: true });
  }

  private projectDirectory(projectIdentifier: string): string {
    if (!identifierPattern.test(projectIdentifier)) throw new NotFoundError('Unknown project.');
    return join(this.projectsDirectory, projectIdentifier);
  }

  private framePath(projectIdentifier: string, frameIdentifier: string): string {
    if (!identifierPattern.test(frameIdentifier)) throw new NotFoundError('Unknown frame.');
    return join(this.projectDirectory(projectIdentifier), 'frames', `${frameIdentifier}.png`);
  }

  private async withProjectLock<Result>(projectIdentifier: string, work: () => Promise<Result>): Promise<Result> {
    const previousWork = this.writeQueues.get(projectIdentifier) ?? Promise.resolve();
    const nextWork = previousWork.catch(() => undefined).then(work);
    this.writeQueues.set(projectIdentifier, nextWork);
    try {
      return await nextWork;
    } finally {
      if (this.writeQueues.get(projectIdentifier) === nextWork) this.writeQueues.delete(projectIdentifier);
    }
  }

  private async writeFileAtomically(destinationPath: string, contents: string | Uint8Array): Promise<void> {
    const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, destinationPath);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const directoryEntries = await readdir(this.projectsDirectory, { withFileTypes: true });
    const summaries: ProjectSummary[] = [];
    for (const directoryEntry of directoryEntries) {
      if (!directoryEntry.isDirectory() || !identifierPattern.test(directoryEntry.name)) continue;
      try {
        const project = await this.readProject(directoryEntry.name);
        summaries.push({
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt,
          frameCount: project.frames.length,
          animationCount: project.animations.length,
          coverFrameId: project.animations[0]?.cells[0]?.frameId ?? project.frames[0]?.id ?? null,
        });
      } catch {
        // A half-written or hand-edited project shouldn't break the list.
      }
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createProject(projectName: string): Promise<ProjectDocument> {
    const project = createEmptyProject(projectName);
    const directory = this.projectDirectory(project.id);
    await mkdir(join(directory, 'frames'), { recursive: true });
    await this.writeFileAtomically(join(directory, 'project.json'), JSON.stringify(project, null, 2));
    return project;
  }

  async readProject(projectIdentifier: string): Promise<ProjectDocument> {
    const projectJsonPath = join(this.projectDirectory(projectIdentifier), 'project.json');
    let rawJson: string;
    try {
      rawJson = await readFile(projectJsonPath, 'utf8');
    } catch {
      throw new NotFoundError('Unknown project.');
    }
    return sanitizeProject(JSON.parse(rawJson), projectIdentifier);
  }

  async saveProject(projectIdentifier: string, untrustedProject: unknown, baseRevision: number): Promise<ProjectDocument> {
    return this.withProjectLock(projectIdentifier, async () => {
      const storedProject = await this.readProject(projectIdentifier);
      if (storedProject.revision !== baseRevision) throw new RevisionConflictError(storedProject);

      const incomingProject = sanitizeProject(untrustedProject, projectIdentifier);
      const savedProject: ProjectDocument = {
        ...incomingProject,
        createdAt: storedProject.createdAt,
        revision: storedProject.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.writeFileAtomically(
        join(this.projectDirectory(projectIdentifier), 'project.json'),
        JSON.stringify(savedProject, null, 2),
      );

      // Only frames that existed before and are gone now get their pixels removed.
      // Pixels uploaded for frames the project doesn't list yet are left alone,
      // because the save that adds them may still be on its way.
      const keptFrameIdentifiers = new Set(savedProject.frames.map((frame) => frame.id));
      for (const previousFrame of storedProject.frames) {
        if (!keptFrameIdentifiers.has(previousFrame.id)) {
          await rm(this.framePath(projectIdentifier, previousFrame.id), { force: true });
        }
      }
      return savedProject;
    });
  }

  async deleteProject(projectIdentifier: string): Promise<void> {
    await this.withProjectLock(projectIdentifier, async () => {
      await rm(this.projectDirectory(projectIdentifier), { recursive: true, force: true });
    });
  }

  async writeFramePixels(projectIdentifier: string, frameIdentifier: string, pngBytes: Buffer): Promise<void> {
    if (pngBytes.length < 8 || !pngBytes.subarray(0, 8).equals(pngSignatureBytes)) {
      throw new Error('Frame upload must be a PNG image.');
    }
    await this.readProject(projectIdentifier);
    const destinationPath = this.framePath(projectIdentifier, frameIdentifier);
    await mkdir(join(this.projectDirectory(projectIdentifier), 'frames'), { recursive: true });
    await this.writeFileAtomically(destinationPath, pngBytes);
  }

  async readFramePixels(projectIdentifier: string, frameIdentifier: string): Promise<{ bytes: Buffer; modifiedAt: Date }> {
    const sourcePath = this.framePath(projectIdentifier, frameIdentifier);
    try {
      const [bytes, fileStats] = await Promise.all([readFile(sourcePath), stat(sourcePath)]);
      return { bytes, modifiedAt: fileStats.mtime };
    } catch {
      throw new NotFoundError('Unknown frame.');
    }
  }
}
