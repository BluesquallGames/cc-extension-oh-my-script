# 公开导出

公开导出让扩展对项目暴露稳定的 public API。用户不需要知道扩展安装在哪里，也不需要依赖扩展内部目录结构。

## 根导出

扩展声明：

```js
export default {
  exports: {
    '.': './exports/lib/runtime/index.js',
  },
};
```

用户使用：

```ts
import { TextField } from 'oms://text-field';
```

`'.'` 会生成包根 specifier。它对应 npm 包里的根入口体验。

## 子路径导出

扩展声明：

```js
export default {
  exports: {
    './editor': './exports/lib/editor/index.js',
    './runtime/mesh': './exports/lib/runtime/mesh.js',
  },
};
```

用户使用：

```ts
import { createTextFieldInspector } from 'oms://text-field/editor';
import { bakeTextMesh } from 'oms://text-field/runtime/mesh';
```

## 自定义公开包名

默认情况下，`oms://` 后面的包名等于扩展 ID。扩展可以通过 `exportPackageName` 指定更适合用户 import 的名字。

```js
export default {
  exportPackageName: 'text-field',
  exports: {
    '.': './exports/lib/runtime/index.js',
  },
};
```

这样即使扩展 ID 是 `cc-extension-text-field`，用户仍然可以写：

```ts
import { TextField } from 'oms://text-field';
```

## 运行时动态导入

启用 `globalImport` 的 OMS 运行环境会在脚本 reload 成功后把 `__oms_import__` 挂到 `globalThis` 上。目前 AssetDB 和 Scene 进程都会启用。需要动态加载公开入口时，可以使用：

```ts
const { TextField } = await globalThis.__oms_import__('oms://text-field');
```

普通源码里优先使用静态 import。动态导入更适合命令式加载、调试工具或必须等运行时条件确定后才加载的场景。

## 使用建议

用户代码应该只依赖 `oms://` specifier，不要直接 import 扩展内部文件路径。这样扩展可以调整自己的目录结构，项目侧 import 仍然保持稳定。
