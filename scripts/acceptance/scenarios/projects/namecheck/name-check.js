// 首次使用时给团队起一个名字。整条首次使用流程只在这里校验一次，所以这一个函数决定了
// 有多少人能走完首次使用。
const LIMIT = 32;

/**
 * v1：只接受 ASCII 字母、数字、空格和连字符。国际化名称在这里被整段拒绝，而全是空格的
 * 名字反而被当成有效。
 */
export function checkName(raw) {
  const name = String(raw ?? '');
  if (name.length > LIMIT) return { ok: false, reason: 'too_long' };
  if (!/^[A-Za-z0-9 -]*$/.test(name)) return { ok: false, reason: 'unsupported_characters' };
  return { ok: true, name };
}
