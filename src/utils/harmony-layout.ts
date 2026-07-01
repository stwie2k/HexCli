import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

export interface HarmonyLayoutNode {
  attributes: Record<string, string>;
  children: HarmonyLayoutNode[];
}

/* ------------------------------------------------------------------ */
/*  parseBounds: 解析 "[x1,y1][x2,y2]" 格式                          */
/* ------------------------------------------------------------------ */

export function parseBounds(bounds: string): { x1: number; y1: number; x2: number; y2: number } | null {
  // 支持负坐标（部分系统 UI 节点如 StatusBar 会出现负数 bounds）
  const m = bounds.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  return {
    x1: Number(m[1]),
    y1: Number(m[2]),
    x2: Number(m[3]),
    y2: Number(m[4]),
  };
}

/* ------------------------------------------------------------------ */
/*  findNodesByText: 递归查找匹配文本的节点                             */
/* ------------------------------------------------------------------ */

export function findNodesByText(root: HarmonyLayoutNode, text: string, exact: boolean): HarmonyLayoutNode[] {
  const results: HarmonyLayoutNode[] = [];
  const target = text.toLowerCase();

  function walk(node: HarmonyLayoutNode): void {
    const attrs = node.attributes || {};
    const displayText = attrs.text || attrs.description || '';
    if (displayText) {
      const matched = exact
        ? displayText === text
        : displayText.toLowerCase().includes(target);
      if (matched) results.push(node);
    }
    for (const child of node.children || []) {
      walk(child);
    }
  }

  walk(root);
  return results;
}

/* ------------------------------------------------------------------ */
/*  dumpHarmonyLayout: 执行 uitest dumpLayout 并返回 JSON 树           */
/* ------------------------------------------------------------------ */

export function dumpHarmonyLayout(
  udid: string,
  opts?: { showAll?: boolean },
): HarmonyLayoutNode {
  const hdcPrefix = `hdc -t ${udid}`;
  const remotePath = '/data/local/tmp/hex_dump.json';
  const localPath = path.join(os.tmpdir(), `hex_dump_${udid.replace(/[^a-zA-Z0-9]/g, '_')}.json`);

  const showAll = opts?.showAll ?? false;
  const dumpCmd = `${hdcPrefix} shell uitest dumpLayout${showAll ? ' -i' : ''} -p ${remotePath}`;

  try {
    // 1. 在设备端 dumpLayout
    execSync(dumpCmd, { stdio: 'pipe', timeout: 15000 });

    // 2. 从设备拉取到本地
    execSync(`${hdcPrefix} file recv ${remotePath} ${localPath}`, {
      stdio: 'pipe',
      timeout: 10000,
    });

    // 3. 读取并解析 JSON
    if (!fs.existsSync(localPath)) {
      throw new Error('dumpLayout 文件未生成');
    }
    const raw = fs.readFileSync(localPath, 'utf-8');
    const parsed = JSON.parse(raw);

    // -i 模式下返回数组（多窗口），需要合并为一个根节点
    if (Array.isArray(parsed)) {
      const root: HarmonyLayoutNode = {
        attributes: { type: 'Screen', bounds: '' },
        children: parsed,
      };
      return root;
    }
    return parsed as HarmonyLayoutNode;
  } catch (err: any) {
    throw new Error(`uitest dumpLayout 失败: ${err.message}`);
  } finally {
    // 4. 清理临时文件
    try { fs.unlinkSync(localPath); } catch {}
    try { execSync(`${hdcPrefix} shell rm -f ${remotePath}`, { stdio: 'pipe', timeout: 3000 }); } catch {}
  }
}
