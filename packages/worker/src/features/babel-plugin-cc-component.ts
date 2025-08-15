import babel from '@babel/core';

const templateImport = babel.template.smart(`
import { cclegacy as %%ccLegacy%% } from 'cc';
`);

const templatePush = babel.template.smart(`
%%ccLegacy%%._RF.push(%%uuid%%);
`);

const templatePop = babel.template.smart(`
%%ccLegacy%%._RF.pop();
`);

export function transformCCComponent(options: {
  uuidMap: Record<string, string>;
}): babel.PluginObj {
  const { uuidMap } = options;
  return {
    name: 'cc-component',
    
    visitor: {
      Program: {
        enter(path) {
          const filename = this.filename;
          if (!filename) {
            return;
          }
          const uuid = uuidMap[filename];
          if (!uuid) {
            return;
          }
          const ccLegacyId = path.scope.generateUidIdentifier('_ccLegacy');
          path.unshiftContainer('body', templatePush({
            ccLegacy: ccLegacyId,
            uuid: babel.types.stringLiteral(uuid),
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