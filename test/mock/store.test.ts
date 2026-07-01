import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseAndValidate,
  defaultTemplate,
  buildPayload,
  resolveContent,
  MockFileNotFoundError,
  type MockFile,
  type MockRule,
} from '../../src/mock/store.js';

describe('defaultTemplate', () => {
  it('返回包含 rules 和 headers 的对象', () => {
    const tpl = defaultTemplate();
    expect(Array.isArray(tpl.rules)).toBe(true);
    expect(tpl.rules.length).toBeGreaterThan(0);
    expect(typeof tpl.headers).toBe('object');
  });

  it('模板能通过 parseAndValidate 校验', () => {
    const tpl = defaultTemplate();
    const raw = JSON.stringify(tpl);
    const result = parseAndValidate(raw, 'mock.json');
    expect(result.rules.length).toBe(tpl.rules.length);
  });

  it('每次调用返回新实例（不共享引用）', () => {
    const a = defaultTemplate();
    const b = defaultTemplate();
    expect(a).not.toBe(b);
    expect(a.rules).not.toBe(b.rules);
  });
});

describe('parseAndValidate', () => {
  it('解析合法 JSON', () => {
    const raw = JSON.stringify({
      rules: [
        { method: 'mtop.test', content: { ok: true } },
      ],
      headers: { 'x-env': 'pre' },
    });
    const result = parseAndValidate(raw, 'test.json');
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.method).toBe('mtop.test');
    expect(result.headers['x-env']).toBe('pre');
  });

  it('空 rules 和 headers 也合法', () => {
    const raw = JSON.stringify({ rules: [], headers: {} });
    const result = parseAndValidate(raw, 'test.json');
    expect(result.rules).toEqual([]);
    expect(result.headers).toEqual({});
  });

  it('rules 和 headers 均可省略（缺省为空）', () => {
    const raw = JSON.stringify({});
    const result = parseAndValidate(raw, 'test.json');
    expect(result.rules).toEqual([]);
    expect(result.headers).toEqual({});
  });

  it('JSON 语法错误时抛出', () => {
    expect(() => parseAndValidate('not json', 'bad.json')).toThrow('JSON 解析失败');
  });

  it('根节点不是对象时抛出', () => {
    expect(() => parseAndValidate('[]', 'arr.json')).toThrow('根节点必须是对象');
    expect(() => parseAndValidate('"str"', 'str.json')).toThrow('根节点必须是对象');
    expect(() => parseAndValidate('null', 'null.json')).toThrow('根节点必须是对象');
  });

  it('rules 不是数组时抛出', () => {
    expect(() => parseAndValidate('{"rules":"bad"}', 'x.json')).toThrow('rules 必须是数组');
  });

  it('headers 不是对象时抛出', () => {
    expect(() => parseAndValidate('{"headers":[]}', 'x.json')).toThrow('headers 必须是对象');
    expect(() => parseAndValidate('{"headers":null}', 'x.json')).toThrow('headers 必须是对象');
  });

  describe('rules 条目校验', () => {
    it('非对象条目抛出', () => {
      expect(() => parseAndValidate('{"rules":["str"]}', 'x.json')).toThrow('rules[0] 必须是对象');
    });

    it('method 缺失时抛出', () => {
      expect(() => parseAndValidate('{"rules":[{"content":{}}]}', 'x.json')).toThrow('method 必填');
    });

    it('method 为空字符串时抛出', () => {
      expect(() => parseAndValidate('{"rules":[{"method":"","content":{}}]}', 'x.json')).toThrow('method 必填');
    });

    it('method 不是字符串时抛出', () => {
      expect(() => parseAndValidate('{"rules":[{"method":123,"content":{}}]}', 'x.json')).toThrow('method 必填');
    });

    it('params 不是字符串时抛出', () => {
      expect(() => parseAndValidate('{"rules":[{"method":"m","params":1,"content":{}}]}', 'x.json'))
        .toThrow('params 必须是字符串');
    });

    it('同时指定 content 和 contentFile 时抛出', () => {
      expect(() => parseAndValidate(
        '{"rules":[{"method":"m","content":{},"contentFile":"f.json"}]}', 'x.json'
      )).toThrow('不能同时指定 content 和 contentFile');
    });

    it('既无 content 也无 contentFile 时抛出', () => {
      expect(() => parseAndValidate('{"rules":[{"method":"m"}]}', 'x.json'))
        .toThrow('必须指定 content 或 contentFile');
    });

    it('contentFile 为空字符串时抛出', () => {
      expect(() => parseAndValidate(
        '{"rules":[{"method":"m","contentFile":"  "}]}', 'x.json'
      )).toThrow('contentFile 必须为非空字符串');
    });

    it('contentFile 为非字符串时抛出', () => {
      expect(() => parseAndValidate(
        '{"rules":[{"method":"m","contentFile":123}]}', 'x.json'
      )).toThrow('contentFile 必须为非空字符串');
    });
  });

  describe('headers 校验', () => {
    it('value 不是字符串时抛出', () => {
      expect(() => parseAndValidate('{"headers":{"key":123}}', 'x.json'))
        .toThrow('必须是字符串');
    });
  });

  it('正确规则被规范化（仅保留有效字段）', () => {
    const raw = JSON.stringify({
      rules: [
        { method: 'mtop.a', content: 'text' },
        { method: 'mtop.b', params: 'k=v', contentFile: '/tmp/resp.json' },
      ],
    });
    const result = parseAndValidate(raw, 'x.json');
    expect(result.rules[0]).toEqual({ method: 'mtop.a', content: 'text' });
    expect(result.rules[1]).toEqual({ method: 'mtop.b', params: 'k=v', contentFile: '/tmp/resp.json' });
  });
});

describe('resolveContent', () => {
  it('content 为字符串时直接返回', () => {
    const rule: MockRule = { method: 'm', content: 'raw text' };
    expect(resolveContent(rule, '/base')).toBe('raw text');
  });

  it('content 为对象时 JSON.stringify', () => {
    const rule: MockRule = { method: 'm', content: { code: 0 } };
    expect(resolveContent(rule, '/base')).toBe('{"code":0}');
  });

  it('content 为数组时 JSON.stringify', () => {
    const rule: MockRule = { method: 'm', content: [1, 2, 3] };
    expect(resolveContent(rule, '/base')).toBe('[1,2,3]');
  });

  it('contentFile 不存在时抛出', () => {
    const rule: MockRule = { method: 'm', contentFile: '/nonexistent/file.json' };
    expect(() => resolveContent(rule, '/base')).toThrow('contentFile 不存在');
  });
});

describe('buildPayload', () => {
  it('open=false 时返回空载荷', () => {
    const file: MockFile = {
      rules: [{ method: 'm', content: {} }],
      headers: { 'x': 'y' },
    };
    const payload = buildPayload(file, { open: false });
    expect(payload.mtopOpen).toBe(false);
    expect(payload.mockItems).toEqual([]);
    expect(payload.customHttpHeaders).toEqual({});
  });

  it('open=true 时正确构建', () => {
    const file: MockFile = {
      rules: [
        { method: 'mtop.a', content: '{"ok":true}' },
        { method: 'mtop.b', params: 'k=v', content: 'resp' },
      ],
      headers: { 'x-env': 'pre' },
    };
    const payload = buildPayload(file, { open: true });
    expect(payload.mtopOpen).toBe(true);
    expect(payload.mockItems).toHaveLength(2);

    const item0 = payload.mockItems[0]!;
    expect(item0.method).toBe('mtop.a');
    expect(item0.params).toBe('');
    expect(item0.mockContent).toBe('{"ok":true}');
    expect(item0.isActive).toBe(true);
    expect(item0.isPreMock).toBe(true);
    expect(typeof item0.id).toBe('string');

    const item1 = payload.mockItems[1]!;
    expect(item1.method).toBe('mtop.b');
    expect(item1.params).toBe('k=v');
    expect(item1.mockContent).toBe('resp');
  });

  it('id 是 method+params 的 md5，相同输入 id 相同', () => {
    const file: MockFile = {
      rules: [{ method: 'm', params: 'p', content: 'c' }],
      headers: {},
    };
    const p1 = buildPayload(file, { open: true });
    const p2 = buildPayload(file, { open: true });
    expect(p1.mockItems[0]!.id).toBe(p2.mockItems[0]!.id);
  });

  it('不同 method 产生不同 id', () => {
    const file: MockFile = {
      rules: [
        { method: 'm1', content: 'c' },
        { method: 'm2', content: 'c' },
      ],
      headers: {},
    };
    const payload = buildPayload(file, { open: true });
    expect(payload.mockItems[0]!.id).not.toBe(payload.mockItems[1]!.id);
  });

  it('headers 被透传到 customHttpHeaders', () => {
    const file: MockFile = {
      rules: [],
      headers: { 'x-env': 'gray', 'x-custom': 'val' },
    };
    const payload = buildPayload(file, { open: true });
    expect(payload.customHttpHeaders).toEqual({ 'x-env': 'gray', 'x-custom': 'val' });
  });
});

describe('MockFileNotFoundError', () => {
  it('是 Error 实例', () => {
    const err = new MockFileNotFoundError('/path/to/mock.json');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MockFileNotFoundError');
    expect(err.filePath).toBe('/path/to/mock.json');
    expect(err.message).toContain('/path/to/mock.json');
    expect(err.message).toContain('hex mock init');
  });
});
