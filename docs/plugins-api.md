# OMS 插件 API

OMS 开放 [Vite 插件 API](https://v6.vite.dev/guide/api-plugin) 的源码加载子集。插件保留标准签名和返回值，由 Rollup 调度；OMS 将编译依赖接到现有文件监听与整体重载链路。

## 模块入口

`@oms/plugin` 是 ESM 模块，根入口提供 `defineConfig` 和 `.d.ts`。`defineConfig` 原样返回项目配置。插件使用 `OmsPlugin` 和 `OmsPluginContext` 类型，不需要运行时 helper。

```ts
import { readFileSync } from 'node:fs';
import type { OmsPlugin } from '@oms/plugin';

export function text(): OmsPlugin {
  return {
    name: 'example:text',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('.text')) return;
      this.addWatchFile(id);
      return {
        code: `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`,
        map: null,
      };
    },
  };
}
```

```js
import { defineConfig } from '@oms/plugin';
import { text } from './plugins/text.js';

export default defineConfig({
  plugins: [text()],
});
```

配置 loader 继续支持现有 JS/CJS/MJS 文件和同步、异步配置函数。`OmsUserConfig` 为既有项目配置提供类型；profiles、alias、projectPeers、define 等属于宿主配置，插件不读取或修改配置视图。

## 公开接口

| 接口 | 行为 |
| --- | --- |
| `name` | 非空插件名称 |
| `enforce: 'pre'` | 在 alias 之后、宿主解析及转换之前运行；省略时处于普通插件组 |
| `buildStart(options)` | 每次 Rollup 构建开始，可初始化编译缓存 |
| `resolveId(source, importer, options)` | 决定模块身份，或委托原生解析 |
| `load(id, options?)` | 提供源码编译结果或内存派生模块 |
| `this.resolve` | Rollup 原生模块解析，保留参数和解析结果 |
| `this.addWatchFile` | 登记编译读取的原始文件、类型信息或资源元数据 |
| `this.error` | 报告原生 Rollup 编译错误，支持原始文件和位置 |
| `this.cache.get/set` | 原生插件缓存，default/headless 各自维护 |

三个 hooks 只支持函数形式，可以异步返回。未支持的插件字段、`post` 和对象形式 hooks 会报告配置错误。没有配置 hooks、transform、watchChange 或插件清理 hooks；根入口也不提供 definePlugin、dev/HMR/client 子入口。

插件顺序为 alias、用户 `pre` 插件、内置解析与转换插件、普通用户插件、define 转换。同组用户插件保留配置数组中的顺序；`pre` 插件可优先处理 domain、Node builtin、project-peer 等模块标识。

插件通过标准 resolveId/load 提供 `\0` 虚拟模块。派生模块内的相对导入应以原始文件为 importer 委托 `this.resolve(source, originalFile, options)`；宿主不添加自定义解析字段。解析结果直接交给 Rollup，保留原生 skipSelf、custom 和 attributes 语义。

## 编译依赖

读取 JS import 图之外的文件前，用 `this.addWatchFile(file)` 登记绝对路径。虚拟模块也应登记它读取的原始文件。依赖新增、修改、删除会触发重编译，即使源文件文本未变；失败编译保留已登记依赖，文件修复后可自动恢复。插件无需 watchChange。

源码和派生模块可全部由 load 提供，无需将中间 JS 写入项目。自定义格式插件应返回 JavaScript；OMS 对加载后的代码统一执行目标语法转换，包括自定义后缀和 `\0` 虚拟模块。标准 TS 模块仍执行既有类型移除流程。引擎、domain、editor-only 导入检查及既有宿主构建流程继续执行。addWatchFile 只登记编译依赖，不负责引擎资源导入或生产资源入包。

成功构建使用 Rollup 的 `bundle.watchFiles` 替换当前 profile 的依赖快照；失败构建将 `error.watchFiles` 合并到已有快照，以便修复后恢复。所有 profile 都不再引用的被动依赖会取消监听。文件订阅沿用原有 watcher，保留读取文件到订阅生效之间的时机窗口；缺失文件的恢复以父目录已存在为前提。

## 资源 UUID 模块

OMS 提供内置的 `?uuid` 导入，普通源码和插件生成的模块均可使用：

```ts
import uuid from '../assets/images/icon.png?uuid';
```

路径可以是绝对路径、相对 importer 的路径或通过已有模块解析器解析的 specifier（包括 alias）。初期只接受项目 `assets` 目录内的文件；资源文件与同路径的 `.meta` 必须存在。未指定属性时，模块默认导出 metadata 的根 UUID，不输出资源内容。

静态导入或重新导出可以通过 import attribute 选择导入器产物：

```ts
import frameUuid from '../assets/images/icon.png?uuid' with {
  importer: 'sprite-frame',
};
import textureUuid from '../assets/images/icon.png?uuid' with {
  importer: 'texture',
};
```

`importer` 必须是非空字符串。OMS 按该标识严格匹配 metadata 根节点和递归 `subMetas` 中的资源；恰好匹配一个时，导出该项自身的非空字符串 `uuid`。零个或多个匹配都会报错，不选择第一个、不拼接 UUID 后缀。同一文件的不同 importer 是独立模块；导入器标识不限制为图片类型。

保留 `?uuid` 以便 TypeScript 6 消费项目通过 `declare module '*?uuid'` 声明默认导出为 `string`；该版本尚不支持根据 import attributes 区分模块声明。消费项目的 `module` 配置需支持 import attributes，例如 `preserve`、`esnext` 或 `nodenext`。非法路径、缺失文件及无效 metadata 会使构建失败。

OMS 登记资源文件与 `.meta` 的依赖，负责修改重建及缺失文件的恢复。插件只需生成 `?uuid` 导入；虚拟模块的相对导入仍应通过 `this.resolve(source, originalFile, options)` 转发。该功能属于 OMS 内置模块加载行为，不增加公开插件 hooks；UUID 引用也不负责生产资源入包。

## 验证

公开插件类型可赋给仓库实际使用的 Vite Plugin 类型；源码加载插件在真实 OMS 开发、生产和 Vite 构建中验证。独立类型消费检查覆盖 Node16、NodeNext、Bundler、JS 编辑器提示和 CommonJS 类型导入。

```sh
# packages/plugin
node --run build
# 仓库根目录
node tests/plugin/check-types.js
node tests/plugin/check-compatibility.js
# packages/build-core
node --run test
```
