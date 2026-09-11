/**
 * 归档看板：已经归档的交接单。
 *
 * 埋入的问题 `empty-state`：没有归档内容时只显示一句「还没有归档内容。」，不给任何下一步，于是
 * 大部分人看一眼就走了（完成率 0.34，且没有集中放弃的步骤）。
 *
 * 页脚这个「批量导出」链接是它当前唯一的入口，也就是 `buried-entrance` 的另一半。
 */
export const archive = {
  id: 'archive',
  title: '归档看板',
  /** 归档为空时显示的内容。 */
  emptyState() {
    return '<p>还没有归档内容。</p>';
  },
  render(records = []) {
    const body = records.length
      ? `<ul>${records.map((row) => `<li>${row}</li>`).join('')}</ul>`
      : archive.emptyState();
    return `<h1>${archive.title}</h1>${body}<footer><a href="/f/bulkexport">批量导出</a></footer>`;
  },
};
