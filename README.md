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

`main`（0.10.0）把 Morrow 改成自己拉起 `codex app-server`（stdio），不查找、不唤醒 Codex Mac App，聊天和审批都在 Morrow 里。本分支没有采用那条实现：默认仍然进 **Codex App 里一条已关联的任务**（follower）；CLI 是每个 Codex 频道自己选的第二条路，用的是后来写的 `codex exec`，不是 `main` 的 app-server。

界面也跟着反过来了：`main` 的频道页是内嵌对话；本分支的频道页是工作日志，完整对话在 App。

### 接入与执行

| | `main` | 本分支 |
| --- | --- | --- |
| Codex 怎么跑 | Morrow 自己起 `codex app-server`，不连 Mac App | 默认 App follower；频道可选直连 `codex exec` |
| 任务从哪来 | CLI 进程里创建 / 按原 ID 恢复；Morrow 可「新建原生对话」 | 人在 App 为同一目录建任务、**发出首条**并保持打开，再点「关联 App 任务」。Follower IPC 不能创建任务 |
| 对话 / 发图 / 当场审批 | 在 Morrow 里聊，可贴图、中断、点批准或拒绝 | 走 App 的频道这些都在 Codex App；Morrow 不镜像、不从频道页往 App 发消息或图片 |
| 工作接口 / 提议上线 | 无本分支这套 grant + MCP | App 轮次走任务内 HTTP。有 grant 的 CLI 轮次走主机 Morrow MCP，可以 `release.propose`，**不能批准上线**。没有 App 任务时 `evidence.native` / `execution.prepare` 为 409 |
| App 专属能力 | 无 | 应用内浏览器、Computer Use、App 动态工具、App 内审批 |
| Claude / Trae | 有；Claude 适配器不开 Bash | 有界 CLI 轮次；工作区写入含命令执行。Codex/Trae 沙箱内命令不联网 |
| 远程主机 | 远端 daemon 在那台机器上起 `codex app-server` | 远端自动工作要那台机器上的 Codex App；不会回连本机 Mac App |

### 界面（人一打开就能看出）

| | `main` | 本分支 |
| --- | --- | --- |
| 频道页 | 「原生对话 / 动态 / 运行记录」；Codex 主按钮偏聊天 | 一页：主按钮（关联 / 打开 App / 继续工作）+「需要你」+（CLI）留言 + 工作日志 + 折叠审计。没有对话 tab |
| 主按钮 | Codex 在 Morrow 发消息；Claude/Trae「运行一次 / 开启持续运行」 | 按缺口轮换：检测 App → 关联任务 → 在 App 打开 → 暂停 / 回答 / 上线 / 继续工作 |
| CLI 怎么交代 | 「向频道补充上下文」，不自动开跑 | 「留言」只进下一轮；「留言并运行一轮」才跑。已读留言会折进「更早的留言」 |
| 需要你 | 问在对话里，或「等你指导」 | 统一「需要你」：提问、待确认上线、App 审批、额度闸、阻塞事项。App 可在卡片里答；CLI 问题只读，答案写留言框 |
| 运行时页 | 标题「Codex CLI」；脚注写无需打开桌面 App | 标题「Codex App」；四步：已安装 → 已连接 → 任务已关联 → 可用。有 CLI 直连频道时才再露出 `codex login` |
| 接入 / 建频道 | 「打开项目」；权限写沿用 CLI | 「接入项目」，可同时写项目说明。Codex 多一项「执行方式」（App 任务 / 直连 CLI）；「沿用 App 原生权限」只给 App 频道 |
| 项目页 | 功能看板；打开「Codex CLI」 | 用语改成「事项」。多「项目说明」tab、属性栏里的待回答 / 额度、「项目下一步」主 CTA。打开改成「Codex App」 |
| 看板 | 四列 + 发现 | 已解决收到「已解决历史」；卡片显示负责频道，可分派或交回；事项入口是「打开工作日志」不是进聊天 |
| 上线确认 | HTTP 发布端；确认版本 | 另有 `local-script`（封存脚本，批准前可逐字读）。切换版本过程中不能点确认 |
| 运行记录 | 复制原生会话 ID | 区分「App 任务」和「CLI 轮次」 |
| 顶栏 / 空态 | 无升级横幅；欢迎「新建项目」 | 新版本等当前工作结束再切，可「立即重启」。欢迎「写下项目说明，再关联 Codex App 任务」。服务断开时有离线条。侧栏项目旁有待回答计数 |
| 没有了 | — | Morrow 内嵌对话、贴图、在 Morrow 批准、从 Morrow「新建原生对话」、「在原生 CLI 中继续」打开终端 |

### 项目工作、额度、升级

| | `main` | 本分支 |
| --- | --- | --- |
| 项目说明 | 只有目标 `goal` | 人写的 Markdown 说明（agent 只读不改）；改说明后下一轮会带上 |
| 事项负责 | 无 | 推进即认领；别的频道写同一事项会 409；人可改负责频道 |
| 独立复核 | 第二个原生任务、同 Codex、一律 5 分钟 | 不与执行者同一运行时（Codex 工作 → Claude 复核，反之亦然）。事项 5 分钟、上线 8 分钟；优先一次性隔离 worktree |
| 上线门禁 | HTTP；事项级复核 | 还要一次 `kind:release` 复核。App 要当前源版本的 execution 证据；CLI 用 file/http 采集证据，复核者在隔离检出里重跑检查 |
| 额度 | 无账户读数 / 保留线 UI | 设置里「保留给自己的额度」；项目可设上限。只挡 Codex 的自动轮次和复核，普通 App 对话不挡。Claude 复核不花 Codex 额度 |
| 工作树脏 | 无 | 上一轮弄脏共享 git 树时，调度会等；手动开始会 409。服务不 stash |
| App 任务压缩 | 无这套 | 用量到 65% 在轮次边界压缩（只 App）。CLI 直连没有 compact |
| 装新版本 | 装完自己重开 | `install-app.sh` 之后 daemon 等闲下来再切，退出码 75，不 `pkill`。SSH 会话不走这套 |
| CLI 一轮多久 | 15 分钟 | 45 分钟；提示里会写时限和未提交文件 |
| 观察 | HTTP JSON | 另可观察项目内文件（`kind:file`） |
| App 被打断后续跑 | 无 | 若 App 自己续上同一轮且意图没变，Morrow 可回到等待，不改写打断的那轮 |

`main` 上 0.10.0 那条 CLI-only 实现已作为历史进仓库（合并提交只接历史），工作树里没有它的代码。细节：[产品方向](docs/PRODUCT-DIRECTION.md)、[运行时](docs/RUNTIMES.md)、[开始使用](docs/GETTING-STARTED.md)。

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
