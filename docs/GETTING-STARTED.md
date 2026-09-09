# 开始使用 Morrow

[文档首页](README.md)

## 从源码安装

需要 macOS 14+、Node.js 24+、npm 和 Xcode Command Line Tools。使用 Codex 时，还需安装并登录 Codex Mac App；Morrow 不要求另填模型 API Key。

```bash
git clone https://github.com/AniChikage/Morrow.git
cd Morrow
npm ci
npm run build:app
bash scripts/install-app.sh
open "$HOME/Applications/Morrow.app"
```

构建输出为 `dist/Morrow.app`，安装默认写入 `~/Applications/Morrow.app`。安装器先复制并校验完整签名，再替换应用；回退副本只在安装期间保留，成功后清理。也可给安装脚本传入其他目标目录。构建会准备并校验 Node 24 运行时，安装后的 App 自带该运行时。当前产物使用本机 ad-hoc 签名；正式对外分发还需要 Developer ID 签名与 Apple 公证。

## 第一个项目

1. **打开项目文件夹**，选择现有目录，写下持续目标。新项目会准备一个暂停的「自主推进」频道，默认允许工作区编辑，每日最多 32 轮；接入本身不会启动执行。
2. **设置 Codex 后台连接**。首次配置后，在当前任务结束时重新打开一次 Codex App。之后可直接在 Morrow 创建原生任务，或关联同一项目已有任务；无需每次在 Codex App 中打开对应页面。
3. **点击「开始工作」**。Codex 结合项目目标与现状选择下一步，通过项目工作接口维护判断、看板和证据。
4. **在同一对话中指导**。可发送文字和图片，运行中追加指导，处理受支持的原生审批与提问，也可随时暂停。
5. **审阅上线材料**。需要发布时，到项目「上线确认」查看具体改动、预期收益、证据、回退方案和发布后的观察计划，再决定是否发布。

欢迎页提供明确标注的示例工作区，示例频道不会执行。`⌘N` 打开项目，`⌘K` 搜索，`⌘,` 打开设置，`⌘B` 切换侧栏。

## 下一步

- [核心机制](CORE-MECHANISM.md)：理解 Codex 如何持续工作、维护看板和收集反馈。
- [原生运行时](RUNTIMES.md)：Codex 连接要求，以及 Claude Code / Trae 的支持范围。
- [升级与数据迁移](UPGRADING.md)：从 NoHuman 升级、备份和切换后台服务。
- [开发指南](DEVELOPMENT.md)：隔离工作区、测试与打包。
