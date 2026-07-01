import { describe, it, expect } from 'vitest';
import { isSafeUdid, assertSafeUdid } from '../../src/utils/udid-safe.js';

describe('isSafeUdid', () => {
  // ── 合法输入 ──────────────────────────────────────────────────────────────
  it('接受典型 iOS UDID（十六进制 + 连字符）', () => {
    expect(isSafeUdid('00008120-001A2C3E1F90401E')).toBe(true);
    expect(isSafeUdid('ABCDEF1234567890')).toBe(true);
  });

  it('接受 adb USB serial（纯字母数字）', () => {
    expect(isSafeUdid('emulator-5554')).toBe(true);
    expect(isSafeUdid('R5CT900ABCD')).toBe(true);
  });

  it('接受 adb WiFi serial（含点号和冒号）', () => {
    expect(isSafeUdid('192.168.1.10:5555')).toBe(true);
  });

  it('接受含下划线的序列号', () => {
    expect(isSafeUdid('simulator_001')).toBe(true);
  });

  it('接受单字符', () => {
    expect(isSafeUdid('a')).toBe(true);
    expect(isSafeUdid('0')).toBe(true);
  });

  it('接受 128 字符（最大长度）', () => {
    const udid = 'a'.repeat(128);
    expect(isSafeUdid(udid)).toBe(true);
  });

  // ── 非法输入 ──────────────────────────────────────────────────────────────
  it('拒绝空字符串', () => {
    expect(isSafeUdid('')).toBe(false);
  });

  it('拒绝超过 128 字符', () => {
    expect(isSafeUdid('a'.repeat(129))).toBe(false);
  });

  it('拒绝非字符串类型', () => {
    expect(isSafeUdid(null)).toBe(false);
    expect(isSafeUdid(undefined)).toBe(false);
    expect(isSafeUdid(12345)).toBe(false);
    expect(isSafeUdid({})).toBe(false);
    expect(isSafeUdid([])).toBe(false);
  });

  it('拒绝含 shell 元字符的注入攻击', () => {
    expect(isSafeUdid('0001"; rm -rf $HOME #')).toBe(false);
    expect(isSafeUdid('abc`whoami`')).toBe(false);
    expect(isSafeUdid('abc$(echo pwned)')).toBe(false);
    expect(isSafeUdid('a;b')).toBe(false);
    expect(isSafeUdid('a|b')).toBe(false);
    expect(isSafeUdid('a&b')).toBe(false);
    expect(isSafeUdid('a>b')).toBe(false);
    expect(isSafeUdid('a<b')).toBe(false);
    expect(isSafeUdid("a'b")).toBe(false);
    expect(isSafeUdid('a"b')).toBe(false);
    expect(isSafeUdid('a\\b')).toBe(false);
    expect(isSafeUdid('a*b')).toBe(false);
    expect(isSafeUdid('a?b')).toBe(false);
    expect(isSafeUdid('a(b')).toBe(false);
    expect(isSafeUdid('a{b')).toBe(false);
    expect(isSafeUdid('a[b')).toBe(false);
  });

  it('拒绝含空白字符', () => {
    expect(isSafeUdid('abc def')).toBe(false);
    expect(isSafeUdid('abc\tdef')).toBe(false);
    expect(isSafeUdid('\n')).toBe(false);
  });
});

describe('assertSafeUdid', () => {
  it('合法时返回原始字符串', () => {
    expect(assertSafeUdid('00008120-001A2C3E1F90401E')).toBe('00008120-001A2C3E1F90401E');
    expect(assertSafeUdid('192.168.1.10:5555')).toBe('192.168.1.10:5555');
  });

  it('非法时抛出 Error', () => {
    expect(() => assertSafeUdid('')).toThrow('udid/serial 含非法字符或长度异常');
    expect(() => assertSafeUdid(null)).toThrow('udid/serial 含非法字符或长度异常');
    expect(() => assertSafeUdid('abc;rm -rf')).toThrow('udid/serial 含非法字符或长度异常');
    expect(() => assertSafeUdid('a'.repeat(129))).toThrow('udid/serial 含非法字符或长度异常');
  });

  it('错误信息中包含原始值', () => {
    expect(() => assertSafeUdid('bad;input')).toThrow('"bad;input"');
  });
});
