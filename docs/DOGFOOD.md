# Morrow dogfood 操作约定

## 当前拓扑

- 作者在 Codex App 创建并加载本工作树的任务，再在 Morrow 关联。Morrow 通过 App follower 继续同一任务；账号、模型、权限和工具由 App 管理。
- 自动维护目标是独立工作树 `/Users/yukun/Documents/bytedance/Morrow-agent`，分支 `agent/work`。运行中的安装版是 `~/Applications/Morrow.app`，数据在 `~/Library/Application Support/Morrow`；自动开发不修改这些位置。
- 安装版服务源码位于 App Resources 下，独立于被修改的工作树。隔离服务测试通过 `tests/harness` 使用临时项目、临时数据目录、随机端口及假 CLI，并在结束时清理。
- 当前原生接入是 follower，不恢复历史启动转接，不修改 Codex App 设置。新的工作树功能通过本地测试后仍需独立复核及发布确认；不得把源码完成写成安装版已经生效。

## 分支与发布

`phase-0` 保存人工复审的上游改动；需要时在 `agent/work` 执行 `git merge phase-0`。冲突以 `phase-0` 为准，并记录处理内容。每步小提交，不推送、不重写历史。合并到 `main`、构建与安装由人处理。

等 `phase-0` 的本地脚本发布能力合入后，使用 `release.propose` 的 `local-script` 目标、`scripts/release-local.sh` 和根目录 `release-manifest.json`（commit、branch、version、sourceDigest）。这些是约定的后续发布接口，未合入前不编造 HTTP 接收端，也不直接运行发布脚本。批准对应封存的明确版本。发布后的 `.morrow/metrics.json` 可接入 file 观测；记录实际结果，不假定指标已存在。

## 两条护栏

1. `execution.prepare` 比较项目真实路径与当前运行的执行证据模块所在服务目录。服务目录等于项目或位于项目之内时返回 409，且不创建封存记录。项目路径的符号链接按真实路径判断。应使用工作树之外的安装服务管理该项目；不要从被修改的目录启动服务后让它管理自身。
2. `startServer` 在任何数据目录读取、创建或监听之前检查环境。只要存在名称以 `CODEX_SANDBOX` 开头的变量（包括空值），且未显式设置 `MORROW_HOME` 或程序调用的 `options.home`，就拒绝默认数据目录与端口。仅指定端口或历史 `NOHUMAN_HOME` 不满足此隔离要求。测试 harness 的显式临时 home 仍被允许。

需要额外服务验证时，应显式指定独立 `MORROW_HOME` 和 `MORROW_PORT=0`（随机端口），或使用现有测试 harness。不得以删除沙箱标记来绕过护栏。

## 重启与进程清理

- UI 或工作树改动无需重启正在工作的安装版 daemon。不要为了测试重启或终止作者正在使用的服务。
- 如正式服务确需升级，先完成检查、封存版本并走人工上线确认；在原生任务安全结束后由批准的发布流程处理。重连沿用原任务，不复制或新建替代任务来掩盖失败。
- 启动预览前确认 5179 未被占用；只传必要环境，记录启动命令、PID/进程组及用途。走查结束（包括失败）必须关闭自己启动的进程，等待其退出，再核验 `pgrep` 与端口无残留。不能用宽泛的 `pkill node` 清理。
- 已有本地 `artifacts/dogfood-20260910/preview-lifecycle.py` 演练验证正常及主动异常清理；它只是有界演练，不是后台管理器，也不保证父进程被强杀后清理。真实走查仍需逐次执行和记录关闭动作。

## 验证及已知边界

- 每步执行 typecheck、服务测试和 UI 测试；验收相关改动再执行 acceptance:fixture。格式检查作为收尾检查，显式报告跳过项和 fixture 的负对照。
- 执行前 `execution.prepare`，执行后读取采集记录；证据与源码绑定。静默命令的显式 null 按 v2 要求视为完整空输出，缺字段或截断仍不完整。历史不完整记录不改判。
- 这些护栏不追踪或杀死任意外部进程，也不阻止绕过工作接口的直接文件写入；它们不替代 App 权限、工作树隔离或人工发布批准。
- 运行中服务若仍是旧安装版本，不会自动获得本次新护栏。源码测试、独立复核、安装后实测分别记录。
