import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// child_process 整体 mock，避免真实调用 hdc / adb / xcrun
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// launcher.ts 用 `import * as logger from './logger.js'`，mock 命名导出即可
vi.mock('../../src/utils/logger.js', () => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

import { execSync } from 'child_process';
import { launchHarmonyOSApp, launchByUdid } from '../../src/utils/launcher.js';

const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  mockedExecSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============ launchHarmonyOSApp ============

describe('launchHarmonyOSApp', () => {
  it('正常路径：依次调用 which hdc / aa force-stop / aa start，参数注入正确', () => {
    mockedExecSync.mockImplementation(((cmd: string) => {
      // aa start 成功时 hdc 返回 "start ability successfully."
      if (cmd.includes('aa start')) return 'start ability successfully.';
      return Buffer.from('');
    }) as any);

    launchHarmonyOSApp(
      'com.example.app',
      'ws://192.168.1.5:12588',
      'FMR0223C13000649',
    );

    const calls = mockedExecSync.mock.calls.map((c) => c[0] as string);

    // hdc 可用性探测
    expect(calls.some((c) => c.includes('which hdc'))).toBe(true);

    // force-stop 旧进程
    expect(
      calls.some((c) =>
        c.includes('hdc -t FMR0223C13000649 shell aa force-stop com.example.app'),
      ),
    ).toBe(true);

    // aa start：Ability + bundleId + Want 参数三件套
    const startCmd = calls.find((c) => c.includes('aa start'));
    expect(startCmd).toBeDefined();
    expect(startCmd).toContain('hdc -t FMR0223C13000649');
    expect(startCmd).toContain('-a EntryAbility');
    expect(startCmd).toContain('-b com.example.app');
    expect(startCmd).toContain('-d FMR0223C13000649');
    expect(startCmd).toContain('--ps Hex_XCTest_Web_Server_Ip ws://192.168.1.5:12588');
    expect(startCmd).toContain('--ps Hex_Device_UDID FMR0223C13000649');
  });

  it('hdc 未安装时调用 process.exit(1)', () => {
    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('which hdc')) throw new Error('command not found');
      return Buffer.from('');
    }) as any);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    expect(() => launchHarmonyOSApp('a', 'b', 'c')).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    // hdc 探测失败后不应继续调 aa
    const calls = mockedExecSync.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('aa start'))).toBe(false);
  });

  it('aa force-stop 失败时被吞掉，不影响后续 aa start', () => {
    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('force-stop')) throw new Error('not running');
      if (cmd.includes('aa start')) return 'start ability successfully.';
      return Buffer.from('');
    }) as any);

    expect(() =>
      launchHarmonyOSApp('com.test', 'ws://1.2.3.4:1', 'DEV001'),
    ).not.toThrow();

    const calls = mockedExecSync.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('aa start'))).toBe(true);
  });

  it('aa start 失败时调用 process.exit(1) 并打 error', () => {
    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('which hdc')) return Buffer.from('');
      if (cmd.includes('force-stop')) return Buffer.from('');
      // aa start 失败
      throw new Error('aa start failed: ability not found');
    }) as any);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    expect(() => launchHarmonyOSApp('a', 'b', 'c')).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('aa start 返回 exit code 0 但 stdout 含 error 时也应当报错（应用未安装场景）', () => {
    mockedExecSync.mockImplementation(((cmd: string) => {
      if (cmd.includes('which hdc')) return Buffer.from('');
      if (cmd.includes('force-stop')) return Buffer.from('');
      // hdc shell aa start 在应用未安装时返回 exit code 0，但 stdout 含错误信息
      return 'error: failed to start ability.\nError Code:10104001  Error Message:The specified ability does not exist';
    }) as any);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    expect(() => launchHarmonyOSApp('com.fake', 'ws://1.2.3.4:1', 'DEV001')).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ============ launchByUdid 三路分支 ============

describe('launchByUdid 平台分支', () => {
  /**
   * mock listLocalDevices 的三路本机枚举：
   * - xcrun xctrace list devices  → iOS 列表
   * - adb devices -l              → Android 列表
   * - hdc list targets            → HarmonyOS 列表
   * - hdc -t <udid> shell param get const.product.name → 设备型号
   *
   * 然后把 launchHarmonyOSApp / launchAndroidApp / launchIOSApp 路径上的
   * 子命令一律返回空 Buffer 当作成功。
   */
  function setupMock(opts: {
    iosUdid?: string;
    androidUdid?: string;
    harmonyUdid?: string;
  }): void {
    mockedExecSync.mockImplementation(((cmd: string) => {
      // ── 设备枚举 ──
      if (cmd.includes('xctrace list devices')) {
        return opts.iosUdid
          ? `== Devices ==\niPhone 15 (17.0) (${opts.iosUdid})\n== Simulators ==\n`
          : '== Devices ==\n== Simulators ==\n';
      }
      if (cmd.includes('adb devices -l')) {
        return opts.androidUdid
          ? `List of devices attached\n${opts.androidUdid}\tdevice product:x model:Pixel device:y\n`
          : 'List of devices attached\n';
      }
      if (cmd.includes('hdc list targets')) {
        return opts.harmonyUdid ? `${opts.harmonyUdid}\n` : '';
      }
      if (cmd.includes('const.product.name')) return 'Mate60';

      // ── 启动相关都视为成功 ──
      // aa start 成功时 hdc 返回 "start ability successfully."
      if (cmd.includes('aa start')) return 'start ability successfully.';
      return Buffer.from('');
    }) as any);
  }

  it('harmonyos 设备命中 → 走 hdc aa start，不调 adb / xcrun devicectl', async () => {
    setupMock({ harmonyUdid: 'HARMONY_001' });

    const device = await launchByUdid('com.test', 'ws://1.2.3.4:1', 'HARMONY_001');
    expect(device.platform).toBe('harmonyos');

    const calls = mockedExecSync.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('hdc -t HARMONY_001 shell aa start'))).toBe(true);
    // 不应误调 Android / iOS 启动命令
    expect(calls.some((c) => /^adb -s [^ ]+ shell am /.test(c))).toBe(false);
    expect(calls.some((c) => c.includes('xcrun devicectl device process launch'))).toBe(false);
  });

  it('android 设备命中 → 走 adb am start', async () => {
    setupMock({ androidUdid: 'ANDROID_001' });

    const device = await launchByUdid('com.test', 'ws://1.2.3.4:1', 'ANDROID_001');
    expect(device.platform).toBe('android');

    const calls = mockedExecSync.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('adb -s ANDROID_001'))).toBe(true);
    expect(calls.some((c) => c.includes('hdc -t ANDROID_001 shell aa start'))).toBe(false);
  });

  it('udid 未连接到本机时抛错', async () => {
    setupMock({}); // 三个平台都空

    await expect(
      launchByUdid('com.test', 'ws://1.2.3.4:1', 'NOT_CONNECTED'),
    ).rejects.toThrow('udid NOT_CONNECTED 未连接到本机');

    // 不应调用任何启动命令
    const calls = mockedExecSync.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('aa start'))).toBe(false);
    expect(calls.some((c) => c.includes('am start'))).toBe(false);
    expect(calls.some((c) => c.includes('devicectl device process launch'))).toBe(false);
  });
});
