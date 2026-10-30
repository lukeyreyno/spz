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
import {
  SH_BAND_COMPONENTS,
  SH_BAND_WORDS,
  createGaussianSplatGeometry,
  createPackedSphericalHarmonicsBand,
  sigmoid,
  writeColorBytesFromSH0,
  writeCovariance,
  type GaussianSplatSphericalHarmonics,
  type PackedSphericalHarmonicsBand,
} from 'three/addons/utils/GaussianSplatUtils.js';
import type { SpzModule, SpzStreamHeader } from 'spz/spz.js';
import { SplatAttribute, loadSpzStreamingAsync } from 'spz/spz-helpers.js';

// three's GaussianSplat evaluates SH bands 1..3; SPZ can carry band 4, which is dropped.
const MAX_RENDERED_SH_DEGREE = 3;
const BYTE_MAX = 255;
// three decodes SH bytes as (byte - 128) / 128, the same quantization SPZ uses on disk.
const SH_BYTE_ZERO = 128;
const SH_BYTE_SCALE = 128;

const POSITION_FLOATS = 3;
const SCALE_FLOATS = 3;
const ROTATION_FLOATS = 4;
const COLOR_FLOATS = 3;
const COVARIANCE_FLOATS = 6;
const RGBA_BYTES = 4;
const ALPHA_BYTE = 3;
const SH_CHANNELS = 3;
// Coefficients per point for SH degrees 0..4, excluding the DC term.
const SH_COEFFS_BY_DEGREE = [0, 3, 8, 15, 24];

interface SplatArrays {
  centers: Float32Array;
  covariances: Float32Array;
  colors: Uint8ClampedArray;
  shBands: PackedSphericalHarmonicsBand[];
  shFloatsPerPoint: number;
}

function allocate(header: SpzStreamHeader): SplatArrays {
  const n = header.numPoints;
  const renderedDegree = Math.min(header.shDegree, MAX_RENDERED_SH_DEGREE);
  const shBands: PackedSphericalHarmonicsBand[] = [];
  for (let band = 1; band <= renderedDegree; band++) {
    shBands.push(createPackedSphericalHarmonicsBand(n, band));
  }
  return {
    centers: new Float32Array(n * POSITION_FLOATS),
    covariances: new Float32Array(n * COVARIANCE_FLOATS),
    colors: new Uint8ClampedArray(n * RGBA_BYTES),
    shBands,
    shFloatsPerPoint: SH_COEFFS_BY_DEGREE[header.shDegree] * SH_CHANNELS,
  };
}

function writeSh(out: SplatArrays, first: number, data: Float32Array): void {
  const count = data.length / out.shFloatsPerPoint;
  for (let p = 0; p < count; p++) {
    let src = p * out.shFloatsPerPoint;
    for (let b = 0; b < out.shBands.length; b++) {
      const band = b + 1;
      const components = SH_BAND_COMPONENTS[band];
      const dst = (first + p) * SH_BAND_WORDS[band] * RGBA_BYTES;
      for (let c = 0; c < components; c++) {
        out.shBands[b].bytes[dst + c] = Math.round(data[src++] * SH_BYTE_SCALE + SH_BYTE_ZERO);
      }
    }
  }
}

// The streaming decoder emits attributes in a fixed order (positions, alphas,
// colors, scales, rotations, sh — see spz::kAllSplatAttributes). This relies on
// that: alpha lands in the RGBA bytes before RGB, and linear scales are parked in
// the covariance slots until the matching rotation chunk turns them into a covariance.
function writeChunk(out: SplatArrays, attr: SplatAttribute, first: number, data: Float32Array): void {
  switch (attr) {
    case SplatAttribute.Positions:
      out.centers.set(data, first * POSITION_FLOATS);
      return;
    case SplatAttribute.Alphas:
      for (let p = 0; p < data.length; p++) {
        out.colors[(first + p) * RGBA_BYTES + ALPHA_BYTE] = sigmoid(data[p]) * BYTE_MAX;
      }
      return;
    case SplatAttribute.Colors:
      for (let p = 0; p < data.length / COLOR_FLOATS; p++) {
        const i = p * COLOR_FLOATS;
        const o = (first + p) * RGBA_BYTES;
        const alpha = out.colors[o + ALPHA_BYTE] / BYTE_MAX;
        writeColorBytesFromSH0(out.colors, o, data[i], data[i + 1], data[i + 2], alpha);
      }
      return;
    case SplatAttribute.Scales:
      for (let p = 0; p < data.length / SCALE_FLOATS; p++) {
        const i = p * SCALE_FLOATS;
        const o = (first + p) * COVARIANCE_FLOATS;
        out.covariances[o] = Math.exp(data[i]);
        out.covariances[o + 1] = Math.exp(data[i + 1]);
        out.covariances[o + 2] = Math.exp(data[i + 2]);
      }
      return;
    case SplatAttribute.Rotations:
      for (let p = 0; p < data.length / ROTATION_FLOATS; p++) {
        const i = p * ROTATION_FLOATS;
        const o = (first + p) * COVARIANCE_FLOATS;
        const cov = out.covariances;
        writeCovariance(cov, o, cov[o], cov[o + 1], cov[o + 2], data[i], data[i + 1], data[i + 2], data[i + 3]);
      }
      return;
    case SplatAttribute.Sh:
      writeSh(out, first, data);
      return;
  }
}

/**
 * Decodes an SPZ file with the spz reference library and builds a geometry for
 * three's `GaussianSplat`, in three's RUB coordinate frame.
 *
 * Preconditions: `spz` is an initialized module from `createSpzModule()`, and
 * `bytes` holds a complete `.spz` file. Rejects with the decoder's message if the
 * file is malformed or empty.
 */
export async function decodeSpzToSplatGeometry(spz: SpzModule, bytes: Uint8Array): Promise<BufferGeometry> {
  let out: SplatArrays | undefined;
  const header = await loadSpzStreamingAsync(
    spz,
    bytes,
    { to: spz.CoordinateSystem.RUB },
    (attr, first, data) => {
      if (!out) {
        throw new Error('SPZ decoder emitted data before its header');
      }
      writeChunk(out, attr, first, data);
    },
    (info) => {
      out = allocate(info);
    },
  );
  if (!out || header.numPoints === 0) {
    throw new Error('SPZ file contains no gaussians');
  }
  const sh: GaussianSplatSphericalHarmonics = {};
  out.shBands.forEach((band, b) => {
    sh[`sh${b + 1}` as 'sh1' | 'sh2' | 'sh3'] = band.packed;
  });
  return createGaussianSplatGeometry(out.centers, out.covariances, out.colors, sh);
}
