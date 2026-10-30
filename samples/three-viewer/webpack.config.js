import path from 'node:path';
import { fileURLToPath } from 'node:url';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export default {
  entry: './src/main.ts',
  output: {
    path: path.resolve(here, 'build'),
    clean: true,
  },
  devtool: 'source-map',
  resolve: {
    extensions: ['.ts', '.js'],
    // The WASM build (`cmake --build build-wasm`) writes spz.js, spz-helpers.js
    // and their typings to <repo>/dist; consume them in place instead of via npm.
    alias: { spz: path.join(repoRoot, 'dist') },
  },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  plugins: [new HtmlWebpackPlugin({ template: 'index.html' })],
  // spz.js embeds the WASM binary (SINGLE_FILE), so the bundle is large by design.
  performance: { hints: false },
  devServer: {
    // Serves the sample .spz files. Not watched: samples/ contains this package's
    // node_modules, which exhausts file watchers.
    static: { directory: path.join(repoRoot, 'samples'), publicPath: '/samples', watch: false },
  },
};
