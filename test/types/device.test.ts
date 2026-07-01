import { describe, it, expect } from 'vitest';
import { VALID_PLATFORMS, type DevicePlatform } from '../../src/types/device.js';

describe('VALID_PLATFORMS', () => {
  it('包含 ios / android / harmonyos 三个合法平台', () => {
    expect(VALID_PLATFORMS.has('ios')).toBe(true);
    expect(VALID_PLATFORMS.has('android')).toBe(true);
    expect(VALID_PLATFORMS.has('harmonyos')).toBe(true);
  });

  it('集合大小恰好为 3（与 DevicePlatform 类型一致）', () => {
    expect(VALID_PLATFORMS.size).toBe(3);
  });

  it('拒绝未支持的平台标识', () => {
    expect(VALID_PLATFORMS.has('windows')).toBe(false);
    expect(VALID_PLATFORMS.has('macos')).toBe(false);
    expect(VALID_PLATFORMS.has('')).toBe(false);
    expect(VALID_PLATFORMS.has('IOS')).toBe(false); // 大小写敏感
  });

  it('DevicePlatform 类型字面量与白名单条目一一对应（编译期校验）', () => {
    // 任一 DevicePlatform 字面量都应在白名单中（编译通过即测试通过）
    const platforms: DevicePlatform[] = ['ios', 'android', 'harmonyos'];
    for (const p of platforms) {
      expect(VALID_PLATFORMS.has(p)).toBe(true);
    }
  });
});
