// 首次使用时给团队起一个名字。整条首次使用流程只在这里校验一次，所以这一个函数决定了
// 有多少人能走完首次使用。
const LIMIT = 32;

/**
 * 补丁 1：按字符类别校验，接受 Unicode 字母与数字；去掉首尾空白后不能为空。
 * 长度上限仍然是 32，那是产品有意保留的约束，不在这次改动范围内。
 */
export function checkName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { ok: false, reason: 'blank' };
  if ([...name].length > LIMIT) return { ok: false, reason: 'too_long' };
  if (!/^[\p{L}\p{N} -]+$/u.test(name)) return { ok: false, reason: 'unsupported_characters' };
  return { ok: true, name };
}
