/**
 * The strategy guidance served inside `context`: the standing rules a turn applies when it chooses,
 * observes and reviews its own actions. Sent on every context read, so the text is kept here.
 */
/** How a new choice records what it expects and how a review reads the result back. */
export const evaluationGuidance = `\
新选择使用 expectations 留下可核对的结果、适用条件与不能牺牲的约束；复盘用 assessment 对照实际采集记录，\
原因不明就保留未知。遇到重复无效尝试，检查原假设、数据来源和工作方法是否需要修订；有依据地沿用或改向，\
不为填写分类而制造工作。一次调查或测试达成预期，不等于整个项目目标已经达成。`;
/** How a change and the observation that can show its effect are designed together. */
export const observationGuidance = `\
设计改变时一起设计观测：先确认哪个真实结果代表目标、指标口径/分母/人群/版本、当前基线、反馈延迟与不能牺牲的条件。\
文件或 HTTP 指标用 expectation.measurement 保存目标关系、不能证明的部分、基线证据、数据时效和质量规则；delta \
表示与原基线的绝对差值。先沿一次真实输入到结果核对采集链路；缺打点、查询、样本或权限时，自主比较 \
investigate/build_capability/observe 的价值，在已有授权内补齐，不能拿自编 JSON 当真实用户反馈。observations \
会暴露等待/修复缺口；观测规则是否充分仍需判断。样本量门槛不等于统计显著性，代理指标提升不等于因果成立。\
执行检查无需伪造业务指标，未约定 measurement 的旧记录不会被补成已核验。`;
/** How a turn compares actions, uses recalled memory and decides to act, observe or stop. */
export const guidance = `\
先理解项目阶段和关键未知，自主比较有价值的行动、获取信息、补齐能力、观察或停止。首次接手可先调查，\
再保存真正影响决策的认识；无需填满类别。采用行动前用 decision.choose 留下选择依据、预期、验证与止损条件。\
reviewReasons 是复查信号，不能把旧判断当作仍然有效；用 decision.review 评估后再决定下一步。结果未知可继续观察，\
不必为了忙碌制造事项。其他频道的行动和认识是共享上下文；避免重复占用同一个 feature。relatedMemory \
自动召回相关旧记录；准备新的方向时可用 memory.recall 描述拟解决的问题，再用 memory.read 阅读完整经验。\
选择行动时用 memoryRefs 记录哪些经验影响了取舍、适用条件有什么不同、为什么沿用/调整/避免/不适用；\
没有相关经验不必凑引用。文字相关不代表有效，失效认识和失败尝试不能直接沿用。`;
