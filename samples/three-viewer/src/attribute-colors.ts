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

import type { BufferGeometry } from 'three';
import { createGaussianSplatGeometry } from 'three/addons/utils/GaussianSplatUtils.js';
import type { CustomAttribute } from './spz-to-three';

const RGB_CHANNELS = 3;
const RGBA_BYTES = 4;
const ALPHA_BYTE = 3;
const BYTE_MAX = 255;
// PCA and the color range are estimated from a sample; projecting still covers every point.
const SAMPLE_COUNT = 5_000;
const POWER_ITERATIONS = 25;
// Stretch each channel between these percentiles so a few extreme points don't flatten the rest.
const LOW_PERCENTILE = 0.01;
const HIGH_PERCENTILE = 0.99;

type Basis = Float64Array[];

function sampleIndices(count: number): number[] {
  const stride = Math.max(1, Math.floor(count / SAMPLE_COUNT));
  const indices: number[] = [];
  for (let i = 0; i < count; i += stride) {
    indices.push(i);
  }
  return indices;
}

function dot(values: Float32Array, offset: number, axis: Float64Array): number {
  let sum = 0;
  for (let d = 0; d < axis.length; d++) {
    sum += values[offset + d] * axis[d];
  }
  return sum;
}

function normalize(v: Float64Array): void {
  const length = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  for (let d = 0; d < v.length; d++) {
    v[d] /= length;
  }
}

// The leading principal axes of the sampled points, by power iteration with deflation.
// Works on the uncentered values plus a mean correction, so no centered copy is made.
function principalAxes(attr: CustomAttribute, samples: number[], axisCount: number): Basis {
  const { dim, values } = attr;
  const mean = new Float64Array(dim);
  for (const i of samples) {
    for (let d = 0; d < dim; d++) {
      mean[d] += values[i * dim + d] / samples.length;
    }
  }
  const axes: Basis = [];
  for (let a = 0; a < axisCount; a++) {
    let axis = new Float64Array(dim).map((_, d) => 1 + ((d * 7 + a * 13) % 5));
    normalize(axis);
    for (let it = 0; it < POWER_ITERATIONS; it++) {
      const next = new Float64Array(dim);
      const meanProjection = mean.reduce((s, m, d) => s + m * axis[d], 0);
      for (const i of samples) {
        const weight = dot(values, i * dim, axis) - meanProjection;
        for (let d = 0; d < dim; d++) {
          next[d] += weight * (values[i * dim + d] - mean[d]);
        }
      }
      for (const previous of axes) {
        const overlap = next.reduce((s, v, d) => s + v * previous[d], 0);
        for (let d = 0; d < dim; d++) {
          next[d] -= overlap * previous[d];
        }
      }
      normalize(next);
      axis = next;
    }
    axes.push(axis);
  }
  return axes;
}

// Attributes with up to three components map straight onto color channels; wider ones
// (embeddings) onto their top three principal components.
function colorBasis(attr: CustomAttribute, samples: number[]): Basis {
  if (attr.dim <= RGB_CHANNELS) {
    return Array.from({ length: attr.dim }, (_, a) => new Float64Array(attr.dim).map((_, d) => (d === a ? 1 : 0)));
  }
  return principalAxes(attr, samples, RGB_CHANNELS);
}

function percentileRange(attr: CustomAttribute, samples: number[], axis: Float64Array): [number, number] {
  const projected = samples.map((i) => dot(attr.values, i * attr.dim, axis)).sort((a, b) => a - b);
  const low = projected[Math.floor(LOW_PERCENTILE * (projected.length - 1))];
  const high = projected[Math.floor(HIGH_PERCENTILE * (projected.length - 1))];
  return [low, high > low ? high : low + 1];
}

/**
 * Builds RGBA splat colors that visualize a custom attribute: one component as grey,
 * two or three as RG/RGB, more as the top three principal components. Opacity is taken
 * from `baseColors`.
 *
 * Preconditions: `attr.values` holds `count * attr.dim` floats, and `baseColors` holds
 * `count` RGBA byte quadruples, where `count` is the splat count.
 */
export function attributeColors(attr: CustomAttribute, baseColors: ArrayLike<number>): Uint8ClampedArray {
  const count = attr.values.length / attr.dim;
  const samples = sampleIndices(count);
  const basis = colorBasis(attr, samples);
  const ranges = basis.map((axis) => percentileRange(attr, samples, axis));
  const colors = new Uint8ClampedArray(count * RGBA_BYTES);
  for (let i = 0; i < count; i++) {
    const o = i * RGBA_BYTES;
    for (let c = 0; c < RGB_CHANNELS; c++) {
      const a = basis.length === 1 ? 0 : c;
      if (a < basis.length) {
        const [low, high] = ranges[a];
        colors[o + c] = ((dot(attr.values, i * attr.dim, basis[a]) - low) / (high - low)) * BYTE_MAX;
      }
    }
    colors[o + ALPHA_BYTE] = baseColors[o + ALPHA_BYTE];
  }
  return colors;
}

/**
 * Returns a splat geometry sharing `base`'s centers and covariances but colored by
 * `attr`, without spherical harmonics so the colors don't shift with view angle.
 *
 * Preconditions: `base` comes from `decodeSpz`, and `attr` belongs to the same file.
 */
export function geometryColoredBy(base: BufferGeometry, attr: CustomAttribute): BufferGeometry {
  const centers = base.getAttribute('position').array as Float32Array;
  const covariances = base.getAttribute('covariance').array as Float32Array;
  const colors = attributeColors(attr, base.getAttribute('color').array);
  return createGaussianSplatGeometry(centers, covariances, colors);
}
