# 运行与构建

这一页只关心日常使用时你会遇到什么：什么时候会构建、哪些文件会生成、什么时候需要手动操作。

## 什么时候会构建

启用扩展后，OMS 会在这些时机自动构建：

- 编辑器打开项目时。
- 项目脚本或扩展脚本发生变化时。
- `oms.config.*` 配置发生变化时。
- 项目内扩展启用或禁用时。

构建成功后，OMS 会刷新脚本入口，场景里的脚本会重新加载。你通常不需要手动运行构建命令。

## 你需要关心的生成文件

```text
assets/oms.ts
temp/oms
oms/uuids.json
```

`assets/oms.ts` 和 `temp/oms` 是生成物，建议忽略。

`oms/uuids.json` 保存组件脚本和 UUID 的映射。它影响场景、Prefab 等资源对脚本组件的引用，建议提交到版本控制。

## UUID 怎么处理

默认情况下，OMS 会把组件 UUID 集中记录在 `oms/uuids.json`。这样文件移动或路径变化时，脚本引用仍然可以保持稳定。

如果你希望 UUID 直接写在源码里，可以使用扩展菜单里的 Inline UUIDs。执行后，组件文件顶部会出现类似：

```text
/// <meta "uuid"="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
```

这适合需要把单个脚本文件拿到别的项目里复用，或者希望 UUID 跟着文件走的场景。

## 脚本入口约定

项目根目录的 `src` 默认会参与 OMS 构建。常用约定：

- `index-pre.ts`：优先执行的入口。
- `*.component.ts`：普通组件脚本。
- `*.component.editor.ts`：编辑器侧组件脚本。
- `index.ts`：普通入口。

如果你不需要控制执行顺序，只写 `index.ts` 和 `*.component.ts` 就够了。

## 扩展里的脚本

项目内扩展默认使用 `oms/src` 作为脚本目录。扩展也可以通过自己的 `oms.config.*` 调整目录、声明公开导出或配置 TypeScript 入口。

## 构建失败怎么办

常见排查顺序：

1. 看控制台里 OMS 输出的第一条报错。
2. 检查最近修改的 `oms.config.*` 是否有语法错误，默认导出是否是对象或返回对象的函数。
3. 检查 import 的包是否安装在当前项目或扩展里。
4. 如果是组件引用异常，检查 `oms/uuids.json` 是否被误删或发生冲突。

## 生产构建

项目构建时，OMS 会把脚本产物一起生成到构建目录里。通常你不需要直接引用 `temp/oms` 下的文件，也不应该把它们当作 public API。

OMS 会为生产构建重新读取 `production` mode 的项目与扩展配置，并建立独立的 production domain graph。Cocos Release（`debug: false`）输出会使用 esbuild 压缩，同时保留类名和函数名；Debug 输出不压缩。关闭、外部文件和 inline 三种 source-map 模式都会在压缩后保持有效。该规则同时适用于 Web 等 SystemJS 输出和 Headless ESM 输出。

组件 UUID 是项目级身份，不随构建 mode 分叉。production graph 会复用 development 已初始化的 UUID 映射，但只允许读取，不会生成、更新或写入 UUID。production 配置引入的组件如果尚未出现在项目 UUID 映射中，构建会失败；先让 OMS development discovery 收录该组件，或将它加入 `oms/uuids.json` 后再构建。

需要在测试、工具脚本或非场景环境复用逻辑时，可以开启 [Headless 模式](./headless-mode.md)。

## 什么时候需要手动操作

大多数时候不需要。只有这些情况可能需要手动操作：

- 刚打开项目，IDE 还没有识别 `oms://` 类型：等待 OMS 首次构建完成。
- 想把 UUID 写回源码：执行 Inline UUIDs。
- 修改了依赖安装状态但编辑器没有感知：重启扩展或重启编辑器。
