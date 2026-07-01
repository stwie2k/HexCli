/**
 * 设备相关公共类型 —— 跨 launcher（本地 USB 枚举）与 command-socket（Daemon WS 协议）共用。
 *
 * 设计动机：原本 platform 字段在 launcher.ts 与 command-socket.ts 两处独立定义，
 * 值域不一致（前者已含 harmonyos，后者只有 ios/android）。新增平台时易出现遗漏。
 * 抽到此公共类型文件后，新增平台只需改一处。
 */

/**
 * 设备平台标识。
 * - 本地 USB 枚举（launcher）和 Daemon WebSocket 协议（SDK hello）共用此类型。
 * - 新增平台时只需在此处修改一次。
 */
export type DevicePlatform = 'ios' | 'android' | 'harmonyos';

/**
 * 支持的平台白名单（运行时校验用）。
 * 与 DevicePlatform 类型保持一一对应；handleHello 等运行时校验入口直接 has() 即可。
 */
export const VALID_PLATFORMS: ReadonlySet<string> = new Set<DevicePlatform>([
  'ios',
  'android',
  'harmonyos',
]);

/** 本地 USB 枚举到的设备 */
export interface LocalDevice {
  udid: string;
  platform: DevicePlatform;
  name: string;
}

/** 端侧 hello 帧自报字段 */
export interface DeviceHello {
  type: 'hello';
  deviceId: string;
  platform: DevicePlatform;
  deviceName?: string;
  osVersion?: string;
  bundleId?: string;
  appVersion?: string;
  sdkVersion?: string;
}

/** daemon 维护的已注册设备 */
export interface DeviceClient {
  deviceId: string;
  platform: DevicePlatform;
  deviceName?: string;
  osVersion?: string;
  bundleId?: string;
  appVersion?: string;
  sdkVersion?: string;
  connectedAt: number;
  lastSeenAt: number;
}

/** 对外可序列化的设备信息（剥离 ws 引用） */
export interface DeviceClientPublic {
  deviceId: string;
  platform: DevicePlatform;
  deviceName?: string;
  osVersion?: string;
  bundleId?: string;
  appVersion?: string;
  sdkVersion?: string;
  connectedAt: number;
  lastSeenAt: number;
}
