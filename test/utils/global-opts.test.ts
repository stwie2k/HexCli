import { describe, it, expect, beforeEach } from 'vitest';
import { setGlobalUdid, getGlobalUdid } from '../../src/utils/global-opts.js';

describe('global-opts', () => {
  beforeEach(() => {
    // 每个用例前重置状态
    setGlobalUdid(undefined);
  });

  describe('getGlobalUdid', () => {
    it('初始值为 undefined', () => {
      expect(getGlobalUdid()).toBeUndefined();
    });
  });

  describe('setGlobalUdid', () => {
    it('设置后可读取', () => {
      setGlobalUdid('00008120-001A2C3E1F90401E');
      expect(getGlobalUdid()).toBe('00008120-001A2C3E1F90401E');
    });

    it('空字符串视为清除（返回 undefined）', () => {
      setGlobalUdid('abc');
      setGlobalUdid('');
      expect(getGlobalUdid()).toBeUndefined();
    });

    it('纯空白字符串视为清除', () => {
      setGlobalUdid('   ');
      expect(getGlobalUdid()).toBeUndefined();
    });

    it('前后空白被 trim', () => {
      setGlobalUdid('  device-001  ');
      expect(getGlobalUdid()).toBe('device-001');
    });

    it('undefined 清除已有值', () => {
      setGlobalUdid('device-001');
      setGlobalUdid(undefined);
      expect(getGlobalUdid()).toBeUndefined();
    });

    it('多次赋值以最后一次为准', () => {
      setGlobalUdid('first');
      setGlobalUdid('second');
      setGlobalUdid('third');
      expect(getGlobalUdid()).toBe('third');
    });
  });
});
