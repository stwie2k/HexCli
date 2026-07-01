import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('os', () => ({
  networkInterfaces: vi.fn(),
}));

const { networkInterfaces } = await import('os');
const mockNetIfaces = vi.mocked(networkInterfaces);

let networkMod: typeof import('../../src/utils/network.js');

vi.resetModules();
networkMod = await import('../../src/utils/network.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getLocalIP', () => {
  it('返回第一个非内部 IPv4 地址', () => {
    mockNetIfaces.mockReturnValue({
      en0: [
        { address: '192.168.1.100', family: 'IPv4', internal: false } as any,
      ],
      lo0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true } as any,
      ],
    });
    expect(networkMod.getLocalIP()).toBe('192.168.1.100');
  });

  it('跳过内部接口（internal=true）', () => {
    mockNetIfaces.mockReturnValue({
      lo0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true } as any,
      ],
      en1: [
        { address: '10.0.0.5', family: 'IPv4', internal: false } as any,
      ],
    });
    expect(networkMod.getLocalIP()).toBe('10.0.0.5');
  });

  it('跳过 IPv6 地址', () => {
    mockNetIfaces.mockReturnValue({
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false } as any,
        { address: '192.168.0.1', family: 'IPv4', internal: false } as any,
      ],
    });
    expect(networkMod.getLocalIP()).toBe('192.168.0.1');
  });

  it('兼容 family 为数字 4 的旧 Node 版本', () => {
    mockNetIfaces.mockReturnValue({
      en0: [
        { address: '172.16.0.1', family: 4, internal: false } as any,
      ],
    });
    expect(networkMod.getLocalIP()).toBe('172.16.0.1');
  });

  it('无可用接口时返回兜底 127.0.0.1', () => {
    mockNetIfaces.mockReturnValue({
      lo0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true } as any,
      ],
    });
    expect(networkMod.getLocalIP()).toBe('127.0.0.1');
  });

  it('所有接口均为空数组时返回 127.0.0.1', () => {
    mockNetIfaces.mockReturnValue({
      en0: [],
      lo0: [],
    });
    expect(networkMod.getLocalIP()).toBe('127.0.0.1');
  });

  it('接口对象为 undefined 时安全跳过', () => {
    mockNetIfaces.mockReturnValue({
      en0: undefined as any,
      en1: [
        { address: '192.168.2.5', family: 'IPv4', internal: false } as any,
      ],
    });
    expect(networkMod.getLocalIP()).toBe('192.168.2.5');
  });

  it('完全无网络接口时返回 127.0.0.1', () => {
    mockNetIfaces.mockReturnValue({});
    expect(networkMod.getLocalIP()).toBe('127.0.0.1');
  });

  it('返回第一个匹配项（不继续遍历）', () => {
    mockNetIfaces.mockReturnValue({
      en0: [
        { address: '192.168.1.1', family: 'IPv4', internal: false } as any,
        { address: '192.168.1.2', family: 'IPv4', internal: false } as any,
      ],
    });
    expect(networkMod.getLocalIP()).toBe('192.168.1.1');
  });
});
