# spriteloom

A self-hosted workbench for sprite animation. Draw your frames in Procreate, then bring them here to line them up, time them, preview them on a light table, make small touch-ups, and export spritesheets for PixiJS or anything else.

Works in Safari on iPad (Apple Pencil and touch) and in desktop browsers. Projects are stored on the server, so the iPad and the desktop see the same work.

## What it does

- **Import** an Animated PNG or GIF straight from Procreate, a set of PNGs, a zip of PNGs, or an existing spritesheet you cut into a grid. Timing comes across from animated files, repeated frames become holds, and empty frames are skipped.
- **Align** frames on a light table with onion skins (blue for the frames before, red for after). Drag with a finger, pencil or mouse, nudge a pixel at a time, or use the arrow keys.
- **Time** each animation in ticks per second, with each cell held on ones, twos, threes and so on. Cells in the timeline are as wide as they are held. Loop, ping-pong or play once.
- **Touch up** a frame with a pressure-sensitive pencil, eraser and color picker. Once the Apple Pencil has been used, fingers pan instead of drawing. Pixel-art projects draw hard-edged pixels and show a pixel grid when zoomed in.
- **Export** a zip with any of:
  - a packed PixiJS atlas (`.png` + `.json`) with trimmed frames, the pivot as each frame's anchor, and named animations
  - a uniform grid sheet with one row per animation, plus a small JSON describing it
  - an animated GIF and/or animated PNG per animation
  - each cell as a numbered PNG

## Getting frames out of Procreate

1. With Animation Assist on, hide the background layer so frames keep their transparency.
2. Actions › Share › **Animated PNG**, at the frame rate you animated at.
3. Save to Files and import it into spriteloom. The frames arrive full-size and already registered, so alignment usually only needs touching where you want it.

## Using the export in PixiJS

```ts
import { Assets, AnimatedSprite } from 'pixi.js';

const sheet = await Assets.load('pixi/my-sprite.json');
const walk = new AnimatedSprite(sheet.animations['walk']);
walk.animationSpeed = 12 / 60; // the animation's fps / 60; holds are baked in as repeated frames
walk.play();
```

Each animation's fps, loop mode and per-cell holds are also in `meta.spriteloom.animations`, along with `pixiAnimationSpeed` and the cell size and pivot. For pixel art, set the texture source's `scaleMode` to `'nearest'` (also recorded as `meta.spriteloom.scaleMode`).

## Running it

### Docker

```sh
docker run -d --name spriteloom \
  -p 8740:8740 \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/therebelrobot/spriteloom:latest
```

Or use the included `compose.yaml`. Images are built for `linux/amd64` and `linux/arm64`, so a Raspberry Pi works.

Then open `http://<docker-host>:8740`. On iPad, Share › Add to Home Screen gives it its own full-screen window.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8740` | Port to listen on |
| `SPRITELOOM_DATA_DIR` | `/app/data` in Docker, `./data` otherwise | Where projects are stored |
| `SPRITELOOM_BASIC_AUTH` | unset | `username:password` to require HTTP basic auth. Leave unset if your reverse proxy already handles sign-in. `/healthz` stays open for health checks. |

There are no accounts. Anyone who can reach the server can edit every project, so keep it on your LAN or behind a reverse proxy with authentication. If you proxy it, raise the upload size limit (for example `client_max_body_size 64m;` in nginx); large Procreate canvases make large frames.

### Data layout

```
data/projects/<project-id>/project.json      # cells, timing, offsets, settings
data/projects/<project-id>/frames/<id>.png   # one PNG per frame
```

Plain files, so backing up is copying the folder. Saves carry a revision number: if the same project was changed on another device since you opened it, you'll be asked to reload instead of silently overwriting it.

## Developing

Requires the latest Node.

```sh
npm install
npm run dev        # rebuilds on change and restarts the server on :8740
npm run typecheck
npm test
npm run build      # bundles to dist/ with esbuild
npm start
```

The server and web app have no runtime dependencies: PNG, APNG, GIF and zip encoding/decoding are all in `src/web/formats`. Dev dependencies are TypeScript, esbuild, tsx and Node's types.

### Publishing

`npm run docker:build`, `docker:run` and `docker:push` work locally, but you shouldn't need them: `.github/workflows/publish.yml` builds the multi-arch image on every push to `main` and every `v*` tag and pushes it to GHCR using the built-in `GITHUB_TOKEN`, with provenance, an SBOM and a build attestation. Cut a release with `npm run release:patch` (or `minor` / `major`).

GHCR packages start private. After the first publish run, open the package settings on GitHub and change its visibility to public if you want to pull without signing in.

## License

[Unlicense](LICENSE): public domain.
