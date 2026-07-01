This file provides guidance to Agent (ClaudeCode, Qoder, Codex) when working with code in this repository.

## 项目身份

`@ali/hexcli`（CLI 命令 `hex`）—— 1688 移动端调试 CLI，通过 WebSocket 与 iOS / Android 端 SDK 通信，提供环境切换、Mock、查询、UI 自动化等能力。TypeScript / ESM / Node ≥ 18 / 仅打到 macOS（手机调试）。

## 构建 / 开发命令

```bash
npm install           # 安装依赖
npm run build         # tsup 打包 → dist/   （CLI 入口与 daemon 入口双产物）
npm run dev           # watch 模式
npm test              # vitest run 跑全部单元测试
npm run test:watch    # vitest watch 模式（改代码时推荐开一个窗口跑）
npm link              # 全局软链 hex → bin/hex.js（开发时本地调试）

npx tsc --noEmit        # 类型检查（不输出产物，仅校验）
hex doctor            # 体检本机环境（adb / xcrun / pymobiledevice3 / WDA / DDI / tunneld）
hex log -f            # 实时跟随 CLI 日志
./release.sh [patch|minor|major|beta]   # 一键发版（自动 bump + build + npm publish + git push）
```

### 自动化测试（vitest）

- 测试框架：**vitest**（`npm test`），配置见 `vitest.config.ts`。
- 测试文件统一放在 `<project>/test/` 目录，按源码路径镜像组织：
  - `src/socket/command-socket.ts` → `test/socket/command-socket.test.ts`
  - `src/types/device.ts` → `test/types/device.test.ts`
  - 新增源码文件时，对应的 `.test.ts` 也放到 `test/<相对路径>/` 下。
- `npm test` 必须全部绿灯才视为变更健康；CI 也基于此判定。
- 涉及 iOS / Android / 鸿蒙真机的端到端行为仍走 `docs/manual-test-cases.md` 的人工回归清单。

### ⚠️ 铁律：改完代码务必跑对应单测

**每次改完代码（尤其是修改类型、重构、新增模块）之后，必须立即跑一遍对应的单元测试，确认绿灯再提交。**

- 改动范围明确时跑局部：
  ```bash
  npx vitest run test/socket/       # 只跑 socket 相关
  npx vitest run test/types/        # 只跑 types 相关
  npx vitest run test/utils/        # 只跑 utils 相关
  ```
- 改动跨多模块、或不确定影响范围时跑全集：
  ```bash
  npm test
  ```
- 新增功能 / bug 修复：**必须同步补 / 改对应的 `.test.ts`**，避免回归。
- 如果跑测挂红，**先修再提**，不要带病提交；若确属非阻塞性失败，需与用户确认后再决定是否放行。

`bin/hex.js` 是 `import '../dist/index.js'` 的一行壳，**必须先 `npm run build`** 才能执行任何 `hex` 命令；否则 `hex --version` 会因找不到产物报错。`tsup.config.ts` 同时打 `src/index.ts` 和 `src/daemon/startup.ts`，因为 daemon 是被 CLI 通过 `spawn detached` 拉起的独立进程，**必须有独立入口文件**。

用户机器上的更新路径（README 一行命令）：
```bash
cd ~/.hex-cli && git pull && npm install && npm run build
```

## 项目技术栈

| 类别 | 技术选型 | 说明 |
|---|---|---|
| 语言 | **TypeScript 5.x** | 全 TS 编写，`tsconfig.json` 启用 `strict` |
| 模块体系 | **ESM** | `package.json` `"type": "module"`；内部 import 必须带 `.js` 后缀 |
| 运行时 | **Node.js ≥ 18** | 仅打到 macOS（手机调试工具），不跨平台 |
| CLI 框架 | **Commander 12.x** | 命令树 / 子命令 / 全局 `preAction` 钩子 |
| 通信 | **WebSocket** | 使用 `ws` + `@types/ws`，daemon ↔ 端侧 SDK 双向协议（见 `src/socket/command-socket.ts`） |
| UUID | **uuid 9.x** | 命令回包按 uuid 匹配 |
| 打包 | **tsup 8.x** | 双入口产物：`dist/index.js`（CLI）+ `dist/daemon/startup.js`（daemon） |
| 类型检查 | **tsc 5.x** | `npx tsc --noEmit` 仅校验，不输出产物 |
| 测试 | **Vitest 4.x** | `npm test` 跑 `test/**/*.test.ts`；`npm run test:watch` 持续模式 |
| 子进程 | `child_process` | `execSync` / `spawn` / `execFileSync` 调用 `xcrun` / `adb` / `hdc` / `pymobiledevice3` / `iproxy` 等外部工具 |
| 平台依赖（系统） | `xcrun` + `adb` + `hdc` | iOS / Android / 鸿蒙 三端设备调试工具链 |

**关键约束**：

- 所有源码 import 必须带 `.js` 后缀（ESM 强制，不带会运行时报错 `ERR_MODULE_NOT_FOUND`）；
- `tsup.config.ts` 双入口（CLI + daemon）是架构要求，**不要合并为单入口**；
- daemon 是 `spawn detached` 拉起的独立进程，与 CLI 短命令进程通过 IPC HTTP 通信，二者**不能共享进程内状态**；
- `bin/hex.js` 仅一行 `import`，**必须先 build 才能用**，未打包直接跑会报找不到 `dist/index.js`。

## 架构总览

### 两层模型：Daemon + 独立命令

```
hex <cmd>  (短命令进程)
   │  IPC HTTP  127.0.0.1:12589   POST /command {command, params, selector:{udid}}
   ▼
Daemon (后台常驻进程)
   │  WebSocket  *:12588          binary JSON {command, uuid, deviceId, params}
   ▼
iOS / Android SDK  (端侧 ECHRemoteDebug / divine_alibaba)
```

- **Daemon**（`src/daemon/`）：常驻进程，同时维护 WebSocket Server（端口 12588）与设备双向通信、IPC HTTP Server（端口 12589）接受 CLI 请求。Daemon 状态记录在 `~/.hexcli/daemon.json`（pid / 端口 / 启动时间 / 各设备 bundleId 映射）。
- **独立命令**（`src/commands/`）：每条 `hex xxx` 是独立短命令进程，进程内 `ensureDaemon()` → daemon 未跑则 `spawn detached dist/daemon/startup.js` → 通过 IPC HTTP 发命令 → 收到响应即 `process.exit`。

Daemon 由命令进程按需拉起，绝不需要用户手动启动；`hex stop` 是优雅停 daemon + 关 App + 清 WDA 的入口。

### 命令分发流（daemon 路径）

`src/commands/*.ts` 大多走统一 helper：

```
command.action()
   → dispatchCommand(name, params)       // utils/dispatch.ts
       → resolveTarget()                 // utils/selector.ts  ：解析目标 udid
           ├── ensureConnected()         // daemon/client.ts   ：保证 daemon + ≥1 设备
           └── 5 步优先级链选 udid（见下）
       → sendToDaemon(name, params, udid)// daemon/client.ts   ：HTTP POST /command
           → Daemon HTTP handler
               → socket.dispatch()       // socket/command-socket.ts
                   → ws.send 到目标设备
                   → uuid 匹配回包 / 超时 reject
```

### 设备选择优先级（5 步链 —— 多设备调度的核心）

`utils/selector.ts::resolveTarget()`：

1. 命令行 `--udid` 显式指定（或全局 `hex --udid <udid> <cmd>`，由 `src/index.ts` 的 `preAction` hook 通过 `utils/global-opts.ts` 注入）→ 校验在线
2. 0 台设备在线 → 报错 "请先执行 hex open"
3. `~/.hexcli/session.json` 默认设备（`hex device use` 写入，TTL 7 天） + 在线 → 用它
4. 唯一 1 台在线 → 自动选中
5. ≥2 台未指定 → **报错并列出候选**，绝不随机选

每一条新的设备相关命令都必须接入这条链：直接调 `dispatchCommand` 即可，不要自己组装 udid 逻辑。

### 本机直发命令（绕过 Daemon）

`tap` / `swipe` / `screenshot` / `screen` / `inspect` / `tap reset` 不走 Daemon。它们直接通过 USB 调用 `xcrun devicectl`（iOS）、`adb`（Android）、WDA HTTP（iOS UI 自动化）或 `hdc`（鸿蒙）。这些命令复用的是 `launcher.ts::listLocalDevices()` 的本机枚举，**不依赖** daemon 在线，但 `--udid` 仍需要 `assertSafeUdid` 校验。

### CommandSocket（`src/socket/command-socket.ts`）

Daemon 内的 WebSocket 多设备多路复用层：

- `DeviceRegistry`：按 `deviceId` 索引 ws，支持新连接替换旧连接（同 deviceId 重连）、心跳超时（60s）回收。
- 端侧连接后**1 秒内必须发 hello 帧**（含 deviceId / platform / appVersion / sdkVersion）；超时按 legacy 模式注册并打 warn（兼容旧版 SDK）。
- 命令通过 `uuid` 匹配回包；`pendingCallbacks` 同时记录 `targetDeviceId` 和 `sourceWs`，重连时只 fail 旧 ws 上的命令，避免误伤新连接。
- SSE 端点 `/events?udid=<udid>` 把端侧 push（UT / mtop / AppLog）转发给 `hex debug` 订阅者。

### App 启动注入（多设备身份的根）

`utils/launcher.ts::launchByUdid()`：

- **iOS**：`xcrun devicectl device process launch --device <udid> --terminate-existing --environment-variables '{"Hex_XCTest_Web_Server_Ip":"<ws://>", "Hex_Device_UDID":"<udid>", ...}' <bundleId>`
- **Android**：`adb -s <udid> shell am start -n <pkg>/<Activity> --es Hex_XCTest_Web_Server_Ip "<ws://>" --es Hex_Device_UDID "<udid>"`（Activity 通过 `cmd package query-activities` 动态解析；失败 fallback 到 `monkey`）

**绝对不能绕过 `hex open` 直接 `am start`**：端侧 SDK 拿不到 `Hex_Device_UDID` 时会用 `Build.SERIAL`（Android 10+ 是 `unknown`），导致 daemon 多出"幽灵设备"。Android 路径还会在启动前 `touch /sdcard/Android/data/<pkg>/files/.es/.save_apm_data` 触发 APM 上报。

### 安全边界：udid 命令注入防护

`--udid` 会被拼到 `xcrun` / `adb` / `pymobiledevice3` 命令字符串中。所有入口（顶层 `src/index.ts` preAction + 本机直发命令的 `assertSafeUdid`）都用 `utils/udid-safe.ts::isSafeUdid()` 限制字符集为 `[A-Za-z0-9._:-]`，长度 ≤128。**任何新增接受 udid 的代码必须走这一层校验**，否则会留 shell 注入面。

### 两个本地目录的分工（必须分清）

| 目录 | 用途 | 写入方 |
|---|---|---|
| `~/.hexcli/` | `daemon.json` / `session.json` / `mock.json` / `debug-worker.json` | daemon 系运行时状态 |
| `~/.hex-cli/` | `logs/YYYY-MM-DD.log` / `WebDriverAgent/`（编译产物）/ `wda-ports.json` | CLI 日志 & WDA 工程 |

新代码写文件前先确认归属，**不要混用**（历史遗留命名不一致，但语义截然不同）。

### 日志系统（`src/utils/logger.ts`）

- 控制台保留彩色 `✔ ℹ ⚠ ✖`；同时按天落到 `~/.hex-cli/logs/YYYY-MM-DD.log`，ERROR 另写 `.error.log`。
- `initLogger(command, version)` 必须在进程入口调用一次。`src/index.ts` 顶部已调，命令通过 `preAction` 用 `setCommand()` 把默认 `'cli'` 覆写为真实子命令路径（如 `tap.reset`）。
- **`src/daemon/startup.ts` 也必须显式 `initLogger('daemon', ...)`**，因为 daemon 不走 commander 的 preAction。任何脱离 commander 的入口（worker 子进程、独立脚本）同理。
- 7 天前的旧日志启动时清理；写日志失败永不抛错。

### 多版本协议（BREAKING：3.0.0）

CLI / daemon / iOS SDK / Android SDK **必须 ≥ 3.0.0** 配套，与 2.x 完全不兼容。识别旧 SDK 的方式：1s 内未发 hello → daemon 按 `legacy-<n>` 兼容注册并打 warn 提示升级。新增 SDK 字段时记得同步 `DeviceHello` interface（`src/socket/command-socket.ts`）。

## 子命令分组（`src/index.ts::COMMAND_GROUPS`）

| 组 | 命令 |
|---|---|
| 会话生命周期 | `open` / `stop` |
| 多设备路由 | `device list|use|clear|disconnect` |
| 环境与配置 | `env online|pre|gray|downgrade|cybert|https-downgrade` / `mock init|show|apply|clear` / `query appinfo|orange|ab|cookie|...` / `whitelist` / `redirect` |
| 设备交互 | `login` / `tap` / `swipe` / `back` / `screen` / `inspect` / `screenshot` / `open-url` |
| 调试 | `debug --type --script` |
| CLI 维护 | `doctor` / `update` / `doc` / `log` |

新增命令模板：在 `src/commands/` 下新建文件 → `dispatchCommand('<端侧 command 名>', params)` → 在 `src/index.ts` `addCommand()` 并按语义归入对应 `COMMAND_GROUPS`。

### Mock 模块（`src/mock/`）

声明式单文件模型：所有规则集中维护在 `~/.hexcli/mock.json`。

- `store.ts`：配置文件读写与校验（`rules[].method` 必填、`content` 与 `contentFile` 二选一等）
- `sync.ts`：将校验后的 payload 通过 `dispatchCommand` 下发到设备

`hex mock show` 仅本地校验不联机；`hex mock apply` 才真正下发；`hex mock clear` 发空规则关闭设备端 Mock 但不改本地文件。

### 核心类型定义（`src/types/device.ts`）

`DeviceHello`、`DeviceClient`、`DeviceClientPublic`、`VALID_PLATFORMS` 等核心类型统一在此定义，`command-socket.ts` re-export 供下游使用。新增设备字段时同步更新此文件。

## 参考资料

- 用户文档 / 排错 / 完整参数：`README.md`、`skills/hex-cli/SKILL.md`（更新更勤）、`skills/hex-cli/reference.md`
- 人工回归用例：`docs/manual-test-cases.md`
- 端侧通信契约 v3：`src/daemon/server.ts` 顶部注释

### 鸿蒙 hdc 命令参考（HarmonyOS / OpenHarmony）

> 用于 CLI 侧 `launchHarmonyOSApp`、`screen`、`inspect`、`tap --text` 等本机直发命令，与 Android 的 `adb` 对位。

**关键 hdc 命令**：

| 用途 | 命令 |
|---|---|
| 获取屏幕分辨率 + density | `hdc -t <udid> shell hidumper -s RenderService -a screen` |
| 获取 density（备用，所有机型可用） | `hdc -t <udid> shell hidumper -s DisplayManagerService -a -a` |
| 获取视图树 | `hdc -t <udid> shell uitest dumpLayout [-i] -p /data/local/tmp/hex_dump.json` |
| 点击 | `hdc -t <udid> shell uitest uiInput click <x> <y>` |
| 滑动 | `hdc -t <udid> shell uitest uiInput swipe <x1> <y1> <x2> <y2> <velocity>` |
| 截图 | `hdc -t <udid> shell uitest screenCap -p /data/local/tmp/hex_screenshot.png` |
| 拉取文件 | `hdc -t <udid> file recv <remote> <local>` |

**基本启动命令**：

```bash
hdc shell aa start -a <abilityName> -b <bundleName> [-d <deviceId>] [--ps key value] [--pi key 123]
```

| 参数 | 说明 |
|---|---|
| `-a` | 指定 Ability 名称（默认 `EntryAbility`） |
| `-b` | 目标应用 bundleName |
| `-m` | moduleName（可选） |
| `-d` | 设备 ID（多设备时必填；等价于 `hdc -t <udid>` 前缀） |
| `--ps key value` | 字符串 Want 参数 |
| `--pi key value` | 整型 Want 参数 |
| `--pb key value` | 布尔 Want 参数 |
| `-U` | URI（隐式启动用） |
| `-A` | action（隐式启动用） |

**关键约束**：

- `--ps` 的 value **不能以中划线 `-` 开头**（鸿蒙 hdc 限制）
- 含空格 / 特殊字符时把 `aa ...` 整体用引号包裹：`hdc shell "aa start -A 'xxx' -U 'yyy'"`
- 多设备必须 `-d <deviceId>` 或 `hdc -t <udid>` 显式指定
- 成功返回 `start ability successfully.`，失败返回错误信息
- 强制停旧：`hdc shell aa force-stop <bundleName>`
- 枚举设备：`hdc list targets`（每行一个序列号，无表头）
- 获取设备名：`hdc -t <udid> shell param get const.product.name`

**CLI 侧启动注入契约**（`src/utils/launcher.ts::launchHarmonyOSApp`）：

```bash
hdc -t <udid> shell aa start -a EntryAbility -b <bundleId> \
  -d <udid> \
  --ps Hex_XCTest_Web_Server_Ip "<ws://ip:port>" \
  --ps Hex_Device_UDID "<udid>"
```

端侧 SDK 从 `abilityWant.parameters` 读取这两个 key，与 iOS（环境变量）/ Android（intent extras `--es`）语义对齐。
