import { describe, expect, it } from 'vitest';
import { CCEnvParams, generateCCEnvModuleSource } from '../../src/features/generate-cc-env.js';
import * as diff from 'diff';

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
  'nodejs',
];

const modes = [
  'editor-not-in-preview',
  'build',
  'preview',
  'test',
];

const empty = generateCCEnvModuleSource({ params: {} });

const generateAndDiff = (params: CCEnvParams, title: string) => {
  const result = generateCCEnvModuleSource({
    params,
  });
  const diffLines = diff.createTwoFilesPatch('empty', title, empty, result, undefined, undefined, {
    context: 0,
  });
  return diffLines;
};

it('empty', () => {
  expect(empty).toMatchSnapshot();
});

describe('platform', () => {
  for (const v of platforms) {
    it(`${v}`, () => {
      expect(generateAndDiff({ platform: v }, `platform=${v}`)).toMatchSnapshot();
    });
  }
});

describe('mode', () => {
  for (const v of modes) {
    it(`${v}`, () => {
      expect(generateAndDiff({ mode: v }, `mode=${v}`)).toMatchSnapshot();
    });
  }
});

describe('debug', () => {
  for (const v of [true, false]) {
    it(`${v}`, () => {
      expect(generateAndDiff({ debug: v }, `debug=${v}`)).toMatchSnapshot();
    });
  }
});

describe('headless', () => {
  for (const v of [true, false]) {
    it(`${v}`, () => {
      expect(generateAndDiff({ headless: v }, `headless=${v}`)).toMatchSnapshot();
    });
  }
});
