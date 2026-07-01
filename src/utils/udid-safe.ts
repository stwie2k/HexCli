/**
 * udid / serial 安全校验。
 *
 * 背景：本工具会在多处把 --udid 参数拼到 shell 命令（xcrun / pymobiledevice3 / adb 等）。
 * 即便已逐步迁移到 execFileSync 走 argv，仍保留这一层入口校验作为兜底——
 * 若用户传入 `0001"; rm -rf $HOME #` 这类含 shell 元字符的字符串，直接拒绝。
 *
 * 允许字符集：
 *   - 十六进制 + 连字符（Apple iOS UDID）
 *   - 字母数字（adb USB serial）
 *   - 点号 / 冒号（adb wifi serial，例如 192.168.1.10:5555）
 *   - 下划线（兼容某些模拟器序列号）
 *
 * 显式禁用所有 shell 元字符：` $ ; | & > < " ' \ * ? ( ) { } [ ] 空白 反引号 等。
 * 长度上限 128 防止异常超长。
 */
const SAFE_UDID_RE = /^[0-9A-Za-z._:-]+$/;
const MAX_LEN = 128;

export function isSafeUdid(udid: unknown): udid is string {
  if (typeof udid !== 'string') return false;
  if (udid.length === 0 || udid.length > MAX_LEN) return false;
  return SAFE_UDID_RE.test(udid);
}

/**
 * 不合法时抛出明确错误（由调用方 catch 转换为 logger.error + exit）。
 * 合法 udid 直接返回，便于链式使用。
 */
export function assertSafeUdid(udid: unknown): string {
  if (!isSafeUdid(udid)) {
    throw new Error(
      `udid/serial 含非法字符或长度异常：${JSON.stringify(udid)}\n` +
        `仅允许：字母、数字、连字符、点号、冒号、下划线（长度 1-${MAX_LEN}）`,
    );
  }
  return udid;
}
