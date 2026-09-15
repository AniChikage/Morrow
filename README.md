<p align="center">
  <img src="assets/brand/morrow-logo.png" width="112" height="112" alt="Morrow logo">
</p>
<h1 align="center">Morrow</h1>
<p align="center"><strong>让 Codex 持续负责一个项目的目标。</strong></p>
<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="docs/CORE-MECHANISM.md">核心机制</a>
</p>

Morrow 是一个本地优先的 Mac 应用。打开已有项目，说明想达到的结果，Codex 就能在同一个原生任务中持续理解现状、选择行动、执行验证，并根据反馈调整下一步。你可以随时通过对话指导它，在上线前审阅并确认具体版本。

- **围绕目标持续工作**：保留项目认识、行动依据和经验，支持反馈唤醒、等待与预算约束。
- **一个项目，一份共享看板**：AI 自动维护每个 feature 的来源频道、尝试、证据、发布与后续效果。
- **原生 Codex 对话**：与 Codex App 使用同一任务；认证、模型、工具和执行由原生运行时管理。
- **上线前有据可审**：呈现改动、预期收益、验证结果、风险与回退计划，由人确认对应发布版本。

Morrow 只支持 Codex。新频道的自动轮次默认沿用 Codex App 中已关联任务的权限与审批设置，需要时可在频道设置中收紧为只读或工作区写入。早期版本留下的 Claude Code / Trae 记录保持可读，但不再执行。

框架已提供持续工作与反馈闭环的支撑机制；实际项目仍需接入自己的监控和发布能力，长期自主效果需要真实环境验证。详见 [能力边界](docs/RUNTIMES.md)。

## 快速开始

需要 **macOS 14+、Node.js 24+、npm、Xcode Command Line Tools**。使用 Codex 时，先安装并登录 Codex Mac App。

```bash
git clone https://github.com/AniChikage/Morrow.git
cd Morrow
npm ci
npm run build:app
bash scripts/install-app.sh
open "$HOME/Applications/Morrow.app"
```

1. 「接入项目」选择已有目录，写下目标，并在「项目说明」里补上仓库里没有的背景。新项目会准备一个暂停的频道，接入不会立即执行。
2. 需要另一条工作方向时，在项目里「新建频道」。
3. 在 Codex App 为同一项目目录新建任务、发送首条消息并保持打开，再回到频道点「关联 App 任务」。
4. 点「继续工作」，自动轮次沿用 App 任务的权限与审批设置。
5. 在频道页的「需要你」区回答 Codex 的提问，审批请求在 Codex App 里处理。
6. 到项目页的「上线确认」核对改动、证据与回退方案，再决定是否上线。装上新版本后，Morrow 会等当前工作结束再自动切换。

构建输出为 `dist/Morrow.app`，默认安装到 `~/Applications/Morrow.app`，已包含 Node 运行时。当前为本机 ad-hoc 签名构建。完整步骤见 [使用指南](docs/GETTING-STARTED.md)；旧用户见 [从 NoHuman 升级](docs/UPGRADING.md)。

## 开发

```bash
npm run dev:ui  # 浏览器预览，使用明确标注的示例数据
```

Electron 隔离开发、测试和打包方式见 [开发指南](docs/DEVELOPMENT.md)。

## 文档

| 想了解什么 | 从这里开始 |
| --- | --- |
| 如何持续理解、行动、验证和改进 | [核心机制与流程图](docs/CORE-MECHANISM.md) |
| 如何连接原生任务、保存数据 | [架构与数据](docs/ARCHITECTURE.md) · [运行时](docs/RUNTIMES.md) |
| AI 如何维护项目、反馈和发布 | [项目工作协议](docs/PROJECT-WORK-CONTRACT.md) |
| 产品方向、理论依据与验收记录 | [文档目录](docs/README.md) |
