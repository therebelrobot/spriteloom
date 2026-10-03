import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from '../src/web/formats/bytes';
import { readZipArchive, writeZipArchive } from '../src/web/formats/zip';

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip archives round-trip, including names with spaces and unicode', async () => {
  const entries = [
    { path: 'pixi/hero.json', bytes: new TextEncoder().encode('{"frames":{}}') },
    { path: 'frames/walk cycle/ü_000.png', bytes: Uint8Array.from({ length: 300 }, (_, index) => index % 251) },
  ];
  const archive = writeZipArchive(entries);
  const readBack = await readZipArchive(archive);
  assert.deepEqual(readBack.map((entry) => entry.path), entries.map((entry) => entry.path));
  assert.deepEqual([...readBack[1]!.bytes], [...entries[1]!.bytes]);
});

test('reads deflated zips made by the system zip tool', async (testContext) => {
  const workDirectory = await mkdtemp(join(tmpdir(), 'spriteloom-zip-'));
  try {
    const repeatedText = 'frame '.repeat(500);
    await writeFile(join(workDirectory, 'a.txt'), repeatedText);
    try {
      execFileSync('zip', ['-q', '-9', 'archive.zip', 'a.txt'], { cwd: workDirectory });
    } catch {
      testContext.skip('zip command not installed');
      return;
    }
    const entries = await readZipArchive(new Uint8Array(await readFile(join(workDirectory, 'archive.zip'))));
    assert.equal(new TextDecoder().decode(entries[0]!.bytes), repeatedText);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
});
