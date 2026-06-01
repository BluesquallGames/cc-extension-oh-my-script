# 从 Cocos Creator 脚本系统迁移

OMS 不是要求你一次性改掉所有 Creator 脚本。更推荐的方式是：先把新功能写在 OMS 里，再逐步把适合迁移的脚本搬过来。

## 迁移前后有什么变化

在 Cocos Creator 内置脚本系统里，脚本通常跟随 `assets` 目录和资源导入流程管理。脚本组件的可用性、UUID、导入关系都跟资源数据库绑定得比较紧。

迁移到 OMS 后：

- 项目脚本默认放在项目根目录的 `src`。
- 组件脚本用 `*.component.ts` 或 `*.component.js` 命名。
- UUID 由 OMS 维护在 `oms/uuids.json`，也可以写回到源码顶部。
- 普通模块可以按 npm/TypeScript 项目的习惯组织和 import。
- 生成文件放在 `temp/oms` 和 `assets/oms.ts`，不需要手写维护。

## 推荐迁移顺序

1. 先启用 OMS，并确认 `assets/oms.ts` 能正常生成。
2. 新建一个简单的 `src/index.ts`，验证脚本能随编辑器刷新。
3. 迁移一个低风险组件到 `src/xxx.component.ts`。
4. 打开场景或 Prefab，确认组件能挂载和保存。
5. 把共享逻辑拆成普通模块，由组件脚本 import。
6. 再逐步迁移更多组件。

## 组件脚本迁移示例

原来的 Creator 脚本：

```ts
import { _decorator, Component } from 'cc';

const { ccclass } = _decorator;

@ccclass('PlayerController')
export class PlayerController extends Component {
  start() {
    // ...
  }
}
```

迁移后放到：

```text
src/player-controller.component.ts
```

代码本身通常不需要改。关键是文件名带上 `.component`，让 OMS 知道它是组件脚本。

## 哪些文件要提交

建议提交：

```text
src
oms/uuids.json
oms.config.*
```

建议忽略：

```text
assets/oms.ts
temp/oms
```

## 常见注意点

- 不要手动编辑 `assets/oms.ts`，它是生成入口。
- 不要手动改 `temp/oms` 下的内容。
- 如果组件引用丢失，优先检查 `oms/uuids.json` 是否被误删。
- 如果改了依赖安装状态，编辑器没有感知时可以重启 OMS 扩展或重启编辑器。
