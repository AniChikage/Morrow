# Morrow 文档

[返回项目首页](../README.md)

## 使用

| 文档 | 内容 |
| --- | --- |
| [开始使用](GETTING-STARTED.md) | 安装、关联 Codex App 任务、第一个项目和日常操作。 |
| [原生运行时](RUNTIMES.md) | Codex、Claude Code 和 Trae 的接入方式、默认权限、实测过的原生能力与能力边界。 |
| [升级与数据迁移](UPGRADING.md) | 旧 NoHuman 数据、任务连续性、更新与备份。 |

## 机制与开发

| 文档 | 内容 |
| --- | --- |
| [核心机制](CORE-MECHANISM.md) | 目标、行动、证据、反馈、复盘与人工上线确认的流程。 |
| [架构与数据](ARCHITECTURE.md) | Electron、执行服务、原生运行时和持久化的职责。 |
| [项目工作协议](PROJECT-WORK-CONTRACT.md) | AI 管理项目时使用的接口、字段与约束。 |
| [执行服务](../service/README.md) | 本机与 SSH 部署、服务配置、恢复和运行边界。 |
| [开发指南](DEVELOPMENT.md) | 隔离开发、测试、构建和品牌资源。 |
| [验收 harness](../scripts/acceptance/README.md) | 可重复的场景验收：场景 DSL、fixture 与 live 两种运行方式，以及各自能与不能证明什么。 |
| [live 模式的设计与决定](acceptance/LIVE-MODE-PROPOSAL.md) | 把同一套场景接到真实 Codex App 任务上：隔离范围、人要做的两步、三道预算闸、停止条件与清理，以及 2026-09-11 拍板的八条决定。 |
| [品牌资源](../assets/brand/README.md) | Logo 图稿、导出方法与生成提示词。 |

## 产品方向与研究

- [产品方向](PRODUCT-DIRECTION.md)：用户已确认的定位、视觉原则与自主性要求。
- [认知架构](COGNITIVE-ARCHITECTURE.md)：理论依据和可验证的工程提案；区分实证、模型、类比与已实现行为。
- [Multica 架构审查](MULTICA-ARCHITECTURE-REVIEW.md)：早期参考和迁移取舍，保留当时的版本背景。

## 历史协议与验收

以下材料描述对应版本的验证范围与局限，不代表当前版本全部能力已通过真实环境验收。

- [早期服务协议](contract.md)、[SwiftUI 验收](VALIDATION.md)、[Electron 验收](ELECTRON-VALIDATION.md)。
- [0.3.0](PRODUCT-V030-VALIDATION.md)、[0.4.0](PRODUCT-V040-VALIDATION.md)、[0.4.3](ACCEPTANCE-0.4.3.md)。
- [0.6.0](PRODUCT-V060-VALIDATION.md)、[0.7.0](PRODUCT-V070-VALIDATION.md)、[0.7.1](PRODUCT-V071-VALIDATION.md)、[0.8.0](PRODUCT-V080-VALIDATION.md)。

- [Codex 两种连接方案实测](CODEX-CONNECTION-VALIDATION-2026-09-09.md)：follower 与直接共享后台的真实结果及边界。

- [0.9.5 follower 迁移](FOLLOWER-MIGRATION-V095.md)：实现、真机验收、安装状态与下一步。
