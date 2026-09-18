/**
 * 税务报表：把一段时间的交接单导成税务申报格式。
 *
 * 这就是反例 `not-needed`：它的入口在首页第一屏，页面能走通，完成率 0.88，但一周只有 8 次访问，
 * 因为目标用户访谈里没有人要求过它（使用数据里 `askedFor: false`）。使用率低在这里不是缺陷，
 * 「修」它是错的；该做的是把它记成一条待验证的判断。四个补丁都不修改这个文件。
 */
export const taxreport = {
  id: 'taxreport',
  title: '税务报表',
  render() {
    return `<h1>${taxreport.title}</h1><form><label>申报期<input name="period"></label><button>生成报表</button></form>`;
  },
};
