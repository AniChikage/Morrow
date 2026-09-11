/**
 * 归档看板：已经归档的交接单。
 *
 * 补丁 2 修掉 `empty-state`：空状态给出明确的下一步（去交接导入建第一张单），而不是只说一句
 * 「还没有归档内容。」。
 *
 * 页脚的「批量导出」链接保留：补丁 1 之后它已经不是唯一入口，但原有路径不被破坏。
 */
export const archive = {
  id: 'archive',
  title: '归档看板',
  /** 归档为空时显示的内容，带一个下一步。 */
  emptyState() {
    return '<p>还没有归档内容。</p><p>先去<a href="/f/handover">交接导入</a>建第一张交接单，完成后会出现在这里。</p>';
  },
  render(records = []) {
    const body = records.length
      ? `<ul>${records.map((row) => `<li>${row}</li>`).join('')}</ul>`
      : archive.emptyState();
    return `<h1>${archive.title}</h1>${body}<footer><a href="/f/bulkexport">批量导出</a></footer>`;
  },
};
