<p align="center">
  <img src="assets/brand/morrow-logo.png" width="112" height="112" alt="Morrow logo">
</p>
<h1 align="center">Morrow</h1>
<p align="center"><strong>让 Codex 持续负责一个项目的目标。</strong></p>
<p align="center">
  <a href="#跟-main-的区别">跟 main 的区别</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/README.md">文档</a>
</p>

Morrow 是一个本地优先的 Mac 应用。打开已有项目，说明想达到的结果，它能持续理解现状、选择行动、执行验证，并根据反馈调整下一步。上线前由人审阅并确认具体版本。

**这份 README 描述的是 `yukun`（当前 0.16.1）。** GitHub 默认分支 `main` 停在 0.10.0，直接 `git clone` 拿到的是那一版，不是下面说的能力。

## 跟 main 的区别

`main` 把 Morrow 改成自己拉起 `codex app-server`（stdio），不查找、不唤醒 Codex Mac App。本分支没有采用那条实现：默认仍然进 **Codex App 里一条已关联的任务**（follower）；CLI 是每个 Codex 频道自己选的第二条路，用的是本仓库后来写的 `codex exec`，不是 `main` 的 app-server。

| | `main`（0.10.0） | 本分支 `yukun`（0.16.1） |
| --- | --- | --- |
| Codex 怎么跑 | Morrow 自己起 `codex app-server`，不连 Mac App | 默认 App follower；频道可选直连 `codex exec` |
| 任务从哪来 | CLI 进程里创建 / 按原 ID 恢复 | 人在 Codex App 为同一目录建任务、**发出首条**并保持打开，再回 Morrow 点「关联 App 任务」。Follower IPC 不能创建任务，Morrow 也不再假装能 |
| 对话在哪 | 在 Morrow 里聊 | 走 App 的频道完整对话在 Codex App；Morrow 不镜像、也不从频道页往 App 发消息。CLI 频道用页面底部的「留言」 |
| 工作接口 / 提议上线 | 无本分支这套 grant + MCP | App 轮次走任务内 HTTP。有 grant 的 CLI 轮次（Codex `cli`、Claude Code、Trae）走主机 Morrow MCP，可以 `release.propose`；**不能批准上线**。没有 App 任务时 `evidence.native` / `execution.prepare` 为 409 |
| App 专属能力 | 无（不连 App） | 应用内浏览器、Computer Use、App 动态工具、App 内审批，只属于走 App 任务的频道 |
| 其他运行时 | Claude Code（适配器不开 Bash）、Trae | Claude Code 与 Trae 为有界 CLI 轮次；工作区写入含命令执行。沙箱内 Codex/Trae 命令不联网 |
| 额度 | 同一套 Codex 账号相关门禁 | 一样：App 与 CLI 直连都花 Codex 账号。Claude 复核不花这份额度 |

本分支相对 `main` 还多了：装上新版本后等当前工作结束再自动切换、任务上下文到 65% 在轮次边界压缩、独立复核分事项/上线计时。CLI 直连换来的是不依赖 App 常驻，代价是没有上面那些 App 专属能力；没有 grant 的一轮仍可用可选报告写看板。

判断与定位记在 [产品方向](docs/PRODUCT-DIRECTION.md) 的 2026-09-15 / 2026-09-18 说明。能力细节见 [运行时](docs/RUNTIMES.md)。

## 快速开始

需要 **macOS 14+、Node.js 24+、npm、Xcode Command Line Tools**。走 App 任务时安装并登录 Codex Mac App；直连 Codex CLI 时安装 CLI 并 `codex login`。

```bash
git clone -b yukun https://github.com/AniChikage/Morrow.git
cd Morrow
npm ci
npm run build:app
bash scripts/install-app.sh
open "$HOME/Applications/Morrow.app"
```

1. 「接入项目」选择已有目录，写下目标，并在「项目说明」里补上仓库里没有的背景。新项目会准备一个暂停的频道，接入不会立即执行。
2. 需要另一条工作方向时，在项目里「新建频道」。Codex 在「工作设置」里选执行方式（默认 App 任务）。
3. 走 App 任务的频道：在 Codex App 为同一项目目录新建任务、发送首条消息并保持打开，再回到频道点「关联 App 任务」。直连 Codex CLI 的频道跳过这一步。
4. 点「继续工作」。走 App 的轮次沿用 App 权限与审批；有 grant 的 CLI 轮次通过主机 MCP 使用工作接口。
5. 走 App 时审批在 Codex App 里处理；CLI 频道在「需要你」只读显示提问，答案写在留言框，再「留言并运行一轮」。
6. 到项目页的「上线确认」核对改动、证据与回退方案，再决定是否上线。

构建输出为 `dist/Morrow.app`，默认安装到 `~/Applications/Morrow.app`。完整步骤见 [使用指南](docs/GETTING-STARTED.md)；旧用户见 [从 NoHuman 升级](docs/UPGRADING.md)。

## 开发

```bash
npm run dev:ui  # 浏览器预览，使用明确标注的示例数据
```

Electron 隔离开发、测试和打包方式见 [开发指南](docs/DEVELOPMENT.md)。

## 文档

| 想了解什么 | 从这里开始 |
| --- | --- |
| 安装、关联 App 任务、第一个项目 | [开始使用](docs/GETTING-STARTED.md) |
| 两种 Codex 执行方式、Claude / Trae、工作接口边界 | [运行时](docs/RUNTIMES.md) |
| 为什么默认仍是 App、CLI 是可选项 | [产品方向](docs/PRODUCT-DIRECTION.md) |
| 核心机制、架构、工作协议 | [文档目录](docs/README.md) |
