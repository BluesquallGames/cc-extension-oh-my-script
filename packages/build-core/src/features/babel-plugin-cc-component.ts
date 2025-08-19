import babel from '@babel/core';
import { basename } from 'node:path';
import { compressUuid } from '../utils/compress-uuid.js';

const templateImport = babel.template.smart(`
import { cclegacy as %%ccLegacy%% } from 'cc';
`);

const templatePush = babel.template.smart(`
%%ccLegacy%%._RF.push({}, %%uuid%%, %%filename%%, undefined);
`);

const templatePop = babel.template.smart(`
%%ccLegacy%%._RF.pop();
`);

export type UUIDProvider = (filename: string) => string | undefined;

export function transformCCComponent(options: {
  uuidProvider: UUIDProvider;
}): babel.PluginObj {
  const { uuidProvider } = options;
  return {
    name: 'cc-component',

    visitor: {
      Program: {
        enter(path) {
          const filename = this.filename;
          if (!filename) {
            return;
          }
          const uuid = uuidProvider(filename);
          if (!uuid) {
            return;
          }
          const ccLegacyId = path.scope.generateUidIdentifier('_ccLegacy');
          path.unshiftContainer('body', templatePush({
            ccLegacy: ccLegacyId,
            uuid: babel.types.stringLiteral(compressUuid(uuid, false)),
            filename: babel.types.stringLiteral(basename(filename)),
          }));
          path.unshiftContainer('body', templateImport({
            ccLegacy: ccLegacyId,
          }));
          path.pushContainer('body', templatePop({
            ccLegacy: ccLegacyId,
          }));
        },
      },
    },
  } satisfies babel.PluginObj<babel.PluginPass>;
}
