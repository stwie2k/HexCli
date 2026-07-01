import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * session.ts 的 SESSION_DIR / SESSION_FILE 在导入时由 os.homedir() 求值。
 * 我们通过 vi.mock('os') 把 homedir 指到临时目录，再 vi.resetModules 确保每次 fresh import。
 */
const TEST_HOME = '/tmp/hexcli-session-test-home';
const SESSION_DIR = `${TEST_HOME}/.hexcli`;
const SESSION_FILE = `${SESSION_DIR}/session.json`;

// 内存 fs：每次 fresh import 前 reset
let memStore: Record<string, string> = {};
let dirSet: Set<string> = new Set();

vi.mock('os', () => ({
  default: { homedir: () => TEST_HOME },
  homedir: () => TEST_HOME,
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn((p: string) => {
      if (p === SESSION_FILE && memStore[SESSION_FILE] !== undefined) return memStore[SESSION_FILE];
      const err = Object.assign(new Error(`ENOENT: no such file ${p}`), { code: 'ENOENT' });
      throw err;
    }),
    writeFileSync: vi.fn((p: string, content: string) => {
      memStore[p] = content;
    }),
    existsSync: vi.fn((p: string) => {
      if (p === SESSION_DIR) return dirSet.has(SESSION_DIR);
      if (p === SESSION_FILE || p === `${SESSION_FILE}.tmp`) return memStore[p] !== undefined;
      return false;
    }),
    mkdirSync: vi.fn((p: string) => { dirSet.add(p); }),
    renameSync: vi.fn((from: string, to: string) => {
      memStore[to] = memStore[from]!;
      delete memStore[from];
    }),
    unlinkSync: vi.fn((p: string) => {
      if (memStore[p] !== undefined) { delete memStore[p]; return; }
      const err = Object.assign(new Error(`ENOENT: no such file ${p}`), { code: 'ENOENT' });
      throw err;
    }),
  },
}));

let sessionMod: typeof import('../../src/utils/session.js');

beforeEach(async () => {
  memStore = {};
  dirSet = new Set();
  vi.resetModules();
  sessionMod = await import('../../src/utils/session.js');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session', () => {
  describe('readSession', () => {
    it('文件不存在时返回 null', () => {
      expect(sessionMod.readSession()).toBeNull();
    });

    it('正常 JSON 返回 SessionData', () => {
      const data = {
        defaultDeviceId: 'dev-001',
        rememberedAt: Date.now(),
        rememberedBy: 'explicit' as const,
      };
      sessionMod.writeSession(data);
      const result = sessionMod.readSession();
      expect(result).not.toBeNull();
      expect(result!.defaultDeviceId).toBe('dev-001');
    });

    it('defaultDeviceId 为空字符串时返回 null', () => {
      const data = {
        defaultDeviceId: '',
        rememberedAt: Date.now(),
        rememberedBy: 'explicit' as const,
      };
      sessionMod.writeSession(data);
      expect(sessionMod.readSession()).toBeNull();
    });

    it('JSON 格式异常时返回 null（readFileSync 抛错）', () => {
      // 直接写坏内容到内存
      memStore[SESSION_FILE] = 'not valid json';
      expect(sessionMod.readSession()).toBeNull();
    });
  });

  describe('writeSession', () => {
    it('写入后 readSession 能读到相同数据', () => {
      const data = {
        defaultDeviceId: 'ios-device-abc',
        defaultDeviceLabel: 'iPhone 15',
        rememberedAt: 1700000000000,
        rememberedBy: 'explicit' as const,
      };
      sessionMod.writeSession(data);
      const result = sessionMod.readSession();
      expect(result).toEqual(data);
    });

    it('覆盖写入不会保留旧数据', () => {
      const data1 = {
        defaultDeviceId: 'dev-001',
        rememberedAt: 1000,
        rememberedBy: 'explicit' as const,
      };
      const data2 = {
        defaultDeviceId: 'dev-002',
        rememberedAt: 2000,
        rememberedBy: 'explicit' as const,
      };
      sessionMod.writeSession(data1);
      sessionMod.writeSession(data2);
      expect(sessionMod.readSession()?.defaultDeviceId).toBe('dev-002');
    });
  });

  describe('clearSession', () => {
    it('清除后 readSession 返回 null', () => {
      const data = {
        defaultDeviceId: 'dev-001',
        rememberedAt: Date.now(),
        rememberedBy: 'explicit' as const,
      };
      sessionMod.writeSession(data);
      sessionMod.clearSession();
      expect(sessionMod.readSession()).toBeNull();
    });

    it('文件不存在时 clearSession 不抛出', () => {
      expect(() => sessionMod.clearSession()).not.toThrow();
    });
  });

  describe('isSessionExpired', () => {
    it('刚写入的 session 未过期', () => {
      const data = {
        defaultDeviceId: 'dev-001',
        rememberedAt: Date.now(),
        rememberedBy: 'explicit' as const,
      };
      expect(sessionMod.isSessionExpired(data)).toBe(false);
    });

    it('超过 7 天的 session 已过期', () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const data = {
        defaultDeviceId: 'dev-001',
        rememberedAt: eightDaysAgo,
        rememberedBy: 'explicit' as const,
      };
      expect(sessionMod.isSessionExpired(data)).toBe(true);
    });

    it('自定义 TTL 生效：2h TTL 对 1h 前记录未过期', () => {
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      const data = {
        defaultDeviceId: 'dev-001',
        rememberedAt: oneHourAgo,
        rememberedBy: 'explicit' as const,
      };
      expect(sessionMod.isSessionExpired(data, 2 * 60 * 60 * 1000)).toBe(false);
    });

    it('自定义 TTL 生效：30min TTL 对 1h 前记录已过期', () => {
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      const data = {
        defaultDeviceId: 'dev-001',
        rememberedAt: oneHourAgo,
        rememberedBy: 'explicit' as const,
      };
      expect(sessionMod.isSessionExpired(data, 30 * 60 * 1000)).toBe(true);
    });

    it('恰好在 TTL 边界上（超 1ms）视为过期', () => {
      const ttlMs = 1000;
      const data = {
        defaultDeviceId: 'dev-001',
        rememberedAt: Date.now() - ttlMs - 1,
        rememberedBy: 'explicit' as const,
      };
      expect(sessionMod.isSessionExpired(data, ttlMs)).toBe(true);
    });
  });

  describe('getSessionFilePath', () => {
    it('返回非空字符串路径', () => {
      const p = sessionMod.getSessionFilePath();
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
      expect(p).toContain('session.json');
    });
  });
});
