import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 不真正起 WebSocket Server，只测试纯逻辑方法（与 src/socket/command-socket.test.ts 同款 mock）
vi.mock('ws', () => {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
    on = vi.fn();
    once = vi.fn();
    emit = vi.fn();
  }
  return {
    WebSocket: MockWebSocket,
    WebSocketServer: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      close: vi.fn((cb?: () => void) => cb?.()),
    })),
  };
});

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    json: vi.fn(),
    debug: vi.fn(),
  },
}));

import { CommandSocket } from '../../src/socket/command-socket.js';

let socket: CommandSocket;

beforeEach(() => {
  socket = new CommandSocket(0); // 端口 0，不真正 listen
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 构造一个 mock ws 对象，复用全局 vi.mock('ws') 的形状 */
function makeMockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
  } as any;
}

describe('CommandSocket.handleHello 平台校验（Task 1 鸿蒙支持）', () => {
  it('ios 设备 hello 正常注册，不触发 close', () => {
    const ws = makeMockWs();
    (socket as any).handleHello(ws, {
      type: 'hello',
      deviceId: 'ios-udid-1',
      platform: 'ios',
      deviceName: 'iPhone 15',
    });
    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'hello-ack', ok: true }));
    expect(socket.connectedCount).toBe(1);
    expect(socket.listDevices()[0]).toMatchObject({
      deviceId: 'ios-udid-1',
      platform: 'ios',
    });
  });

  it('android 设备 hello 正常注册', () => {
    const ws = makeMockWs();
    (socket as any).handleHello(ws, {
      type: 'hello',
      deviceId: 'android-serial-1',
      platform: 'android',
    });
    expect(ws.close).not.toHaveBeenCalled();
    expect(socket.connectedCount).toBe(1);
    expect(socket.listDevices()[0].platform).toBe('android');
  });

  it('harmonyos 设备 hello 正常注册（Task 1 核心目标）', () => {
    const ws = makeMockWs();
    (socket as any).handleHello(ws, {
      type: 'hello',
      deviceId: 'harmony-udid-1',
      platform: 'harmonyos',
      deviceName: 'Mate 60',
    });
    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'hello-ack', ok: true }));
    expect(socket.connectedCount).toBe(1);
    expect(socket.listDevices()[0]).toMatchObject({
      deviceId: 'harmony-udid-1',
      platform: 'harmonyos',
      deviceName: 'Mate 60',
    });
  });

  it('非法 platform 被拒绝并 close(4002)', () => {
    const ws = makeMockWs();
    (socket as any).handleHello(ws, {
      type: 'hello',
      deviceId: 'unknown-1',
      platform: 'windows',
    });
    expect(ws.close).toHaveBeenCalledWith(4002, 'invalid platform');
    expect(ws.send).not.toHaveBeenCalled();
    expect(socket.connectedCount).toBe(0);
  });

  it('platform 大小写敏感：IOS 被拒绝', () => {
    const ws = makeMockWs();
    (socket as any).handleHello(ws, {
      type: 'hello',
      deviceId: 'case-test',
      platform: 'IOS' as any,
    });
    expect(ws.close).toHaveBeenCalledWith(4002, 'invalid platform');
    expect(socket.connectedCount).toBe(0);
  });
});
