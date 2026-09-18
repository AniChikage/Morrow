/**
 * 应用自己记录的七天使用数据，`GET /usage` 直接返回它。
 *
 * 每个功能一行：访问次数、完成率、放弃发生在第几步（0 表示没有集中放弃的步骤），以及三条来自
 * 目标用户访谈与走查的记录——这个功能有没有被要求过、空状态有没有下一步、文案和实际行为是否一致。
 * 隔离验收的 fixture 模式读的是 harness 接收端上同一形状的样本，好让时间线控制它怎么变化；
 * live 模式读的就是这个端点。
 */
export const usage = {
  window: '7d',
  sessions: 1200,
  abandonedSessions: 96,
  generatedAt: '2026-02-02T09:00:00.000Z',
  features: {
    handover: {
      title: '交接导入',
      visits: 610,
      completionRate: 0.21,
      abandonStep: 2,
      askedFor: true,
      emptyStateNextAction: true,
      copyMatchesBehaviour: true,
    },
    bulkexport: {
      title: '批量导出',
      visits: 14,
      completionRate: 0.63,
      abandonStep: 0,
      askedFor: true,
      emptyStateNextAction: true,
      copyMatchesBehaviour: true,
    },
    archive: {
      title: '归档看板',
      visits: 330,
      completionRate: 0.34,
      abandonStep: 0,
      askedFor: true,
      emptyStateNextAction: false,
      copyMatchesBehaviour: true,
    },
    sharelink: {
      title: '分享链接',
      visits: 705,
      completionRate: 0.57,
      abandonStep: 0,
      askedFor: true,
      emptyStateNextAction: true,
      copyMatchesBehaviour: false,
    },
    taxreport: {
      title: '税务报表',
      visits: 8,
      completionRate: 0.88,
      abandonStep: 0,
      askedFor: false,
      emptyStateNextAction: true,
      copyMatchesBehaviour: true,
    },
  },
};
