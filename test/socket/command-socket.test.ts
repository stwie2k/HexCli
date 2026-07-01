import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 不真正起 WebSocket Server，只测试纯逻辑方法
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

describe('CommandSocket（纯逻辑，无网络）', () => {
  describe('初始状态', () => {
    it('connectedCount 为 0', () => {
      expect(socket.connectedCount).toBe(0);
    });

    it('listDevices 返回空数组', () => {
      expect(socket.listDevices()).toEqual([]);
    });
  });

  describe('sendCommand（无设备时）', () => {
    it('无设备时 reject "没有已连接的设备"', async () => {
      await expect(socket.sendCommand('test', {})).rejects.toThrow('没有已连接的设备');
    });
  });

  describe('dispatch（设备不在线时）', () => {
    it('目标设备不在线时 reject', async () => {
      await expect(socket.dispatch('test', {}, 'nonexistent-device')).rejects.toThrow(
        '设备 nonexistent-device 未在线'
      );
    });
  });

  describe('disconnectDevice（设备不在线时）', () => {
    it('返回 false', () => {
      expect(socket.disconnectDevice('nonexistent')).toBe(false);
    });
  });

  describe('waitForConnection（短超时）', () => {
    it('无设备时超时 reject', async () => {
      await expect(socket.waitForConnection(100)).rejects.toThrow('等待设备连接超时');
    }, 5000);
  });

  describe('waitForDevice（短超时）', () => {
    it('指定设备不在线时超时 reject', async () => {
      await expect(socket.waitForDevice('missing-udid', 100)).rejects.toThrow(
        '等待设备 missing-udid 连接超时'
      );
    }, 5000);
  });

  describe('close', () => {
    it('未启动时 close 不抛出', async () => {
      await expect(socket.close()).resolves.toBeUndefined();
    });
  });
});
