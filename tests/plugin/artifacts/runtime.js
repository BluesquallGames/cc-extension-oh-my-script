import { defineConfig } from '@oms/plugin';
import * as api from '@oms/plugin';
import assert from 'node:assert/strict';

assert.deepEqual(Object.keys(api), ['defineConfig']);
const config = {
  plugins: [{
    name: 'test:runtime',
    load(id) {
      return id;
    },
  }],
};
assert.equal(defineConfig(config), config);
const factory = async ({ mode }) => ({
  ...config,
  mode,
});
assert.equal(defineConfig(factory), factory);
assert.deepEqual(await defineConfig(factory)({ mode: 'production' }), {
  ...config,
  mode: 'production',
});
