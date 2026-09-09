# 升级与数据迁移

[文档首页](README.md) · [安装方式](GETTING-STARTED.md)

## 从 NoHuman 升级

项目现名为 **Morrow**。应用名、包名、构建产物和新配置统一使用新名称，已有项目与任务保持关联。

- 新安装默认使用 `~/Library/Application Support/Morrow/`。新目录不存在且旧目录存在时，继续使用 `~/Library/Application Support/NoHuman/`；`MORROW_HOME` 可明确指定已有数据目录。
- `NOHUMAN_*` 环境变量、旧偏好键和历史协议标记保留兼容读取。已有证据摘要、原生任务 ID、运行归属和每日预算不会因为换名重新生成。
- 安装脚本保留旧 App，以兼容仍引用旧绝对路径的后台进程和 Codex 启动器。正在工作的服务不会因安装而被自动重启。
- 准备切换后台时，先结束或暂停 Morrow 管理的工作，再退出旧执行服务，打开新 App。通过新服务重新配置 Codex 后台连接；如启用了服务登录启动项，再运行 `bash scripts/login-service.sh install` 更新它。确认启动器和服务都已切换后，才移除旧 App。

备份运行中的数据请使用 SQLite 在线备份，或先停止执行服务再完整复制数据目录。不要仅复制仍在写入的 `workspace.sqlite`。

## 更新 Morrow

重新运行 `npm run build:app` 和 `bash scripts/install-app.sh`。安装器先校验完整应用，在临时目录保留旧包用于失败回退，成功后删除该副本；不会持续积累时间戳版本。退出并重新打开 Morrow 界面可加载新界面与图标。

安装本身不重启正在工作的 daemon。仅界面或文档更新不需要重启服务；若本次包含服务修复，安排在 Morrow 管理的工作结束或暂停后切换。不要为了刷新界面而终止 Codex App 的原生任务。

清理旧包前检查后台服务、Codex 启动器和登录启动项是否仍引用其路径。`NoHuman.app` 若是指向 `Morrow.app` 的兼容符号链接，本身不占用另一份应用的空间；仍被使用时应保留。
