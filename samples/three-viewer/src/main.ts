/*
MIT License

Copyright (c) 2026 Niantic Spatial

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import {
  BufferGeometry,
  ColorManagement,
  MathUtils,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Sphere,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import createSpzModule from 'spz/spz.js';
import { decodeSpzToSplatGeometry } from './spz-to-three';

const DEFAULT_FILE = 'samples/racoonfamily.spz';
const FIELD_OF_VIEW_DEG = 60;
const NEAR_PLANE = 0.01;
const FAR_PLANE = 1000;
// Captures carry a few far-flung background splats that dominate the bounding sphere
// (racoonfamily: radius ~274 around a subject ~1.5 across), so both framing and sorting
// work from the dense core: the median center, sized to hold a fraction of the splats.
const CORE_SAMPLE_COUNT = 10_000;
const FRAMING_CORE_FRACTION = 0.8;
// GaussianSplat quantizes depth into 4096 bins spread over its bounding sphere, and
// splats sharing a bin draw in arbitrary order that changes on each re-sort, which
// shows as popping. Sizing the sphere to the core concentrates the bins on the subject;
// splats outside it clamp into the nearest/farthest bin. 0.9 rather than higher because
// some captures (hornedlizard) put ~5% of splats in a background shell ~200 units out.
const SORT_CORE_FRACTION = 0.9;

// Splat colors are authored and blended in sRGB. With three's default linear working
// space the output pass re-encodes them as if linear, washing the scene out.
// Matches three's webgpu_gaussian_splat example.
ColorManagement.workingColorSpace = SRGBColorSpace;

const status = document.getElementById('status')!;
const picker = document.getElementById('file') as HTMLInputElement;

const renderer = new WebGPURenderer();
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new PerspectiveCamera(FIELD_OF_VIEW_DEG, innerWidth / innerHeight, NEAR_PLANE, FAR_PLANE);
const controls = new OrbitControls(camera, renderer.domElement);
const spzModule = createSpzModule();
let current: GaussianSplat | undefined;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function median(values: number[]): number {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

interface SplatCore {
  center: Vector3;
  sortedDistances: number[];
}

function sampleCore(geometry: BufferGeometry): SplatCore {
  const positions = geometry.getAttribute('position');
  const stride = Math.max(1, Math.floor(positions.count / CORE_SAMPLE_COUNT));
  const samples: Vector3[] = [];
  for (let i = 0; i < positions.count; i += stride) {
    samples.push(new Vector3().fromBufferAttribute(positions, i));
  }
  const center = new Vector3(
    median(samples.map((p) => p.x)),
    median(samples.map((p) => p.y)),
    median(samples.map((p) => p.z)),
  );
  const sortedDistances = samples.map((p) => p.distanceTo(center)).sort((a, b) => a - b);
  return { center, sortedDistances };
}

function coreRadius(core: SplatCore, fraction: number): number {
  const index = Math.min(core.sortedDistances.length - 1, Math.floor(core.sortedDistances.length * fraction));
  return core.sortedDistances[index];
}

function frame(core: SplatCore): void {
  const halfFov = MathUtils.degToRad(camera.fov / 2);
  controls.target.copy(core.center);
  camera.position.copy(core.center).setZ(core.center.z + coreRadius(core, FRAMING_CORE_FRACTION) / Math.tan(halfFov));
  controls.update();
}

function focusSort(splat: GaussianSplat, core: SplatCore): void {
  splat.boundingSphere = new Sphere(core.center.clone(), coreRadius(core, SORT_CORE_FRACTION));
  // The same sphere drives whole-object frustum culling; once it no longer encloses the
  // background, culling could hide everything while only background is in view.
  splat.frustumCulled = false;
}

const elapsed = (since: number): number => Math.round(performance.now() - since);

async function show(name: string, bytes: Uint8Array): Promise<void> {
  status.textContent = `Decoding ${name}…`;
  let start = performance.now();
  const geometry = await decodeSpzToSplatGeometry(await spzModule, bytes);
  const decodeMs = elapsed(start);

  if (current) {
    scene.remove(current);
    current.splatGeometry.dispose();
  }
  const splat = new GaussianSplat(geometry);
  const core = sampleCore(geometry);
  focusSort(splat, core);
  frame(core);

  // Build the GPU pipelines before the splat is visible, so the first frames don't stall on them.
  status.textContent = `Compiling shaders for ${name}…`;
  start = performance.now();
  await renderer.compileAsync(splat, camera, scene);
  const compileMs = elapsed(start);
  scene.add(splat);
  current = splat;

  const splats = geometry.getAttribute('position').count.toLocaleString();
  status.textContent = `${name}: ${splats} splats · decode ${decodeMs} ms · compile ${compileMs} ms`;
  console.info(status.textContent);
}

async function showUrl(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetching ${url} failed: ${response.status} ${response.statusText}`);
  }
  await show(url, new Uint8Array(await response.arrayBuffer()));
}

function reportError(error: unknown): void {
  status.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
}

picker.addEventListener('change', () => {
  const file = picker.files?.[0];
  if (file) {
    file.arrayBuffer().then((buffer) => show(file.name, new Uint8Array(buffer))).catch(reportError);
  }
});

async function main(): Promise<void> {
  await renderer.init();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  await showUrl(DEFAULT_FILE);
}

main().catch(reportError);
