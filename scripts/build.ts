// Bundles the server and the web app with esbuild and copies static assets.
// `--watch` rebuilds on change and restarts the server.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';

const isWatchMode = process.argv.includes('--watch');
const outputDirectory = 'dist';

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(`${outputDirectory}/web`, { recursive: true });
await cp('static', `${outputDirectory}/web`, { recursive: true });

const serverBuildOptions: esbuild.BuildOptions = {
  entryPoints: ['src/server/main.ts'],
  outfile: `${outputDirectory}/server.js`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
};

const webBuildOptions: esbuild.BuildOptions = {
  entryPoints: ['src/web/main.ts'],
  outfile: `${outputDirectory}/web/app.js`,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  // iPadOS 16.4 is the floor: CompressionStream, structuredClone and dialog all exist there.
  target: ['safari16.4', 'chrome120', 'firefox120'],
  sourcemap: true,
  minify: !isWatchMode,
  logLevel: 'info',
};

if (!isWatchMode) {
  await Promise.all([esbuild.build(serverBuildOptions), esbuild.build(webBuildOptions)]);
} else {
  let runningServer: ChildProcess | null = null;
  const restartServer = (): void => {
    runningServer?.kill();
    runningServer = spawn(process.execPath, ['--enable-source-maps', `${outputDirectory}/server.js`], {
      stdio: 'inherit',
      env: { ...process.env, SPRITELOOM_STATIC_DIR: `${outputDirectory}/web` },
    });
  };
  const serverContext = await esbuild.context({
    ...serverBuildOptions,
    plugins: [{ name: 'restart-server', setup: (build) => build.onEnd((result) => { if (result.errors.length === 0) restartServer(); }) }],
  });
  const webContext = await esbuild.context(webBuildOptions);
  await Promise.all([serverContext.watch(), webContext.watch()]);
  console.log('Watching for changes. Static files in ./static are copied once; restart dev to pick up edits there.');
}
