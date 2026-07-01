import { Command } from 'commander';
import { execSync } from 'child_process';
import * as logger from '../utils/logger.js';
import { type LocalDevice } from '../utils/launcher.js';
import { getGlobalUdid } from '../utils/global-opts.js';
import { resolveLocalTarget } from '../utils/local-target.js';
import { wdaRequest, getOrCreateSession } from '../utils/wda.js';
import { ensureWDA, getHarmonyDensityFactor } from './tap.js';
import { dumpHarmonyLayout, parseBounds, type HarmonyLayoutNode } from '../utils/harmony-layout.js';

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

interface InspectNode {
  type: string;
  text: string;
  frame: { x: number; y: number; width: number; height: number };
  children: InspectNode[];
}

/* ------------------------------------------------------------------ */
/*  iOS 实现：WDA /source?format=json                                  */
/* ------------------------------------------------------------------ */

async function getIOSViewTree(udid: string): Promise<InspectNode> {
  await ensureWDA(udid);
  const sessionId = await getOrCreateSession(udid);

  const res = await wdaRequest(
    udid,
    'GET',
    `/session/${sessionId}/source?format=json`,
    undefined,
    30000,
  );

  const raw = res.value;
  if (!raw) {
    throw new Error('WDA /source 返回为空');
  }

  function transform(node: any): InspectNode {
    const type = (node.type || '').replace(/^XCUIElementType/, '');
    const label = node.label || '';
    const value = node.value || '';
    const text = label || value;
    const rect = node.rect || {};
    const frame = {
      x: rect.x ?? 0,
      y: rect.y ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
    };
    const children: InspectNode[] = (node.children || []).map(transform);
    return { type, text, frame, children };
  }

  return transform(raw);
}

/**
 * 过滤 iOS 视图树：只保留主 Window（最大面积的 Window）
 */
function filterIOSMainWindow(tree: InspectNode): InspectNode {
  // Application 的直接 children 中找 Window 类型，取面积最大的（主 Window）
  if (tree.type === 'Application' && tree.children.length > 0) {
    const windows = tree.children.filter(c => c.type === 'Window');
    if (windows.length > 1) {
      // 按面积降序取最大的
      windows.sort((a, b) =>
        (b.frame.width * b.frame.height) - (a.frame.width * a.frame.height)
      );
      return { ...tree, children: [windows[0]] };
    }
  }
  return tree;
}

/* ------------------------------------------------------------------ */
/*  HarmonyOS 实现：uitest dumpLayout（坐标 ÷ density 转 vp）         */
/* ------------------------------------------------------------------ */

function getHarmonyViewTree(udid: string, showAll: boolean): InspectNode {
  const raw = dumpHarmonyLayout(udid, { showAll });
  const density = getHarmonyDensityFactor(udid);

  function transform(node: HarmonyLayoutNode): InspectNode {
    const attrs = node.attributes || {};
    const type = attrs.type || 'Unknown';
    const text = attrs.text || attrs.description || '';

    let frame = { x: 0, y: 0, width: 0, height: 0 };
    const bounds = parseBounds(attrs.bounds || '');
    if (bounds) {
      frame = {
        x: Math.round(bounds.x1 / density),
        y: Math.round(bounds.y1 / density),
        width: Math.round((bounds.x2 - bounds.x1) / density),
        height: Math.round((bounds.y2 - bounds.y1) / density),
      };
    }

    const children: InspectNode[] = (node.children || []).map(transform);
    return { type, text, frame, children };
  }

  return transform(raw);
}

/* ------------------------------------------------------------------ */
/*  Android 实现：uiautomator dump（默认只展示前台应用）                 */
/* ------------------------------------------------------------------ */

/**
 * 获取 Android 前台应用的包名和 Activity 名
 */
function getAndroidForegroundInfo(serial: string): { pkg: string; activity: string } | null {
  try {
    const out = execSync(`adb -s ${serial} shell dumpsys activity activities`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    // topResumedActivity=ActivityRecord{... u0 com.xxx.yyy/.Activity t123}
    const match = out.match(/(?:topResumedActivity|mResumedActivity|mFocusedApp)[=:].*?\su\d+\s(\S+?)\/(\S+?)\s/);
    if (match) return { pkg: match[1], activity: match[2] };
    return null;
  } catch {
    return null;
  }
}

/**
 * 通过 dumpsys activity 获取指定 Activity 的 View Hierarchy（可穿透 Dialog）
 */
function getAndroidActivityViewTree(serial: string, pkg: string, activity: string): InspectNode | null {
  try {
    const fullActivity = activity.startsWith('.') ? `${pkg}${activity}` : activity;
    const out = execSync(`adb -s ${serial} shell dumpsys activity ${pkg}/${fullActivity}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });

    // 找到 View Hierarchy: 段落
    const viewStart = out.indexOf('View Hierarchy:');
    if (viewStart === -1) return null;
    const viewSection = out.substring(viewStart);
    // 到 Looper 或下一段结束
    const endMarkers = ['Looper (', 'ResourcesManager:', '\n\n'];
    let endIdx = viewSection.length;
    for (const marker of endMarkers) {
      const idx = viewSection.indexOf(marker, 20);
      if (idx !== -1 && idx < endIdx) endIdx = idx;
    }
    const lines = viewSection.substring(0, endIdx).split('\n').slice(1); // skip "View Hierarchy:" line

    if (lines.length === 0) return null;

    // 解析缩进结构
    const root: InspectNode = { type: 'ActivityView', text: '', frame: { x: 0, y: 0, width: 0, height: 0 }, children: [] };
    const stack: Array<{ node: InspectNode; indent: number }> = [{ node: root, indent: -1 }];

    for (const line of lines) {
      if (!line.trim()) continue;
      const indent = line.search(/\S/);
      if (indent === -1) continue;

      // 解析: ClassName{hash flags x1,y1-x2,y2 [#id res:id/name]}
      const classMatch = line.match(/(\S+?)\{[^}]*?\s+(\d+),(\d+)-(\d+),(\d+)/);
      if (!classMatch) continue;

      const cls = classMatch[1];
      const x1 = Number(classMatch[2]);
      const y1 = Number(classMatch[3]);
      const x2 = Number(classMatch[4]);
      const y2 = Number(classMatch[5]);

      const type = cls.replace(/^(?:com\.android\.internal\.policy\.|android\.\w+\.|androidx\.\w+\.\w+\.)/g, '').replace(/^.*\./, '');
      const resIdMatch = line.match(/app:id\/(\S+?)(?:\}|$)/);
      const text = resIdMatch ? resIdMatch[1] : '';
      const frame = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      const node: InspectNode = { type, text, frame, children: [] };

      // 找到正确的父节点
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].node;
      parent.children.push(node);
      stack.push({ node, indent });
    }

    return root.children.length === 1 ? root.children[0] : root;
  } catch {
    return null;
  }
}

function getAndroidViewTree(serial: string, showAll: boolean = false): InspectNode {
  let xml: string;
  try {
    // dump 到设备文件再 cat 回来（/dev/tty 在部分设备不可靠）
    xml = execSync(
      `adb -s ${serial} shell "uiautomator dump /sdcard/hex_ui_dump.xml && cat /sdcard/hex_ui_dump.xml && rm -f /sdcard/hex_ui_dump.xml"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    );
  } catch (err: any) {
    throw new Error(`uiautomator dump 失败: ${err.message}`);
  }

  // 获取前台包名，用于过滤系统 UI（--all 模式下不过滤）
  const fgInfo = showAll ? null : getAndroidForegroundInfo(serial);
  const foregroundPkg = fgInfo?.pkg || null;

  // 解析 XML 为树形结构
  const root: InspectNode = { type: 'Root', text: '', frame: { x: 0, y: 0, width: 0, height: 0 }, children: [] };
  const stack: InspectNode[] = [root];

  const tagRegex = /<(\/?)node([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(xml)) !== null) {
    const isClosing = match[1] === '/';
    const attrs = match[2];
    const isSelfClosing = match[3] === '/';

    if (isClosing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    // 解析属性
    const cls = attrs.match(/\bclass="([^"]*)"/)?.[1] || '';
    const textAttr = attrs.match(/\btext="([^"]*)"/)?.[1] || '';
    const descAttr = attrs.match(/\bcontent-desc="([^"]*)"/)?.[1] || '';
    const pkgAttr = attrs.match(/\bpackage="([^"]*)"/)?.[1] || '';
    const boundsAttr = attrs.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);

    // 默认过滤非目标应用的节点（系统状态栏、导航栏等）
    if (foregroundPkg && pkgAttr && pkgAttr !== foregroundPkg) {
      // 跳过该节点及其子树
      if (!isSelfClosing) {
        let depth = 1;
        let skip: RegExpExecArray | null;
        while (depth > 0 && (skip = tagRegex.exec(xml)) !== null) {
          if (skip[1] === '/') depth--;
          else if (skip[3] !== '/') depth++;
        }
      }
      continue;
    }

    const type = cls.replace(/^android\.\w+\./, '');
    const text = textAttr || descAttr;
    let frame = { x: 0, y: 0, width: 0, height: 0 };
    if (boundsAttr) {
      const x1 = Number(boundsAttr[1]);
      const y1 = Number(boundsAttr[2]);
      const x2 = Number(boundsAttr[3]);
      const y2 = Number(boundsAttr[4]);
      frame = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }

    const node: InspectNode = { type, text, frame, children: [] };
    const parent = stack[stack.length - 1];
    parent.children.push(node);

    if (!isSelfClosing) {
      stack.push(node);
    }
  }

  return root.children.length === 1 ? root.children[0] : root;
}

/* ------------------------------------------------------------------ */
/*  输出格式化                                                         */
/* ------------------------------------------------------------------ */

function formatTree(node: InspectNode, prefix: string = '', isLast: boolean = true, isRoot: boolean = true): string {
  const lines: string[] = [];

  const connector = isRoot ? '' : (isLast ? '└── ' : '├── ');
  const textPart = node.text ? ` "${node.text}"` : '';
  const framePart = `(${node.frame.x},${node.frame.y} ${node.frame.width}x${node.frame.height})`;
  lines.push(`${prefix}${connector}${node.type}${textPart} ${framePart}`);

  const childPrefix = isRoot ? '' : (prefix + (isLast ? '    ' : '│   '));
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const last = i === node.children.length - 1;
    lines.push(formatTree(child, childPrefix, last, false));
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  命令定义                                                           */
/* ------------------------------------------------------------------ */

const inspect = new Command('inspect')
  .description('查看设备当前页面的视图树（含每个元素在主窗口的 frame）')
  .option('--udid <udid>', '指定设备 UDID/Serial（多设备必填）')
  .option('--json', '以 JSON 格式输出（默认树形文本）')
  .option('--all', '显示完整视图树（含系统 UI、多 Window），默认只展示目标应用主窗口')
  .action(async (options) => {
    let target: LocalDevice;
    try {
      target = resolveLocalTarget(options.udid ?? getGlobalUdid());
    } catch (err: any) {
      logger.error(err?.message ?? String(err));
      process.exit(1);
    }
    logger.info(`目标设备: ${target.platform}·${target.name} (${target.udid})`);

    try {
      let tree: InspectNode;
      if (target.platform === 'ios') {
        tree = await getIOSViewTree(target.udid);
        if (!options.all) {
          tree = filterIOSMainWindow(tree);
        }
      } else if (target.platform === 'harmonyos') {
        tree = getHarmonyViewTree(target.udid, !!options.all);
      } else {
        tree = getAndroidViewTree(target.udid, !!options.all);

        // 检测是否只获取到了 Dialog（根节点非全屏），尝试补充底层 Activity 视图
        if (tree.frame.y > 100 || (tree.frame.width > 0 && tree.frame.height > 0 && tree.frame.height < 1000)) {
          const fgInfo = getAndroidForegroundInfo(target.udid);
          if (fgInfo) {
            const activityTree = getAndroidActivityViewTree(target.udid, fgInfo.pkg, fgInfo.activity);
            if (activityTree) {
              // 将 Dialog 和 Activity 合为一个根
              const combined: InspectNode = {
                type: 'Screen',
                text: '',
                frame: { x: 0, y: 0, width: 0, height: 0 },
                children: [
                  { ...activityTree, type: `Activity[${fgInfo.activity}]` },
                  { ...tree, type: `Dialog` },
                ],
              };
              tree = combined;
            }
          }
        }
      }

      if (options.json) {
        console.log(JSON.stringify(tree, null, 2));
      } else {
        console.log(formatTree(tree));
      }
    } catch (err: any) {
      logger.error(err.message);
      process.exit(1);
    }
  });

export { inspect };
export default inspect;
