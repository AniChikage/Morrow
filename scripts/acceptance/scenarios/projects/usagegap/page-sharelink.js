/**
 * 分享链接：为一张交接单生成可访问的链接。
 *
 * 埋入的问题 `misleading-copy`：按钮写的是「分享给所有人」，`createLink` 实际只生成团队内可见的
 * 链接。文案承诺的范围比实际行为大，使用数据里它表现为 `copyMatchesBehaviour: false`。
 */
export const sharelink = {
  id: 'sharelink',
  title: '分享链接',
  /** 按钮文案。 */
  action: '分享给所有人',
  /** 实际生成的链接：只有团队成员能打开。 */
  createLink(id) {
    return { url: `/团队/交接单/${id}`, audience: 'team' };
  },
  render() {
    return `<h1>${sharelink.title}</h1><button>${sharelink.action}</button>`;
  },
};
