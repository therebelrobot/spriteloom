import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStorage, RevisionConflictError } from '../src/server/storage';

const tinyPngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function withStorage(run: (storage: ProjectStorage, dataDirectory: string) => Promise<void>): Promise<void> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'spriteloom-test-'));
  const storage = new ProjectStorage(dataDirectory);
  await storage.initialize();
  try {
    await run(storage, dataDirectory);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

test('saving bumps the revision and rejects stale writes', () =>
  withStorage(async (storage) => {
    const project = await storage.createProject('Hero');
    const firstSave = await storage.saveProject(project.id, { ...project, name: 'Hero walk' }, 0);
    assert.equal(firstSave.revision, 1);
    assert.equal(firstSave.name, 'Hero walk');
    await assert.rejects(storage.saveProject(project.id, project, 0), RevisionConflictError);
  }));

test('removing a frame deletes its pixels but leaves freshly uploaded ones alone', () =>
  withStorage(async (storage, dataDirectory) => {
    const project = await storage.createProject('Hero');
    await storage.writeFramePixels(project.id, 'frame-a', tinyPngBytes);
    await storage.writeFramePixels(project.id, 'frame-b', tinyPngBytes);
    const frameA = { id: 'frame-a', name: 'a', width: 1, height: 1, offsetX: 0, offsetY: 0 };
    const withFrame = await storage.saveProject(project.id, { ...project, frames: [frameA] }, 0);
    await storage.saveProject(project.id, { ...withFrame, frames: [] }, withFrame.revision);
    const remainingFiles = await readdir(join(dataDirectory, 'projects', project.id, 'frames'));
    assert.deepEqual(remainingFiles.sort(), ['frame-b.png']);
  }));

test('sanitizing drops cells that point at missing frames and clamps numbers', () =>
  withStorage(async (storage) => {
    const project = await storage.createProject('Hero');
    const saved = await storage.saveProject(project.id, {
      ...project,
      cellWidth: 999_999,
      frames: [{ id: 'frame-a', name: 'a', width: 4, height: 4, offsetX: 0, offsetY: 0 }],
      animations: [{ id: 'walk', name: 'walk', ticksPerSecond: 12, loopMode: 'loop', cells: [{ frameId: 'frame-a', holdTicks: 2 }, { frameId: 'ghost', holdTicks: 1 }] }],
    }, 0);
    assert.equal(saved.cellWidth, 8192);
    assert.deepEqual(saved.animations[0]?.cells, [{ frameId: 'frame-a', holdTicks: 2 }]);
  }));

test('frame uploads must be PNGs and ids cannot escape the data folder', () =>
  withStorage(async (storage) => {
    const project = await storage.createProject('Hero');
    await assert.rejects(storage.writeFramePixels(project.id, 'frame-a', Buffer.from('not a png')));
    await assert.rejects(storage.writeFramePixels(project.id, '../escape', tinyPngBytes));
    await assert.rejects(storage.readProject('../../etc'));
  }));
