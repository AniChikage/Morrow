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
- **一个项目，一份共享看板**：待处理、调查中、需要关注、已验证四列固定，已解决收进下方历史区；卡片可拖动或用「移动到」菜单改状态。AI 自动维护每个事项的来源频道、尝试、证据、发布与后续效果。
- **原生 Codex 对话**：通过 Codex App follower 复用同一任务；认证、模型、工具和执行由原生运行时管理。
- **上线前有据可审**：呈现改动、预期收益、验证结果、风险与回退计划，由人确认对应发布版本。

Morrow 支持 Codex（通过 Codex App）、Claude Code 与 Trae（本机已登录的 CLI）。Codex 频道的自动轮次默认沿用 Codex App 中已关联任务的权限与审批设置，需要时可在频道设置中收紧为只读或工作区写入；Claude Code 与 Trae 频道执行有界 CLI 轮次，默认工作区写入，也可收紧为只读。

框架已提供持续工作与反馈闭环的支撑机制；实际项目仍需接入自己的监控和发布能力，长期自主效果需要真实环境验证。详见 [能力边界](docs/RUNTIMES.md)。

## 这条分支与 main 的区别

这是 `yukun` 分支（0.12.1）。远端 `main`（0.10.0）自 `6246930` 起改为「直接用 Codex CLI、去掉与桌面 App 的耦合」；本分支是另一条线，执行入口以 Codex App follower 为准。两条线在执行路线上互斥，本 README 其余部分描述的都是本分支的行为。

| 差异 | main（0.10.0） | 本分支 yukun（0.12.1） |
| --- | --- | --- |
| 执行入口 | Morrow 自己启动 `codex app-server --listen stdio://`，不查找或唤醒 Codex App | 通过 Codex App 的本地 IPC 以 follower 身份，复用 App 已创建、已加载并明确关联的任务 |
| 需要安装什么 | 安装 Codex CLI，在终端 `codex login` | Codex 频道：安装并登录 Codex Mac App；在 App 里为项目目录建任务、发送首条消息并保持打开，再回到频道点「关联 App 任务」，App 须保持运行。Claude Code 频道：安装 Claude Code，在终端 `claude auth login`。Trae 频道：安装 `traex`，在终端 `traex login` |
| 支持的运行时 | Codex、Claude Code、Trae | Codex、Claude Code、Trae；差别只在 Codex 的执行入口（本分支走 App follower，main 走 CLI 直连），Claude Code 与 Trae 两边都是本机 CLI 的有界轮次 |
| 审批与权限在哪里处理 | 登录、模型、MCP 和工具配置来自 CLI，界面内指导和审批，不再提供 App 打开或桥接配置入口 | 由 App 管理；新的 Codex 频道默认沿用 App 的沙箱与审批设置，不自动提升为完整访问，审批请求在 Codex App 里处理 |
| 应用内浏览器 / Computer Use / App 动态工具 | Morrow 启动的 CLI 不连接 App，文档未列这些能力 | 2026-09-09 follower 实测可用：真实点击页面、`sky.list_apps()`、`get_usage_limits`。这三项依赖 App，也是本分支没有改用 CLI 直连的原因 |
| 看板形态 | 待处理、调查中、需要关注、已验证、已解决五列固定 | 前四列固定，已解决收进下方「已解决历史」折叠区，该区标题同时是第五个放置目标 |
| 独立复核方式 | 与执行共用同一个 CLI app-server 入口 | 官方 `codex exec` 的一次性只读会话（`--sandbox read-only`、`--ephemeral`、`--ignore-user-config`），不带执行者的权限和 App 本地工具管道 |
| 历史关系 | — | `main` 已作为历史合入本分支（合并提交 `de496e9`，未带入其改动），因此 `main` 是本分支的祖先；执行入口没有改成 CLI 直连，旧 `CODEX_CLI_PATH` 转接也已退役 |

本分支相对 `main` 还多出下面这些机制：

- 装上新版本后等当前工作真正结束再自动切换，不打断任何轮次，见 [升级与数据迁移](docs/UPGRADING.md)。
- 额度门槛：全局的「保留给自己的额度」按账户读数判断，项目的「额度上限」按归因估算判断；账号额度用尽时频道转为等待，到窗口重置再继续。见 [能力边界](docs/RUNTIMES.md) 与 [执行服务文档](service/README.md)。
- 任务上下文用量达到 65% 时在轮次边界自动压缩并继续工作，不需要人停下轮次手动压缩（`service/native-conversations.ts` 的 `compactContextPercent`）。
- 事项变更审计记录修改前后的值，界面据此显示一行变更摘要（`desktop/renderer/features/itemChangeSummary.ts`）。
- 独立复核按种类分开计时：事项 5 分钟、上线 8 分钟，supervisor 之后另兜一个 15 分钟硬上限（`service/work-verification.ts`）。
- 验收夹具与真实运行脚本（`scripts/acceptance/`、[真实模式提案](docs/acceptance/LIVE-MODE-PROPOSAL.md)）。
- dogfood 频道的操作约定，见 [dogfood](docs/DOGFOOD.md)。

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
| 为什么保留 App follower、不采用 CLI 直连 | [产品方向](docs/PRODUCT-DIRECTION.md) 的 2026-09-15 分支合并说明 |
| 产品方向、理论依据与验收记录 | [文档目录](docs/README.md) |
