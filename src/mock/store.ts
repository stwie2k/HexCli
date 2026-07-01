import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export const HEXCLI_DIR = path.join(os.homedir(), '.hexcli');
export const MOCK_FILE_PATH = path.join(HEXCLI_DIR, 'mock.json');

export interface MockRule {
  method: string;
  params?: string;
  content?: unknown;
  contentFile?: string;
}

export interface MockFile {
  rules: MockRule[];
  headers: Record<string, string>;
}

export interface MockItemPayload {
  id: string;
  method: string;
  params: string;
  mockContent: string;
  isActive: boolean;
  isPreMock: boolean;
}

export interface MtopMockPayload {
  mtopOpen: boolean;
  mockItems: MockItemPayload[];
  customHttpHeaders: Record<string, string>;
}

export class MockFileNotFoundError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(`未找到 mock 文件: ${filePath}\n请先执行: hex mock init`);
    this.name = 'MockFileNotFoundError';
    this.filePath = filePath;
  }
}

function ensureDir(): void {
  if (!fs.existsSync(HEXCLI_DIR)) {
    fs.mkdirSync(HEXCLI_DIR, { recursive: true });
  }
}

export function defaultTemplate(): MockFile {
  return {
    rules: [
      {
        method: 'mtop.example.getData',
        content: { code: '0', data: { list: [{ id: 1, name: 'mock数据' }] } },
      },
      {
        method: 'mtop.example.getDetail',
        params: 'itemId=123',
        content: { code: '0', data: { title: '商品详情', price: '99.00' } },
      },
      {
        method: 'mtop.example.fromFile',
        contentFile: '~/.hexcli/response.json',
      },
    ],
    headers: {
      'x-env': 'pre',
    },
  };
}

export function mockFileExists(): boolean {
  return fs.existsSync(MOCK_FILE_PATH);
}

export function loadMockFile(): MockFile {
  if (!fs.existsSync(MOCK_FILE_PATH)) {
    throw new MockFileNotFoundError(MOCK_FILE_PATH);
  }
  const raw = fs.readFileSync(MOCK_FILE_PATH, 'utf-8');
  return parseAndValidate(raw, MOCK_FILE_PATH);
}

export function writeMockFile(file: MockFile): void {
  ensureDir();
  fs.writeFileSync(MOCK_FILE_PATH, JSON.stringify(file, null, 2) + '\n', 'utf-8');
}

export function parseAndValidate(raw: string, filePath: string): MockFile {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`mock 文件 JSON 解析失败 (${filePath}): ${err?.message ?? err}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`mock 文件根节点必须是对象: ${filePath}`);
  }

  const rawRules = data.rules;
  if (rawRules !== undefined && !Array.isArray(rawRules)) {
    throw new Error(`rules 必须是数组`);
  }
  const rawHeaders = data.headers;
  if (
    rawHeaders !== undefined &&
    (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders) || rawHeaders === null)
  ) {
    throw new Error(`headers 必须是对象（key/value 均为字符串）`);
  }

  const rules: MockRule[] = (rawRules ?? []).map((rule: any, idx: number) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`rules[${idx}] 必须是对象`);
    }
    if (typeof rule.method !== 'string' || !rule.method.trim()) {
      throw new Error(`rules[${idx}].method 必填且必须为非空字符串`);
    }
    if (rule.params !== undefined && typeof rule.params !== 'string') {
      throw new Error(`rules[${idx}].params 必须是字符串`);
    }
    const hasContent = Object.prototype.hasOwnProperty.call(rule, 'content');
    const hasFile = Object.prototype.hasOwnProperty.call(rule, 'contentFile');
    if (hasContent && hasFile) {
      throw new Error(`rules[${idx}] 不能同时指定 content 和 contentFile`);
    }
    if (!hasContent && !hasFile) {
      throw new Error(`rules[${idx}] 必须指定 content 或 contentFile`);
    }
    if (hasFile && (typeof rule.contentFile !== 'string' || !rule.contentFile.trim())) {
      throw new Error(`rules[${idx}].contentFile 必须为非空字符串`);
    }
    const out: MockRule = { method: rule.method };
    if (rule.params !== undefined) out.params = rule.params;
    if (hasContent) out.content = rule.content;
    if (hasFile) out.contentFile = rule.contentFile;
    return out;
  });

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders ?? {})) {
    if (typeof v !== 'string') {
      throw new Error(`headers["${k}"] 必须是字符串`);
    }
    headers[k] = v;
  }

  return { rules, headers };
}

function resolveContentFilePath(p: string, baseDir: string): string {
  if (path.isAbsolute(p)) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(baseDir, p);
}

export function resolveContent(rule: MockRule, baseDir: string): string {
  if (rule.contentFile !== undefined) {
    const resolved = resolveContentFilePath(rule.contentFile, baseDir);
    if (!fs.existsSync(resolved)) {
      throw new Error(`contentFile 不存在: ${resolved}（规则 ${rule.method}）`);
    }
    return fs.readFileSync(resolved, 'utf-8');
  }
  if (typeof rule.content === 'string') {
    return rule.content;
  }
  return JSON.stringify(rule.content);
}

function md5(method: string, params: string): string {
  return crypto.createHash('md5').update(`${method}|${params}`).digest('hex');
}

export function buildPayload(file: MockFile, opts: { open: boolean }): MtopMockPayload {
  if (!opts.open) {
    return { mtopOpen: false, mockItems: [], customHttpHeaders: {} };
  }
  const mockItems: MockItemPayload[] = file.rules.map((rule) => {
    const params = rule.params ?? '';
    const mockContent = resolveContent(rule, HEXCLI_DIR);
    return {
      id: md5(rule.method, params),
      method: rule.method,
      params,
      mockContent,
      isActive: true,
      isPreMock: true,
    };
  });
  return {
    mtopOpen: true,
    mockItems,
    customHttpHeaders: file.headers,
  };
}

