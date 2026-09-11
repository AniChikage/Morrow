/**
 * 首页：功能入口列表。
 *
 * 补丁 1 修掉 `buried-entrance`：把「批量导出」放进首页入口，它不再只能从归档看板页脚三次点击
 * 才能到。页脚那个链接保留，原来的路径不被破坏。
 */
export const home = {
  id: 'home',
  title: '交接台',
  /** 首页直接给出的入口，现在包含批量导出。 */
  entrances: ['handover', 'archive', 'bulkexport', 'sharelink', 'taxreport'],
  render(pages) {
    const rows = home.entrances.map((id) => `<li><a href="/f/${id}">${pages[id].title}</a></li>`).join('');
    return `<h1>${home.title}</h1><ul>${rows}</ul><p>其他操作请先进入<a href="/f/archive">归档看板</a>。</p>`;
  },
};
