/**
 * 首页：功能入口列表。
 *
 * 埋入的问题 `buried-entrance`：「批量导出」不在这份列表里。它唯一的入口在归档看板的页脚，要
 * 三次点击才能到，所以它一周只有个位数访问——不是因为没人需要它。
 */
export const home = {
  id: 'home',
  title: '交接台',
  /** 首页直接给出的入口。批量导出不在其中。 */
  entrances: ['handover', 'archive', 'sharelink', 'taxreport'],
  render(pages) {
    const rows = home.entrances.map((id) => `<li><a href="/f/${id}">${pages[id].title}</a></li>`).join('');
    return `<h1>${home.title}</h1><ul>${rows}</ul><p>其他操作请先进入<a href="/f/archive">归档看板</a>。</p>`;
  },
};
