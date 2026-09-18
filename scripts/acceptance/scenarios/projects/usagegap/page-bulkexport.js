/**
 * 批量导出：把选中的交接单导出成一个压缩包。
 *
 * 这个页面本身没有问题——`buried-entrance` 埋在它的入口上（见 `page-home.js` 与
 * `page-archive.js`）。四个补丁都不修改这个文件。
 */
export const bulkexport = {
  id: 'bulkexport',
  title: '批量导出',
  render() {
    return `<h1>${bulkexport.title}</h1><form><label>选择日期范围<input name="range"></label><button>导出</button></form>`;
  },
};
