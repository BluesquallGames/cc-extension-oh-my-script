# 组件脚本

组件脚本是 OMS 对 Cocos `Component` 的文件级约定。只要文件名包含 `.component`，OMS 就会把它当作组件脚本处理。

## 命名规则

普通组件：

```text
src/player.component.ts
src/camera-follow.component.js
```

编辑器侧组件：

```text
src/inspector-helper.component.editor.ts
```

支持的扩展名与普通脚本一致：`.ts`、`.js`、`.mts`、`.mjs`、`.cts`、`.cjs`。

## 写法

组件类仍然按 Cocos Creator 的方式写：

```ts
import { _decorator, Component } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('PlayerController')
export class PlayerController extends Component {
  @property
  speed = 1;

  update(dt: number) {
    void dt;
  }
}
```

你不需要在某个入口文件里手动 import 这个组件。OMS 会按 `.component` 文件名自动纳入。

## UUID

每个组件脚本都需要稳定 UUID，场景和 Prefab 才能长期引用它。

OMS 默认把 UUID 记录在：

```text
oms/uuids.json
```

这个文件建议提交。

如果你想把 UUID 直接写进源码，可以执行 Inline UUIDs。写回后文件顶部会出现：

```text
/// <meta "uuid"="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"/>
```

## 什么时候用组件脚本

适合：

- 需要挂到 Node 上的行为组件。
- 需要被场景或 Prefab 引用的类。
- 需要 Cocos Creator 识别为组件类型的脚本。

不适合：

- 纯工具函数。
- 纯数据结构。
- 只被其他模块 import 的业务逻辑。

这些代码放普通模块即可。
