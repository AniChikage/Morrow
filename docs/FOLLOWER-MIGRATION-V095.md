# 0.9.5：App follower 接入迁移

2026-09-09 已实现、验证并安装到本机。生产自动工作改为 App 本地 IPC follower；独立复核改为官方只读 CLI。没有启动 0.7 或长期 dogfood。

## 行为

- Morrow 添加项目后，需要在 Codex App 为同一目录创建任务、发送首条消息并保持打开，再回到频道关联。Morrow 不再自动创建 App 任务；未关联时启动返回明确的 409 引导。
- 原生频道默认沿用 App 的沙箱和审批设置，不再由 Morrow 请求完整访问。已有只读/工作区选项保留；自动轮次遇到任务忙碌时不转为 steering。
- 旧转接安装入口返回 410，界面移除启用按钮。服务只撤销与自己旧安装精确匹配的环境变量及登录项；正在使用旧转接的 App 需要在当前任务结束后重开，服务不终止 App。历史 shared transport 和启动器代码只保留为隔离夹具，生产构造器不再发现或选择它们。
- 独立复核使用 `codex exec --json --ephemeral --ignore-user-config --ignore-rules --sandbox read-only`、`approval_policy="never"`，关闭 Web 搜索，不传执行者的 Morrow grant 和 App 工具管道。事件归一化后沿用已有源码、预期、证据和最终结论门禁。模型终止事件与 CLI 成功退出都满足后才能通过；真实 CLI 未返回轮次 ID 时保持为空。
- 专用 supervisor 在取消、最长 5 分钟超时、父服务退出或被强制结束时清理自己拥有的 CLI 进程组。CLI 复核恢复为未知，不向原执行任务发送停止请求。
- 额度由短暂的官方 app-server 协议连接读取 `account/rateLimits/read`，不创建任务或模型轮次；复用已有未知策略、保留线和项目估算门禁。
- 运行时页区分 App 安装、IPC 连接、已有绑定及任务实际可用状态；显示实际版本。项目/频道权限文案、能力清单和文档已同步。

## 验证

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run format:check` | 通过 |
| `npm test` | 176 项：175 通过，1 跳过 |
| `npm run test:ui` | 全量 193 通过；最终运行时文案调整后的相关 13 项再次通过 |
| `npm run acceptance:fixture` | 全部 careful 场景及 careful/naive 指标自检通过 |
| 打包 Node 24 运行 CLI 复核专项测试 | 4 项通过，包含非零退出、缺终止事件、非法/超限输出、取消、硬超时和父进程被终止 |
| 官方 CLI 真机只读检查 | 真实读取测试文件，写入捕获 `PermissionError`，canary 未产生 |
| 新 Morrow 服务 → follower → App 任务 | 已关联任务自动执行一轮，读取 Morrow context，真实操作应用内浏览器并返回对应随机标记 |
| 官方协议额度读取 | 真机成功；此账号当前可解析的主窗口为 weekly |
| `npm run build:app` | Electron arm64 构建、打包和签名校验通过 |
| 安装版 | `~/Applications/Morrow.app` 为 0.9.5；33 个服务源码文件与仓库逐字节一致 |

服务全量测试的跳过项是原有、需显式设置二进制路径的历史共享后台集成测试。新 follower 路径另有上表真实验收，不以该跳过项替代。

完整服务验收在临时 Morrow 数据目录运行，复用先前由 App 创建的合成测试任务。最终调度轮次 `01a08946-b4fe-7150-975a-81535c22f52c` 经 App 执行，页面服务器生成的随机标记与真实点击结果一致；运行记录的权限为 `native`，未关联启动被拒，任务创建能力为 false，额度可读。验收结束暂停该频道并关闭测试服务和页面服务。

第一次临时验收脚本错误选中了同步进来的历史 `native-app` 轮次，随后清理中断了刚开始的测试轮次。脚本修正为只选择本次 `morrow-schedule` 记录后通过；没有把历史回复算成本轮结果，也没有据此修改生产轮次匹配逻辑。

本次把有界真机 smoke 脚本保存为 [scripts/probe-app-follower.ts](../scripts/probe-app-follower.ts)，避免只保留一次性临时脚本。显式提供已有隔离 App 任务和同一目录即可复测；该命令会消耗一轮真实模型用量，不属于 `npm test`，也不代表 Phase 1 全套场景的 live 模式已经完成：

```bash
node scripts/probe-app-follower.ts \
  --thread "$MORROW_PROBE_THREAD_ID" \
  --project "$MORROW_PROBE_PROJECT" \
  --out /tmp
```

脱敏验收数据见 [results.json](../artifacts/follower-migration-v095/results.json)。安装版通过 Computer Use 读取无障碍树并检查截图：App 连接正常，无关联任务时第三步显示待完成，存在明确关联引导，没有旧启用入口。截图仅保留为本地 QA 产物，不进入公开材料。

## 安装与边界

切换前确认安装版没有项目、频道或运行任务，并做了 SQLite 在线备份与完整性检查。备份位于 `$MORROW_HOME/backups/follower-v095-20260909T221047/workspace.sqlite`。升级前后项目、频道、事项、运行、绑定和控制记录计数一致，数据库完整性正常。Codex App 原进程保持运行，`CODEX_CLI_PATH` 没有设置为转接路径。

更新期间，空闲 Morrow 界面未按普通退出请求结束；为替换界面，终止了已核对的 Morrow 前端进程。该现象在原安装版也出现，本次没有扩展修改退出机制。Morrow 独立服务已切换，最后仅界面文案更新时保留了新的空闲服务。

当前正式 Morrow 数据中尚无项目或绑定，状态为 `connected=true`、`connectionMode=app-follower`、`capabilities.create=false`、`restartRequired=false`。未配置额度限制的空工作区沿用原行为，显示“尚未读取账户用量”，不能把它误报为读取失败。

本次实测覆盖一轮完整调度及 CLI 只读行为，结构化复核结果的门禁使用明确标注的 CLI 夹具验证；未证明长期无人值守、任意项目效果或所有 App 工具都可用。App 内部 IPC 仍有版本兼容边界；工作区写入会合并 App 保留的目录；原生记忆总结、Chrome 操作及官方 daemon 管理路线继续保持未验证。

后续建议直接进入 0.7 的隔离工作树与最小真实试跑，不等四个历史场景全部完成才收集反馈；Phase 1/2 随后补齐，两周运行和退出标准仍按计划执行。Phase 4 继续由对照数据决定，暂不增加新机制。
