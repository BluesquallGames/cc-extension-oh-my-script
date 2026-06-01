# 模块解析

OMS 的 import 写法更接近普通 TypeScript/npm 项目。项目脚本可以 import 本地文件、npm 包、别名路径，也可以 import 扩展暴露出来的 `oms://` 模块。

## 相对路径

普通相对路径照常使用：

```ts
import { clamp01 } from './math/clamp';
import { createEnemy } from '../battle/enemy';
```

## npm 包

可以直接 import 项目依赖：

```ts
import { nanoid } from 'nanoid';
```

依赖应安装在项目或扩展能解析到的位置。OMS 会按 Node/npm 的模块解析习惯查找包。

## pnpm 和 workspace

OMS 支持 pnpm workspace、软链接、junction 和包管理器生成的真实安装路径。对用户来说，不需要把依赖复制到 `assets` 里，也不需要为了 Creator 的脚本系统调整包目录。

如果扩展公开导出依赖了自己的传递依赖，OMS 生成的类型也会尽量保持在真实包上下文中解析，避免因为展示路径不同导致 IDE 看不到导出符号。

## alias

项目可以在根目录 `oms.config.*` 中配置 alias：

```js
export default {
  resolve: {
    alias: {
      '@game': './src',
      '@shared': './shared',
    },
  },
};
```

使用：

```ts
import { createActor } from '@game/actor';
```

## oms:// 模块

项目内扩展可以声明公开入口：

```js
export default {
  exportPackageName: 'text-field',
  exports: {
    '.': './exports/lib/runtime/index.js',
    './editor': './exports/lib/editor/index.js',
  },
};
```

项目代码使用：

```ts
import { TextField } from 'oms://text-field';
import { createTextFieldInspector } from 'oms://text-field/editor';
```

`oms://` 适合扩展对项目暴露稳定 API。用户代码不应该直接 import 扩展内部文件路径。

## 编辑器环境里的包

少数包在预览环境和编辑器环境来源不同，可以通过 `resolve.maybeExternals` 声明：

```js
export default {
  resolve: {
    maybeExternals: ['some-editor-package'],
  },
};
```

普通项目通常不需要配置它。
