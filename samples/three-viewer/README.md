# SPZ three.js viewer

A minimal web page that decodes `.spz` files with the spz reference library (WASM)
and renders them with three.js's built-in `GaussianSplat` (three r186+).

The only spz-specific code is [`src/spz-to-three.ts`](src/spz-to-three.ts): it streams
the decoded attributes from `loadSpzStreamingAsync` straight into the packed arrays
`createGaussianSplatGeometry` expects (linear scales + rotation → covariance,
logit alpha → byte opacity, SH DC → RGB, SH bands 1–3 → three's byte encoding).

## Run

1. Build the WASM module from the repo root, with extensions on so files that use
   `SPZ_ADOBE_coordinate_system` are converted correctly:

   ```
   emcmake cmake -B build-wasm -DSPZ_BUILD_EXTENSIONS=ON .
   cmake --build build-wasm --target spz-wasm
   ```

   This writes `spz.js`, `spz-helpers.js` and their typings to `<repo>/dist`, which
   webpack and TypeScript resolve as `spz/*`.

2. Install and start the dev server:

   ```
   cd samples/three-viewer
   npm install
   npm start
   ```

   Open http://localhost:8080. It loads `samples/racoonfamily.spz`; use the file picker
   to open other `.spz` files. `WebGPURenderer` falls back to WebGL2 where WebGPU is
   unavailable.

`npm run build` writes a static bundle to `build/`; serve it next to a `samples/`
directory containing `racoonfamily.spz`.

## Depth sorting

`GaussianSplat` sorts splats into 4096 depth bins spread over its bounding sphere; splats
sharing a bin draw in arbitrary order, which on WebGPU changes with each re-sort and shows
as popping while orbiting. Captures often include a few far-away background splats
(racoonfamily: a ~274-unit bounding sphere around a subject ~1.5 units across), which
leaves the subject only a couple dozen bins. The viewer replaces the sort sphere with one
around the median center holding 90% of the splats, and disables whole-object
frustum culling since that sphere no longer encloses everything.

## Differences from three's `SPZLoader`

On files without extensions both decoders produce the same geometry: positions, colors and
SH bytes match exactly, and covariances match up to float rounding. three's loader skips SPZ
v4 extensions, so a file stored in a non-default coordinate system (for example RDF via
`SPZ_ADOBE_coordinate_system`) loads with flipped axes there, while spz converts it to
three's RUB frame.

SH degree 4 is not rendered: `GaussianSplat` evaluates bands 1–3 only.
