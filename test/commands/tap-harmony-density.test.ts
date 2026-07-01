import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

import { execSync } from 'child_process';
import {
  parseRenderServiceWidth,
  parseDisplayManagerDensity,
  getHarmonyDensityFactor,
} from '../../src/commands/tap.js';

const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  mockedExecSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseRenderServiceWidth', () => {
  it('解析 physical resolution', () => {
    const out = '... physical resolution=1260x2720 ...';
    expect(parseRenderServiceWidth(out)).toBe(1260);
  });

  it('解析 render resolution（physical resolution 缺失时）', () => {
    const out = '... render resolution=1260x2720 ...';
    expect(parseRenderServiceWidth(out)).toBe(1260);
  });

  it('解析 supportedMode[0]', () => {
    const out = '...\nsupportedMode[0]: 1260x2720, refreshRate=120\n...';
    expect(parseRenderServiceWidth(out)).toBe(1260);
  });

  it('解析 activeMode', () => {
    const out = '...\nactiveMode: 1260x2720, refreshRate=60\n...';
    expect(parseRenderServiceWidth(out)).toBe(1260);
  });

  it('无法解析时返回 undefined', () => {
    const out = 'screen[0]: id=0, powerstatus=';
    expect(parseRenderServiceWidth(out)).toBeUndefined();
  });
});

describe('parseDisplayManagerDensity', () => {
  it('解析 DensityInCurResolution', () => {
    mockedExecSync.mockReturnValue('DensityInCurResolution: 3.25\nDensity: 3.0');
    expect(parseDisplayManagerDensity('DUMMY_UDID')).toBe(3.25);
  });

  it('DensityInCurResolution 缺失时回退到 Density', () => {
    mockedExecSync.mockReturnValue('Density: 3.0');
    expect(parseDisplayManagerDensity('DUMMY_UDID')).toBe(3);
  });

  it('DMS 命令失败时返回 undefined', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('command failed');
    });
    expect(parseDisplayManagerDensity('DUMMY_UDID')).toBeUndefined();
  });
});

describe('getHarmonyDensityFactor', () => {
  it('Mate 60 Pro 完整输出：通过 physical resolution 和 phyWidth 计算', () => {
    const rsOut =
      'screen[0]: ... physical resolution=1260x2720 ...\nname=, phyWidth=72, phyHeight=156';
    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('RenderService')) return rsOut;
      return '';
    }) as any);

    // dpi = (1260 / 72) * 25.4 ≈ 444.5, factor = 444.5 / 160 ≈ 2.778
    expect(getHarmonyDensityFactor('MATE60PRO')).toBeCloseTo(2.78, 1);
  });

  it('Mate XT 类输出：RenderService 无 resolution 但 DMS 有 Density', () => {
    const rsOut = 'screen[0]: id=0, powerstatus=';
    const dmsOut = 'Density: 3.25';
    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('RenderService')) return rsOut;
      if (cmd.includes('DisplayManagerService')) return dmsOut;
      return '';
    }) as any);

    expect(getHarmonyDensityFactor('MATEXT')).toBe(3.25);
  });

  it('完全无法获取时使用默认值 3', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('command failed');
    });

    expect(getHarmonyDensityFactor('UNKNOWN')).toBe(3);
  });
});
