# 验证记录 · 2026-09-06

本文记录 0.1 SwiftUI 客户端及当时执行服务的验证结果。0.2.0 默认桌面实现已迁移到 Electron + React；下方原生 UI 与 SwiftPM 构建结果仅适用于旧客户端，不代表新版 Electron 界面已经完成相同验收。当前命令与边界见 [README.md](../README.md) 和 [contract.md](contract.md)。

## 构建与运行环境

- macOS 26.5.2 / Apple Silicon；Swift 6.2.4 / macOS SDK 26.2。
- SwiftPM debug 与 release 构建成功。
- 官方 Node 24.20.0 打入 `.app`，下载归档经官方 SHA-256 清单验证。
- App Info.plist 检查、嵌套 Node 和完整 `.app` 的 ad-hoc 签名验证成功。

## 执行服务

11 项隔离集成测试通过，包括认证与 Origin、输入校验、默认暂停、示例不可执行、结构化结果、知识来源与共享、人工备注、原生会话恢复、跨引擎交接、无效结果阻塞、日预算、项目锁、进程组终止、重启恢复、中文 UTF-8 分块、超时和认证错误分类。测试在本机 Node 26 及打包的 Node 24 上通过。

## 真实 CLI 测试

在独立的合成项目中调用本机 CLI，未访问线上系统。

| 运行时 | 结果 |
| --- | --- |
| Codex | 22 秒完成；读取 README.md 与 ratio.js，发现零分母约定与代码不一致，保存 1 条有文件证据的发现；原文件未修改 |
| Claude Code | 本机 CLI 可启动，但认证失败，返回 `Not logged in`；没有生成虚构发现 |
| Trae CLI | 本机 CLI 可启动，但服务返回 401，模型元数据不可用；没有生成虚构发现 |

真实报告位于 `artifacts/live-smoke-*/report.json`；含运行细节的 artifacts 目录被 Git 忽略。Claude 与 Trae 需要用户完成 CLI 登录后才能验证模型执行。

## 原生 UI

通过 CUA 操作实际 `.app` 验证：首次启动自动连接、加载明确示例、项目/频道切换、证据详情、中文搜索、配置保存、运行引擎状态、连接设置、新建真实 Morrow 项目。

最终真实项目路径为 `/Users/bytedance/workspace/morrow`，两个频道均为暂停状态。UI 测试未启动真实项目的执行。

退出原生界面后，`/health` 仍返回正常，验证了本机执行服务独立于 UI 的生命周期。

## 尚未验证的边界

- SSH 连接逻辑已编译与代码审查；当前没有用户指定的远程主机，因此未进行实际跨机联调。
- 生产数据采集、自动发布、回滚与线上效果不在此次本地 MVP 的验证范围内。
- 应用未进行 Developer ID 签名与公证，不代表已满足公开分发要求。
