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

Morrow 是一个本地优先的 Mac 应用。打开已有项目，说明想达到的结果，Codex 就能持续理解现状、选择行动、执行验证，并根据反馈调整下一步。你可以随时通过对话指导它，在上线前审阅并确认具体版本。

- **围绕目标持续工作**：保留项目认识、行动依据和经验，支持反馈唤醒、等待与预算约束。
- **一个项目，一份共享看板**：待处理、调查中、需要关注、已验证四列固定，已解决收进下方历史区；卡片可拖动或用「移动到」菜单改状态。AI 自动维护每个事项的来源频道、尝试、证据、发布与后续效果。
- **原生 Codex 对话**：默认通过 Codex App follower 复用同一任务；认证、模型、工具和执行由原生运行时管理。需要不依赖 App 时，频道也可以直连 Codex CLI，代价是没有这条原生对话。
- **上线前有据可审**：呈现改动、预期收益、验证结果、风险与回退计划，由人确认对应发布版本。

Morrow 支持 Codex、Claude Code 与 Trae（后两者是本机已登录的 CLI）。Codex 频道有两种执行方式，在新建频道时选：**Codex App 任务**（默认）把轮次交给 App 中已关联的任务，默认沿用该任务的权限与审批设置，需要时可在频道设置中收紧为只读或工作区写入；**直连 Codex CLI** 则每轮起一次本机 `codex exec`，不需要 App 常驻，权限与 Claude Code / Trae 同级（默认工作区写入，也可收紧为只读，没有「沿用 App 原生权限」这一项）。两种方式都花同一个 Codex 账号的额度。Claude Code 与 Trae 频道执行有界 CLI 轮次，默认工作区写入，也可收紧为只读。除走 App 任务的 Codex 频道外，频道页都有「留言」：写下的补充背景或方向会在下一轮开始时随上下文交给 CLI，列表写明每条是等待读取还是已在哪一轮被读取；留言本身不会开始一轮，需要立刻跑时用「留言并运行一轮」。

选哪一种：应用内浏览器、Computer Use、App 动态工具、App 内审批和 Morrow 工作接口（含提议上线）只有走 App 任务时才有，所以它是默认；CLI 直连换来的是不依赖 App 安装与常驻，代价是上述能力都没有，看板只能靠轮次末尾的可选报告维护。

框架已提供持续工作与反馈闭环的支撑机制；实际项目仍需接入自己的监控和发布能力，长期自主效果需要真实环境验证。详见 [能力边界](docs/RUNTIMES.md)。

## CLI 直连的来历

仓库早期有过一条只走 Codex CLI 的线：0.10.0 的提交 `6246930`「直接用 Codex CLI、去掉与桌面 App 的耦合」。那些提交已作为历史接进本仓库（合并提交 `de496e9` 只接历史，没有带进它们的改动），所以在 `git log` 里查得到，在工作树里找不到。

它没有被采纳为**唯一**的执行入口：那条线把 App 整个去掉，而应用内浏览器、Computer Use、App 动态工具、App 内审批和 Morrow 工作接口都依赖 App follower。它的思路最终落在频道的「执行方式」里，作为可选的第二传输方式（频道字段 `transport`，默认 `app`），由每个 Codex 频道自己选；现在这版 CLI 直连是本仓库自己实现的，不是那条线的代码。旧的 `CODEX_CLI_PATH` 转接与两条路都无关，已经退役。

当时的判断与这条可选传输方式的定位，记在 [产品方向](docs/PRODUCT-DIRECTION.md) 的 2026-09-15 分支合并说明。

## 配套机制

围绕持续工作，仓库里还有这些机制：

- 装上新版本后等当前工作真正结束再自动切换，不打断任何轮次，见 [升级与数据迁移](docs/UPGRADING.md)。
- 额度门槛：全局的「保留给自己的额度」按账户读数判断，项目的「额度上限」按归因估算判断；账号额度用尽时频道转为等待，到窗口重置再继续。见 [能力边界](docs/RUNTIMES.md) 与 [执行服务文档](service/README.md)。
- 任务上下文用量达到 65% 时在轮次边界自动压缩并继续工作，不需要人停下轮次手动压缩（`service/native-conversations.ts` 的 `compactContextPercent`）。
- 事项变更审计记录修改前后的值，界面据此显示一行变更摘要（`desktop/renderer/features/itemChangeSummary.ts`）。
- 独立复核按种类分开计时：事项 5 分钟、上线 8 分钟，supervisor 之后另兜一个 15 分钟硬上限（`service/work-verification.ts`）。
- 验收夹具与真实运行脚本（`scripts/acceptance/`、[真实模式提案](docs/acceptance/LIVE-MODE-PROPOSAL.md)）。
- dogfood 频道的操作约定，见 [dogfood](docs/DOGFOOD.md)。

## 快速开始

需要 **macOS 14+、Node.js 24+、npm、Xcode Command Line Tools**。Codex 频道走 App 任务时，先安装并登录 Codex Mac App；选择直连 Codex CLI 时，改为安装 Codex CLI 并在终端 `codex login`。

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
3. 走 App 任务的频道：在 Codex App 为同一项目目录新建任务、发送首条消息并保持打开，再回到频道点「关联 App 任务」。直连 Codex CLI 的频道跳过这一步。
4. 点「继续工作」。走 App 任务的轮次沿用 App 的权限与审批设置；直连轮次按频道选择的只读或工作区写入沙箱执行。
5. 在频道页的「需要你」区回答 Codex 的提问。走 App 任务时审批请求在 Codex App 里处理；直连频道在页面底部的留言框回答，再点「留言并运行一轮」。
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
| 为什么 App follower 仍是默认、CLI 直连是可选项 | [产品方向](docs/PRODUCT-DIRECTION.md) 的 2026-09-15 分支合并说明 |
| 产品方向、理论依据与验收记录 | [文档目录](docs/README.md) |
