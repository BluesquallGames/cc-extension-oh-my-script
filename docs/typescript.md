# TypeScript 类型

OMS 会为公开导出生成类型代理，让 IDE 和 `tsc` 能识别 `oms://` import。

## 引用生成类型

在项目 `tsconfig.json` 中加入：

```json
{
  "compilerOptions": {
    "types": ["./temp/oms/typing"]
  }
}
```

如果开启了 headless 输出，对应类型目录是 `temp/oms/typing-headless`。

## OMS 会生成什么

假设扩展配置：

```js
export default {
  exportPackageName: 'text-field',
  exports: {
    '.': './exports/lib/runtime/index.js',
    './editor': './exports/lib/editor/index.js',
  },
};
```

OMS 会为用户可见的 `oms://` 入口生成声明：

```ts
declare module "oms://text-field" {
  export * from "@oms-exports/text-field";
}

declare module "oms://text-field/editor" {
  export * from "@oms-exports/text-field__editor";
}
```

你不需要手写这些声明。只要扩展导出入口本身有正确的 `.d.ts`，IDE 就能从 `oms://` import 继续推导出导出的符号。

## 为什么只配置 types

早期方案可以用 `compilerOptions.paths` 映射 `oms://`，但这会把用户项目的 tsconfig 变复杂，也容易和 pnpm、workspace link、扩展挂载路径发生冲突。

现在用户只需要在 `types` 里引用 OMS 生成目录。`oms://` 的类型声明由 OMS 自动维护。

## 常见问题

### 找不到 oms:// 模块声明

确认 `tsconfig.json` 已经引用：

```json
{
  "compilerOptions": {
    "types": ["./temp/oms/typing"]
  }
}
```

然后确认 OMS 已经至少完成一次构建。

### 模块存在但没有导出符号

优先检查扩展导出入口自己的 `.d.ts` 是否能表达正确导出。例如入口 JS 是：

```js
export * from '@cyclonium/text-field';
```

对应类型入口也应能让 TypeScript 解析到 `@cyclonium/text-field`。如果扩展是通过 symlink 或 pnpm virtual store 挂载，OMS 生成的代理应指向真实入口路径，而不是项目里的展示路径。
