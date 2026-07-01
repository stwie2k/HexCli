import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import {
  VALID_PLATFORMS,
  type DeviceHello,
  type DeviceClient,
  type DeviceClientPublic,
} from '../types/device.js';

// re-export 保持下游 import 路径不变（src/daemon/*、src/commands/*、src/utils/selector 等）
export type { DeviceHello, DeviceClient, DeviceClientPublic } from '../types/device.js';

interface PendingCallback {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 仅当目标设备的 ws 仍在 registry 中时才视为有效 */
  targetDeviceId: string;
  /** 发出该命令时使用的 ws，用于精确匹配旧连接上的命令 */
  sourceWs: WebSocket;
}

/** Hello 超时常量 */
const HELLO_TIMEOUT_MS = 1000;
/** 命令默认超时 */
const COMMAND_TIMEOUT_MS = 10000;
/** 心跳扫描间隔 */
const HEARTBEAT_SWEEP_INTERVAL_MS = 30_000;
/** 心跳过期阈值 */
const HEARTBEAT_STALE_MS = 60_000;

/**
 * 设备注册表：连接 <-> 设备身份的双向索引。
 * 未注册连接放在 pending 集合中，超时未发 hello 即被回收。
 */
class DeviceRegistry {
  private byId: Map<string, { client: DeviceClient; ws: WebSocket }> = new Map();
  private byWs: WeakMap<WebSocket, string> = new WeakMap();
  private pending: Map<WebSocket, ReturnType<typeof setTimeout>> = new Map();

  addPending(ws: WebSocket, timer: ReturnType<typeof setTimeout>): void {
    this.pending.set(ws, timer);
  }

  hasPending(ws: WebSocket): boolean {
    return this.pending.has(ws);
  }

  /**
   * 注册（或替换）设备。
   * 返回被替换的旧 ws（若存在），调用方负责关闭。
   *
   * 特殊处理：如果同一个 ws 之前以不同 deviceId 注册过
   * （如 legacy fallback → 真实 hello），会先清理旧 deviceId 条目，
   * 避免 byId 中存在幽灵记录导致心跳扫描误杀活跃连接。
   */
  register(ws: WebSocket, hello: DeviceHello): { replaced: WebSocket | null } {
    // 取消 pending 超时
    const timer = this.pending.get(ws);
    if (timer) clearTimeout(timer);
    this.pending.delete(ws);

    // 清理同一个 ws 上之前以不同 deviceId 注册的旧条目（legacy fallback 场景）
    const prevDeviceId = this.byWs.get(ws);
    if (prevDeviceId && prevDeviceId !== hello.deviceId) {
      const prevEntry = this.byId.get(prevDeviceId);
      if (prevEntry && prevEntry.ws === ws) {
        this.byId.delete(prevDeviceId);
      }
    }

    const existing = this.byId.get(hello.deviceId);
    let replaced: WebSocket | null = null;
    if (existing && existing.ws !== ws) {
      replaced = existing.ws;
    }

    const now = Date.now();
    const client: DeviceClient = {
      deviceId: hello.deviceId,
      platform: hello.platform,
      deviceName: hello.deviceName,
      osVersion: hello.osVersion,
      bundleId: hello.bundleId,
      appVersion: hello.appVersion,
      sdkVersion: hello.sdkVersion,
      connectedAt: now,
      lastSeenAt: now,
    };
    this.byId.set(hello.deviceId, { client, ws });
    this.byWs.set(ws, hello.deviceId);
    return { replaced };
  }

  /** 通过 deviceId 取 ws + client */
  get(deviceId: string): { client: DeviceClient; ws: WebSocket } | null {
    return this.byId.get(deviceId) ?? null;
  }

  /** 通过 ws 反查 deviceId */
  getDeviceIdByWs(ws: WebSocket): string | null {
    return this.byWs.get(ws) ?? null;
  }

  /**
   * 连接断开时清理。
   * 返回 { deviceId, isCurrentWs }：
   *   - deviceId: 该连接关联的设备 ID
   *   - isCurrentWs: 是否是该 deviceId 当前活跃的 ws
   *     （false 表示已被新连接替换，close 只是旧 ws 的延迟清理）
   */
  removeByWs(ws: WebSocket): { deviceId: string | null; isCurrentWs: boolean } {
    // pending 也清掉
    const timer = this.pending.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.pending.delete(ws);
    }
    const deviceId = this.byWs.get(ws);
    if (!deviceId) return { deviceId: null, isCurrentWs: false };
    const entry = this.byId.get(deviceId);
    // 仅当 byId 里映射的还是这条 ws 时才删（避免重连后误删新连接）
    let isCurrentWs = false;
    if (entry && entry.ws === ws) {
      this.byId.delete(deviceId);
      isCurrentWs = true;
    }
    this.byWs.delete(ws);
    return { deviceId, isCurrentWs };
  }

  /** 心跳：刷新 lastSeenAt */
  touch(ws: WebSocket): void {
    const deviceId = this.byWs.get(ws);
    if (!deviceId) return;
    const entry = this.byId.get(deviceId);
    if (entry) entry.client.lastSeenAt = Date.now();
  }

  /** 列出全部已注册设备（剥离 ws） */
  list(): DeviceClientPublic[] {
    return Array.from(this.byId.values()).map(({ client }) => ({ ...client }));
  }

  count(): number {
    return this.byId.size;
  }

  /** 扫描超过阈值未心跳的设备 */
  collectStale(now: number, thresholdMs: number): WebSocket[] {
    const stale: WebSocket[] = [];
    for (const { client, ws } of this.byId.values()) {
      if (now - client.lastSeenAt > thresholdMs) {
        stale.push(ws);
      }
    }
    return stale;
  }

  /** 关闭所有连接（含 pending） */
  closeAll(): void {
    for (const [ws, timer] of this.pending) {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
    }
    this.pending.clear();
    for (const { ws } of this.byId.values()) {
      try {
        ws.close();
      } catch {}
    }
    this.byId.clear();
  }
}

export class CommandSocket extends EventEmitter {
  private server: WebSocketServer | null = null;
  private registry = new DeviceRegistry();
  private pendingCallbacks: Map<string, PendingCallback> = new Map();
  private port: number;
  private connectionResolvers: Array<() => void> = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private legacyCounter = 0;

  constructor(port: number = 12588) {
    super();
    this.port = port;
  }

  /**
   * 启动 WebSocket Server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({ port: this.port }, () => {
        logger.info(`WebSocket Server 已启动，监听端口 ${this.port}`);
        resolve();
      });

      this.server.on('error', (err) => {
        logger.error(`WebSocket Server 错误: ${err.message}`);
        reject(err);
      });

      this.server.on('connection', (ws) => this.handleConnection(ws));

      // 心跳扫描：定期回收 60s 未心跳的连接
      this.heartbeatTimer = setInterval(() => {
        const now = Date.now();
        const stale = this.registry.collectStale(now, HEARTBEAT_STALE_MS);
        for (const ws of stale) {
          const deviceId = this.registry.getDeviceIdByWs(ws);
          logger.warn(`设备 ${deviceId ?? 'unknown'} 心跳超时 (${HEARTBEAT_STALE_MS / 1000}s)，关闭连接`);
          try {
            ws.close(1001, 'heartbeat timeout');
          } catch {}
        }
      }, HEARTBEAT_SWEEP_INTERVAL_MS);
      this.heartbeatTimer.unref?.();
    });
  }

  /**
   * 处理新连接：放入 pending 集合，1s 内必须发 hello。
   * 如果超时，以 legacy 身份注册（兼容旧版 SDK）并提示升级。
   */
  private handleConnection(ws: WebSocket): void {
    const helloTimer = setTimeout(() => {
      if (!this.registry.hasPending(ws)) return;
      // 旧版 SDK 兼容：以 fallback 身份注册而非断开
      this.legacyCounter++;
      const fallbackId = `legacy-${this.legacyCounter}`;
      const fallbackHello: DeviceHello = {
        type: 'hello',
        deviceId: fallbackId,
        platform: 'android',
        deviceName: 'Legacy Device',
        sdkVersion: 'unknown',
      };
      this.handleHello(ws, fallbackHello);
      logger.warn(
        `设备连接 1s 内未发送 hello，已以兼容模式注册 (${fallbackId})。请尽快升级 SDK 至 1.0.0`,
      );
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    this.registry.addPending(ws, helloTimer);

    ws.on('message', (rawData) => {
      this.handleMessage(ws, rawData.toString());
    });

    // 监听 WebSocket 协议层 pong 帧（OkHttp pingInterval 触发），刷新心跳
    ws.on('pong', () => {
      this.registry.touch(ws);
    });

    ws.on('close', () => {
      const { deviceId, isCurrentWs } = this.registry.removeByWs(ws);
      if (deviceId && isCurrentWs) {
        // 设备真正下线（非被新连接替换），失败该设备上所有挂起命令
        logger.warn(`设备 ${deviceId} 已断开 (当前在线: ${this.registry.count()})`);
        this.failPendingForDevice(deviceId, '设备连接已断开');
      } else if (deviceId) {
        // 旧连接关闭（已被新连接替换），只清理该 ws 上发出的命令
        this.failPendingForWs(ws, '旧连接已关闭');
      }
    });

    ws.on('error', (err) => {
      logger.error(`客户端连接错误: ${err.message}`);
      this.registry.removeByWs(ws);
    });
  }

  /**
   * 处理设备返回的消息：hello / heart / 业务回包 / 推送
   */
  private handleMessage(ws: WebSocket, raw: string): void {
    const messageStr = raw.trim();

    // 心跳：刷新 lastSeenAt
    if (messageStr === 'heart' || messageStr === 'ping' || messageStr === 'pong') {
      this.registry.touch(ws);
      return;
    }

    // 非 JSON 格式忽略
    if (!messageStr.startsWith('{') && !messageStr.startsWith('[')) {
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(messageStr);
    } catch {
      return;
    }

    // hello 注册帧
    if (msg && msg.type === 'hello' && typeof msg.deviceId === 'string') {
      this.handleHello(ws, msg as DeviceHello);
      return;
    }

    // 未注册的非 hello 消息：丢弃（pending 期不接受业务消息）
    const deviceId = this.registry.getDeviceIdByWs(ws);
    if (!deviceId) return;

    // 业务消息：刷新心跳
    this.registry.touch(ws);

    // 业务回包：通过 uuid 匹配 pendingCallbacks
    if (msg.uuid && this.pendingCallbacks.has(msg.uuid)) {
      const pending = this.pendingCallbacks.get(msg.uuid)!;
      // 校验回包 deviceId 与目标一致（端侧若未带 deviceId 则跳过校验）
      if (msg.deviceId && msg.deviceId !== pending.targetDeviceId) {
        logger.warn(
          `回包 deviceId(${msg.deviceId}) 与请求目标(${pending.targetDeviceId}) 不一致，忽略`,
        );
        return;
      }
      clearTimeout(pending.timer);
      this.pendingCallbacks.delete(msg.uuid);
      pending.resolve(msg.result);
      return;
    }

    // 设备主动推送（debug 流：UT、mtop、AppLog 等）
    if (msg.command) {
      const data = msg.result ?? msg.data ?? msg;
      this.emit('push', { deviceId, command: msg.command, data });
    }
  }

  /**
   * 处理 hello 注册：登记设备、关闭被替换的旧连接、回 ack。
   */
  private handleHello(ws: WebSocket, hello: DeviceHello): void {
    if (!VALID_PLATFORMS.has(hello.platform)) {
      logger.warn(`设备 hello 平台非法: ${hello.platform}`);
      try {
        ws.close(4002, 'invalid platform');
      } catch {}
      return;
    }

    const { replaced } = this.registry.register(ws, hello);
    if (replaced) {
      logger.warn(`设备 ${hello.deviceId} 重连，关闭旧连接`);
      try {
        replaced.close(4003, 'replaced by reconnect');
      } catch {}
      // 旧连接上挂起命令立即失败
      this.failPendingForWs(replaced, '设备已重连，旧连接被替换');
    }

    logger.success(
      `设备已注册: ${hello.deviceId} (${hello.platform}·${hello.deviceName ?? '-'}) 当前在线: ${this.registry.count()}`,
    );

    try {
      ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
    } catch {}

    // 通知等待连接的调用者
    for (const resolver of this.connectionResolvers) {
      resolver();
    }
    this.connectionResolvers = [];
  }

  /**
   * 等待至少一个设备注册成功。
   */
  waitForConnection(timeoutMs: number = 30000): Promise<void> {
    if (this.registry.count() > 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`等待设备连接超时 (${timeoutMs / 1000}s)`));
      }, timeoutMs);
      this.connectionResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * 等待指定 udid 的设备注册成功。
   * 若已经在线立即返回；否则轮询 registry 直到超时。
   */
  waitForDevice(udid: string, timeoutMs: number = 30000): Promise<void> {
    if (this.registry.get(udid)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (this.registry.get(udid)) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`等待设备 ${udid} 连接超时 (${timeoutMs / 1000}s)`));
        }
      }, 200);
      timer.unref?.();
    });
  }

  /**
   * 单设备定向下发命令并等待响应。
   * target 必填：上层 selector 已确保唯一目标。
   */
  dispatch(
    command: string,
    params: Record<string, any> | undefined,
    target: string,
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const entry = this.registry.get(target);
      if (!entry) {
        reject(new Error(`设备 ${target} 未在线`));
        return;
      }
      if (entry.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`设备 ${target} 连接异常 (readyState=${entry.ws.readyState})`));
        return;
      }

      const uuid = uuidv4();
      const message = JSON.stringify({
        command,
        uuid,
        deviceId: target,
        params: params || {},
      });

      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(uuid);
        reject(new Error(`命令 "${command}" 在设备 ${target} 上响应超时 (${timeoutMs / 1000}s)`));
      }, timeoutMs);

      this.pendingCallbacks.set(uuid, {
        resolve,
        reject,
        timer,
        targetDeviceId: target,
        sourceWs: entry.ws,
      });

      entry.ws.send(Buffer.from(message));
    });
  }

  /**
   * 兼容入口：旧调用 `sendCommand(cmd, params)` -> 单设备直发。
   * 仅供过渡期使用：必须刚好有一台设备在线，否则直接抛错。
   */
  sendCommand(command: string, params?: Record<string, any>): Promise<any> {
    const devices = this.registry.list();
    if (devices.length === 0) {
      return Promise.reject(new Error('没有已连接的设备'));
    }
    if (devices.length > 1) {
      return Promise.reject(
        new Error(
          `检测到 ${devices.length} 台设备在线，请使用 selector 指定目标 (--udid)`,
        ),
      );
    }
    return this.dispatch(command, params, devices[0].deviceId);
  }

  /** 列出当前已注册设备（公开数据） */
  listDevices(): DeviceClientPublic[] {
    return this.registry.list();
  }

  /** 主动断开指定 udid 的连接 */
  disconnectDevice(udid: string): boolean {
    const entry = this.registry.get(udid);
    if (!entry) return false;
    try {
      entry.ws.close(1000, 'disconnected by user');
    } catch {}
    return true;
  }

  /** 失败掉指定 ws 上发出的所有挂起命令（精确到连接级别，不影响新连接上的命令） */
  private failPendingForWs(ws: WebSocket, reason: string): void {
    for (const [uuid, pending] of this.pendingCallbacks) {
      if (pending.sourceWs === ws) {
        clearTimeout(pending.timer);
        this.pendingCallbacks.delete(uuid);
        pending.reject(new Error(reason));
      }
    }
  }

  /** 失败掉指定 deviceId 上所有挂起命令 */
  private failPendingForDevice(deviceId: string, reason: string): void {
    for (const [uuid, pending] of this.pendingCallbacks) {
      if (pending.targetDeviceId === deviceId) {
        clearTimeout(pending.timer);
        this.pendingCallbacks.delete(uuid);
        pending.reject(new Error(reason));
      }
    }
  }

  /**
   * 关闭 WebSocket Server
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      // 清理所有 pending callbacks
      for (const [, pending] of this.pendingCallbacks) {
        clearTimeout(pending.timer);
        pending.reject(new Error('连接已关闭'));
      }
      this.pendingCallbacks.clear();

      this.registry.closeAll();

      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** 当前已注册设备数 */
  get connectedCount(): number {
    return this.registry.count();
  }
}

// 单例实例
let instance: CommandSocket | null = null;

/**
 * 获取 CommandSocket 单例，确保 Server 已启动且有设备连接
 */
export async function getSocket(port: number = 12588): Promise<CommandSocket> {
  if (!instance) {
    instance = new CommandSocket(port);
    await instance.start();
  }
  return instance;
}
