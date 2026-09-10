# 升级与数据迁移

[文档首页](README.md) · [安装方式](GETTING-STARTED.md)

## 从 NoHuman 升级

项目现名为 **Morrow**。应用名、包名、构建产物和新配置统一使用新名称，已有项目与任务保持关联。

- 新安装默认使用 `~/Library/Application Support/Morrow/`。新目录不存在且旧目录存在时，继续使用 `~/Library/Application Support/NoHuman/`；`MORROW_HOME` 可明确指定已有数据目录。
- `NOHUMAN_*` 环境变量、旧偏好键和历史协议标记保留兼容读取。已有证据摘要、原生任务 ID、运行归属和每日预算不会因为换名重新生成。
- 安装脚本保留旧 App，以兼容仍引用旧绝对路径的后台进程和 Codex 启动器。正在工作的服务不会因安装而被自动重启。
- 准备切换后台时，先结束或暂停 Morrow 管理的工作，再退出旧执行服务，打开新 App。新服务直接使用 Codex CLI；如启用了服务登录启动项，再运行 `bash scripts/login-service.sh install` 更新它。确认服务已切换且旧桥接启动项已撤销后，才移除旧 App。

备份运行中的数据请使用 SQLite 在线备份，或先停止执行服务再完整复制数据目录。不要仅复制仍在写入的 `workspace.sqlite`。

## 更新 Morrow

重新运行 `npm run build:app` 和 `bash scripts/install-app.sh`。安装器先校验完整应用，在临时目录保留旧包用于失败回退，成功后删除该副本；不会持续积累时间戳版本。退出并重新打开 Morrow 界面可加载新界面与图标。

安装本身不重启正在工作的 daemon。仅界面或文档更新不需要重启服务；若本次包含服务修复，安排在 Morrow 管理的工作结束或暂停后切换。不要为了刷新界面而终止 Codex App 的原生任务。

清理旧包前检查后台服务、Codex 启动器和登录启动项是否仍引用其路径。`NoHuman.app` 若是指向 `Morrow.app` 的兼容符号链接，本身不占用另一份应用的空间；仍被使用时应保留。

## 0.10.0：直接使用 Codex CLI

不再唤醒、联动或重启 Codex App。先在执行主机安装并登录 Codex CLI，再更新 Morrow。服务切换时保留数据库、项目、频道、任务 ID、预算和证据；旧任务在相同 CODEX_HOME 中按原 ID 恢复，不自动创建替代任务。旧 App 专属设置不迁入 CLI，不再承诺 App 双向实时同步。

已有自有桥接设置会在新服务启动时撤销，仅移除 Morrow/NoHuman 安装的 CODEX_CLI_PATH 覆盖与对应登录启动项；当前 App 和桥接进程保持运行直到其自行退出。自定义启动设置保持原样。Morrow 自有 CLI 在服务退出后结束，未确认发送不自动重发。

### 旧 App 写入锁的接续

实际安装验收发现，App 可在轮次空闲时仍持有原任务写入锁。新策略不释放其他进程的锁、不操作 App、不重启 Codex：仅对升级前的旧绑定，在 CLI 明确返回 `already has an active writer` 时，通过原生 `thread/fork` 做一次接续。SQLite 保存旧任务 ID、接续回执与新旧绑定关系，界面明确显示接续说明；旧运行、证据和预算不改写，继承的轮次不重复计数。后续持续复用新 CLI 任务。普通网络失败、已归属 CLI 的任务或未确认发送不能触发该迁移；接续结果未知时不重发创建。
