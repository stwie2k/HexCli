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
import { getHarmonyScreenSize } from '../../src/commands/screen.js';

const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  mockedExecSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getHarmonyScreenSize', () => {
  it('Mate 60 Pro: 1260x2720 px + density 3 → 420x907 vp', () => {
    const rsOut =
      'screen[0]: id=0, name=DefaultScreen, ...\n' +
      '  physical resolution=1260x2720\n' +
      '  phyWidth=72, phyHeight=156\n' +
      '  name=, phyWidth=72, phyHeight=156';

    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('RenderService')) return rsOut;
      return '';
    }) as any);

    // phyWidth=72mm → dpi = (1260/72)*25.4 ≈ 444.5, factor ≈ 2.778
    // width = round(1260 / 2.778) ≈ 453, height = round(2720 / 2.778) ≈ 979
    const result = getHarmonyScreenSize('MATE60_SCREEN');
    expect(result.density).toBeCloseTo(2.78, 1);
    expect(result.width).toBeGreaterThan(400);
    expect(result.width).toBeLessThan(500);
    expect(result.height).toBeGreaterThan(900);
    expect(result.height).toBeLessThan(1050);
  });

  it('仅 DMS 有 density 时，仍通过 RenderService 获取分辨率', () => {
    const rsOut =
      'screen[0]: id=0\n' +
      '  physical resolution=1080x2340\n';
    const dmsOut = 'Density: 3.0\nDensityInCurResolution: 3.0';

    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('RenderService')) return rsOut;
      if (cmd.includes('DisplayManagerService')) return dmsOut;
      return '';
    }) as any);

    const result = getHarmonyScreenSize('DMS_SCREEN');
    expect(result.density).toBe(3);
    expect(result.width).toBe(360);  // 1080 / 3
    expect(result.height).toBe(780); // 2340 / 3
  });

  it('RenderService 无分辨率时抛出错误', () => {
    const rsOut = 'screen[0]: id=0, powerstatus=';

    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('RenderService')) return rsOut;
      if (cmd.includes('DisplayManagerService')) return 'Density: 3.0';
      return '';
    }) as any);

    expect(() => getHarmonyScreenSize('NORES_SCREEN')).toThrow(
      '无法从 RenderService 解析物理分辨率',
    );
  });

  it('RenderService 命令异常时抛出错误', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('hdc not found');
    });

    expect(() => getHarmonyScreenSize('ERR_SCREEN')).toThrow();
  });
});
