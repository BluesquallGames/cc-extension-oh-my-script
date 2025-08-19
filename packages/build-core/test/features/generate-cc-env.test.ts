import { expect, it } from 'vitest';
import { generateCCEnvModuleSource } from '../../src/features/generate-cc-env.js';

const platforms = [
  'non-existing',
  'alipay',
  'android',
  'bytedance',
  'cocos-runtime',
  'editor',
  'honor',
  'huawei',
  'ios',
  'linux',
  'mac',
  'migu',
  'ohos',
  'ohos',
  'open-harmony',
  'openharmony',
  'oppo',
  'taobao-minigame',
  'taobao',
  'vivo',
  'wechat-mini-program',
  'wechat',
  'windows',
  'xiaomi',
];

const modes = [
  'editor-not-in-preview',
  'build',
  'preview',
  'test',
];

const debug = [
  true,
  false,
];

for (const [k, values] of [
  ['platform', platforms],
  ['mode', modes],
  ['debug', debug],
] as const) {
  for (const v of values) {
    it(`${k}: ${v}`, () => {
      expect(generateCCEnvModuleSource({
        params: {
          [k]: v,
        },
      })).toMatchSnapshot();
    });
  }
}
