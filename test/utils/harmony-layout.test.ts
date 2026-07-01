import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { execSync } from 'child_process';
import fs from 'fs';
import {
  parseBounds,
  findNodesByText,
  dumpHarmonyLayout,
  type HarmonyLayoutNode,
} from '../../src/utils/harmony-layout.js';

const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  mockedExecSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  parseBounds                                                        */
/* ------------------------------------------------------------------ */

describe('parseBounds', () => {
  it('解析标准 bounds 字符串', () => {
    expect(parseBounds('[0,0][1260,2720]')).toEqual({
      x1: 0, y1: 0, x2: 1260, y2: 2720,
    });
  });

  it('解析非零起点', () => {
    expect(parseBounds('[100,200][500,600]')).toEqual({
      x1: 100, y1: 200, x2: 500, y2: 600,
    });
  });

  it('解析大坐标值', () => {
    expect(parseBounds('[0,0][2560,1800]')).toEqual({
      x1: 0, y1: 0, x2: 2560, y2: 1800,
    });
  });

  it('解析含负坐标的 bounds（如 StatusBar 图标）', () => {
    expect(parseBounds('[-46,22][3138,91]')).toEqual({
      x1: -46, y1: 22, x2: 3138, y2: 91,
    });
  });

  it('无效格式返回 null', () => {
    expect(parseBounds('invalid')).toBeNull();
    expect(parseBounds('')).toBeNull();
    expect(parseBounds('[1,2]')).toBeNull();
    expect(parseBounds('[1,2][3]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  findNodesByText                                                    */
/* ------------------------------------------------------------------ */

describe('findNodesByText', () => {
  const tree: HarmonyLayoutNode = {
    attributes: { type: 'Column', text: '', bounds: '[0,0][1260,2720]' },
    children: [
      {
        attributes: { type: 'Text', text: '首页', bounds: '[0,0][200,100]' },
        children: [],
      },
      {
        attributes: { type: 'Button', description: '设置按钮', text: '', bounds: '[0,100][200,200]' },
        children: [
          {
            attributes: { type: 'Text', text: '设置', bounds: '[10,110][190,190]' },
            children: [],
          },
        ],
      },
      {
        attributes: { type: 'Image', text: 'LOGO', description: '', bounds: '[500,0][760,260]' },
        children: [],
      },
    ],
  };

  it('精确匹配 text 属性', () => {
    const results = findNodesByText(tree, '设置', true);
    expect(results).toHaveLength(1);
    expect(results[0].attributes.type).toBe('Text');
  });

  it('模糊匹配 text 属性', () => {
    const results = findNodesByText(tree, '首', false);
    expect(results).toHaveLength(1);
    expect(results[0].attributes.text).toBe('首页');
  });

  it('模糊匹配 description 属性', () => {
    const results = findNodesByText(tree, '设置', false);
    // "设置按钮" (description) + "设置" (text) → 2 matches
    expect(results).toHaveLength(2);
  });

  it('递归查找嵌套子节点', () => {
    const results = findNodesByText(tree, 'LOGO', true);
    expect(results).toHaveLength(1);
    expect(results[0].attributes.type).toBe('Image');
  });

  it('无匹配返回空数组', () => {
    expect(findNodesByText(tree, '不存在的文本xyz', true)).toHaveLength(0);
    expect(findNodesByText(tree, '不存在的文本xyz', false)).toHaveLength(0);
  });

  it('精确匹配不受大小写影响', () => {
    // exact 模式下是严格相等
    const results = findNodesByText(tree, 'logo', true);
    expect(results).toHaveLength(0);
  });

  it('模糊匹配忽略大小写', () => {
    const results = findNodesByText(tree, 'logo', false);
    expect(results).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  dumpHarmonyLayout                                                  */
/* ------------------------------------------------------------------ */

describe('dumpHarmonyLayout', () => {
  const mockJson = JSON.stringify({
    attributes: { type: 'Root', text: '', bounds: '[0,0][1260,2720]' },
    children: [
      { attributes: { type: 'Text', text: 'Hello', bounds: '[0,0][200,100]' }, children: [] },
    ],
  });

  it('正常执行并返回解析后的 JSON 树', () => {
    mockedExecSync.mockImplementation(() => Buffer.from(''));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(mockJson);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});

    const result = dumpHarmonyLayout('DUMMY_UDID');
    expect(result.attributes.type).toBe('Root');
    expect(result.children).toHaveLength(1);
    expect(result.children[0].attributes.text).toBe('Hello');
  });

  it('默认不包含 -i 参数', () => {
    mockedExecSync.mockImplementation(() => Buffer.from(''));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(mockJson);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});

    dumpHarmonyLayout('DUMMY_UDID');
    const firstCall = mockedExecSync.mock.calls[0][0] as string;
    expect(firstCall).toContain('uitest dumpLayout');
    expect(firstCall).not.toContain(' -i');
  });

  it('showAll=true 时命令包含 -i 参数', () => {
    mockedExecSync.mockImplementation(() => Buffer.from(''));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(mockJson);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});

    dumpHarmonyLayout('DUMMY_UDID', { showAll: true });
    const firstCall = mockedExecSync.mock.calls[0][0] as string;
    expect(firstCall).toContain(' -i');
  });

  it('dumpLayout 命令失败时抛出错误', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    expect(() => dumpHarmonyLayout('DUMMY_UDID')).toThrow('uitest dumpLayout 失败');
  });

  it('文件未生成时抛出错误', () => {
    mockedExecSync.mockImplementation(() => Buffer.from(''));
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(() => dumpHarmonyLayout('DUMMY_UDID')).toThrow('uitest dumpLayout 失败');
  });

  it('showAll=true 时数组格式被合并为单个根节点', () => {
    const arrayJson = JSON.stringify([
      { attributes: { type: 'Window1', bounds: '[0,0][100,100]' }, children: [] },
      { attributes: { type: 'Window2', bounds: '[0,0][200,200]' }, children: [] },
    ]);
    mockedExecSync.mockImplementation(() => Buffer.from(''));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(arrayJson);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {});

    const result = dumpHarmonyLayout('DUMMY_UDID', { showAll: true });
    expect(result.attributes.type).toBe('Screen');
    expect(result.children).toHaveLength(2);
    expect(result.children[0].attributes.type).toBe('Window1');
    expect(result.children[1].attributes.type).toBe('Window2');
  });
});
