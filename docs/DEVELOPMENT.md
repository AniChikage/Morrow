# 开发指南

[文档首页](README.md) · [首次安装](GETTING-STARTED.md)

从仓库根目录执行：

```bash
npm ci
npm run dev:ui       # 浏览器预览，使用开发示例数据

# Electron 开发：为服务使用独立目录和空闲端口
MORROW_HOME="$(mktemp -d /tmp/morrow-dev.XXXXXX)" MORROW_PORT=43831 npm run dev

npm run typecheck
npm test
npm run test:ui
npm run build:app
```

不指定隔离目录时，`npm run dev` 会连接本机实际工作区。开发预览中的示例数据不代表真实执行结果。默认测试使用临时 SQLite、假 CLI、模拟原生后台与本地反馈/发布接收端；可选真实 Codex 二进制测试需单独启用。安装后的原生窗口、真实模型与实际线上反馈需要分别验收。

| 目录 | 用途 |
| --- | --- |
| `desktop/main/`、`desktop/preload/` | 桌面进程、服务连接与受限业务桥。 |
| `desktop/renderer/`、`desktop/shared/` | React 界面、视图状态与类型契约。 |
| `service/` | 调度、原生同步、持久化及项目工作机制。 |
| `tests/`、`scripts/` | 服务测试、运行时夹具、构建与安装。 |
| `docs/` | 产品方向、协议、研究提案与分版本验收记录。 |
| `Sources/Morrow/` | 旧 SwiftUI 客户端；默认产品为 Electron。 |

SwiftUI 可通过 `bash scripts/build-swiftui.sh` 单独构建为 `dist/Morrow-SwiftUI.app`，不覆盖 Electron 产物。

## 品牌资源

README、侧栏和 Mac App 使用同一份图稿。原始 PNG、轻量导出及生成记录见 [品牌资源](../assets/brand/README.md)。构建通过 `scripts/make-icon.swift` 生成所有 macOS 图标尺寸，再导出 `.icns`；无需图像生成服务参与日常构建。
