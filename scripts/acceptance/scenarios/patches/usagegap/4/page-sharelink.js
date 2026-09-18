/**
 * 分享链接：为一张交接单生成可访问的链接。
 *
 * 补丁 4 修掉 `misleading-copy`：按钮文案改成实际的范围（团队内可见），不再承诺「分享给所有人」。
 * 改的是文案，不是行为——`createLink` 生成的链接范围一直就是团队内。
 */
export const sharelink = {
  id: 'sharelink',
  title: '分享链接',
  /** 按钮文案，与 `createLink` 的实际范围一致。 */
  action: '生成团队内可见的链接',
  /** 实际生成的链接：只有团队成员能打开。 */
  createLink(id) {
    return { url: `/团队/交接单/${id}`, audience: 'team' };
  },
  render() {
    return `<h1>${sharelink.title}</h1><button>${sharelink.action}</button>`;
  },
};
