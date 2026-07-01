# HexCli - 环境配置调试命令行工具

HexCli 是从 Doraemon macOS 应用中迁移的 CLI 工具，通过 WebSocket 与移动设备通信，提供环境配置、页面调试、配置查询等功能。

> ## ⚠️ BREAKING CHANGE — 3.0.0 多设备硬切
>
> 3.0.0 是一次**不兼容的硬切升级**，CLI、Daemon、iOS/Android SDK 必须配套，与 2.x 完全不互通。
>
> | 组件 | 必须版本 |
> |------|----------|
> | `@ali/hexcli` | `>= 3.0.0` |
> | iOS SDK (`ECHRemoteDebug`) | `>= 1.0.0` |
> | Android SDK (`divine_alibaba` / `divine_launch`) | `>= 1.0.0` |
>
> **主要变更：**
> - 多台设备可同时接入 daemon 不互踢；每个连接由端侧 `Hex_Device_UDID` 注入身份
> - 移除全部命令的 `--platform` flag；`--udid` 是唯一显式设备入口
> - 旧版 SDK 接入会在 1s 后被 daemon 关闭，并回写 `version-mismatch` 提示
> - 新增 `hex device list|use|clear|disconnect` 命令族
> - 新增 `~/.hexcli/session.json` 默认设备记忆
>
> **回退入口：** `npm i -g @ali/hexcli@2.0.1`

## 安装 / 更新

一行命令（首次安装或后续更新均可）：

```bash
[ -d ~/.hex-cli ] && (cd ~/.hex-cli && git pull) || git clone <your-repo-url> ~/.hex-cli; cd ~/.hex-cli && npm install && npm run build && npm link
```

安装完成后即可在任意位置使用 `hex` 命令。

卸载：

```bash
npm unlink -g hex && rm -rf ~/.hex-cli
```

## 快速开始

```bash
# 1. 启动手机应用（自动检测设备平台，Daemon 服务自动启动）
hex open

# 2. 执行命令
hex query appinfo
hex env online

# 3. 用完后停止服务
hex stop
```

## 架构说明

Hex 采用 **Daemon + 独立命令** 架构：

- **Daemon**：后台常驻进程，维持 WebSocket Server（端口 12588）与设备通信，同时提供 IPC HTTP Server（端口 12589）接收命令请求
- **独立命令**：每条命令独立执行，通过 IPC 连接 Daemon 发送指令，执行完毕后退出

所有命令会自动管理 Daemon 生命周期：
- Daemon 未运行 → 自动启动
- 无设备连接 → 提示执行 `hex open`
- 已就绪 → 直接执行命令

---

## 命令参考

### 设备管理

#### `hex open` — 启动手机端应用

```bash
hex open [--udid <udid>]
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--udid` | 指定设备 UDID/Serial（多设备必填） | 单设备时自动选中 |

选择规则：
- 本机仅 1 台设备时，零参数自动拉起
- 本机 ≥2 台设备时，必须用 `--udid` 显式指定，否则报错并列出候选
- 平台由 udid 自动反查（无需 `--platform`）

示例：

```bash
hex open                                          # 单设备：直接拉起
hex open --udid 00008110-001A0C2A0E81801E         # 指定 iOS
hex open --udid ABCD1234                          # 指定 Android
```

#### `hex stop` — 停止 Daemon 服务

```bash
hex stop
```

---

### 多设备路由

3.0.0 起，daemon 支持多台 iOS/Android 设备同时接入。所有需要下发设备的命令统一通过全局 `--udid` 选择目标。

#### 全局 `--udid`

```bash
hex --udid <udid> <command> [...args]
hex <command> [...args] --udid <udid>     # 等价（commander preAction 注入）
```

#### 选择优先级

1. 命令行 `--udid` 显式指定
2. `~/.hexcli/session.json` 中的默认设备（且在线）
3. 仅 1 台在线 → 自动选中
4. ≥2 台且未指定 → 报错并列出候选

#### `hex device list` — 列出设备

```bash
hex device list
```

表格输出：编号 / 默认 / 平台 / 名称 / UDID / 状态 / AppVer / 已连接时长。合并本地 USB 设备（`connected`）与 Daemon 在线设备（`online`），`★` 标记当前 session 默认设备。

#### `hex device use <udid>` — 设置默认设备

```bash
hex device use 00008110-001A0C2A0E81801E
```

写入 `~/.hexcli/session.json`，后续命令在多设备场景下自动定向到该设备，无需每次都打 `--udid`。设备离线 7 天自动失效。

#### `hex device clear` — 清除默认设备

```bash
hex device clear
```

#### `hex device disconnect <udid>` — 主动断开设备

```bash
hex device disconnect ABCD1234
```

通过 daemon 关闭对应 WebSocket。若清掉的是默认设备，session 同步失效。

#### 多设备示例

```bash
# 两台设备同时接入
hex open --udid 00008110-001A0C2A0E81801E
hex open --udid ABCD1234

hex device list
#  #  默认  平台      名称           UDID                                状态     APP_VER  连接
#  1   ★    ios       iPhone 15 Pro  00008110-001A0C2A0E81801E           online   7.10.0   12s
#  2        android   Pixel 8        ABCD1234                            online   7.10.0   8s

# 用 --udid 临时指定
hex query appinfo --udid ABCD1234

# 设置默认后省略 --udid
hex device use 00008110-001A0C2A0E81801E
hex query appinfo            # → iPhone 15 Pro
hex screenshot               # → iPhone 15 Pro
```

---

### 基础环境设置 (`hex env`)

#### `hex env online` — 切换到线上环境

```bash
hex env online
```

#### `hex env pre` — 切换到预发环境

```bash
hex env pre
```

#### `hex env gray` — 灰度开关

```bash
hex env gray --on     # 开启灰度
hex env gray --off    # 关闭灰度
```

#### `hex env downgrade` — 降级开关

```bash
hex env downgrade --on     # 开启降级
hex env downgrade --off    # 关闭降级
```

#### `hex env cybert` — CyberT 组件调试开关

```bash
hex env cybert --on     # 开启 CyberT 调试
hex env cybert --off    # 关闭 CyberT 调试
```

#### `hex env https-downgrade` — HTTPS 降级开关

```bash
hex env https-downgrade --on     # 开启 HTTPS 降级
hex env https-downgrade --off    # 关闭 HTTPS 降级
```

---

### 页面配置

#### `hex open-url` — 在设备上打开页面

```bash
hex open-url <url>
```

示例：

```bash
hex open-url "https://m.1688.com"
hex open-url "https://scan.m.1688.com/index.htm"
```

#### `hex whitelist` — 域名白名单管理

```bash
hex whitelist <host>             # 添加单个域名白名单
hex whitelist --all-pass-on      # 开启全域名白名单（放行所有域名）
hex whitelist --all-pass-off     # 关闭全域名白名单（恢复域名拦截）
```

示例：

```bash
hex whitelist "m.1688.com"         # 添加单个域名
hex whitelist --all-pass-on        # 放行所有域名
```

#### `hex redirect` — URL 重定向

```bash
hex redirect --type <type> --source <source> --target <target>
```

| 选项 | 说明 |
|------|------|
| `--type` | 重定向类型：`urlToUrl`、`pathToUrl`、`regexToUrl` |
| `--source` | 源 URL / 路径 / 正则表达式 |
| `--target` | 目标 URL |

示例：

```bash
hex redirect --type urlToUrl --source "https://old.example.com" --target "https://new.example.com"
hex redirect --type pathToUrl --source "/old-path" --target "https://new.example.com/page"
hex redirect --type regexToUrl --source ".*old.*" --target "https://new.example.com"
```

---

### 配置查询 (`hex query`)

#### `hex query appinfo` — 查询应用构建信息

```bash
hex query appinfo
```

#### `hex query orange` — 查询 Orange 配置

```bash
hex query orange <groupName>
```

示例：

```bash
hex query orange "MyConfigGroup"
```

#### `hex query ab` — 查询 AB 测试

```bash
hex query ab --component <component> [--module <module>]
```

示例：

```bash
hex query ab --component "AB_SearchResult"
hex query ab --component "AB_Homepage" --module "feed"
```

#### `hex query cookie` — 查询 Cookie

```bash
hex query cookie          # 查询 Native Cookie
hex query cookie --web    # 查询 WebView Cookie
```

---

### Mock 功能 (`hex mock`)

自 2.0.0 起，Mock 模块改为 **声明式单文件 + 4 命令** 模型。所有规则集中维护在 `~/.hexcli/mock.json`，由 `hex mock apply` 显式下发到设备、`hex mock clear` 显式关闭。

#### 配置文件结构

```jsonc
{
  "rules": [
    {
      "method": "mtop.alibaba.search",   // 必填，模糊匹配
      "params": "keyword",                // 选填，模糊匹配，默认 ""
      "content": { "ret": ["SUCCESS::"], "data": {} }
    },
    {
      "method": "mtop.item.detail",
      "content": "{\"raw\":true}"         // 字符串原样下发
    },
    {
      "method": "mtop.taobao.x.query",
      "contentFile": "~/mocks/x.json"     // 从外部文件读取
    }
  ],
  "headers": {
    "X-Trace-Id": "abc"
  }
}
```

字段说明：
- `rules[].method` — 必填，API 方法名（模糊匹配）
- `rules[].params` — 选填，请求参数匹配条件（模糊匹配）
- `rules[].content` 与 `rules[].contentFile` **二选一必填**，同时存在则报错
  - `content` 可写对象（CLI 自动 stringify）或字符串
  - `contentFile` 路径解析顺序：绝对路径 → `~/` 展开 → 相对 `~/.hexcli/`
- `headers` — 对象形式的自定义 HTTP Header，apply 时一并下发

#### `hex mock init` — 生成模板

```bash
hex mock init
```

在 `~/.hexcli/mock.json` 写入示例模板。文件已存在则报错，避免覆盖。

#### `hex mock show` — 查看将下发的负载（不联机）

```bash
hex mock show
```

解析并校验配置文件，打印将下发的 `mtopMock` payload。常用于调试配置写得对不对。

#### `hex mock apply` — 下发到设备

```bash
hex mock apply
```

读取配置 → 校验 → 下发到设备（要求 daemon 在线且设备已连接）。失败时打印具体错误。

#### `hex mock clear` — 清空设备端规则

```bash
hex mock clear
```

下发空规则集，关闭设备端 Mock 与自定义 Header。**不修改本地文件**，下次 `apply` 仍恢复原配置。

#### 命令对照表（旧 → 新）

| 旧命令 | 新做法 |
|--------|--------|
| `hex mock on` | `hex mock apply` |
| `hex mock off` | `hex mock clear` |
| `hex mock add` | 编辑 `~/.hexcli/mock.json` 后 `hex mock apply` |
| `hex mock edit` | 同上 |
| `hex mock remove --id` | 同上（删除对应数组项） |
| `hex mock remove --all` | 清空 `rules` 数组后 `hex mock apply`；或 `hex mock clear`（不改文件） |
| `hex mock list` | `hex mock show` 或直接看文件 |
| `hex mock sync` | `hex mock apply`（语义合并） |
| `hex mock header add/remove/list` | 编辑 `headers` 字段后 `hex mock apply` |

> Mock 配置统一存储在 `~/.hexcli/mock.json`。文件即真相，规则数量无上限。修改后必须显式执行 `hex mock apply` 才会影响设备。

---

### UI 自动化

#### `hex tap` — 点击

```bash
# 坐标模式
hex tap -x <x> -y <y> [--duration <ms>] [--udid <udid>]
# 文本模式
hex tap --text <text> [--exact] [--index <n>] [--udid <udid>]
```

| 选项 | 说明 |
|------|------|
| `-x` `-y` | 坐标（与 --text 互斥） |
| `--text` | 按文本查找元素并点击（与 -x/-y 互斥） |
| `--exact` | 精确匹配文本（默认模糊） |
| `--index` | 多个匹配时点击第 n 个（默认 1） |
| `--duration` | 长按毫秒数（仅坐标模式） |

坐标单位：iOS = pt、Android = dp、HarmonyOS = vp。

#### `hex swipe` — 滑动

```bash
hex swipe --from <x1>,<y1> --to <x2>,<y2> [--duration <ms>]
hex swipe -x <x1> -y <y1> --x2 <x2> --y2 <y2> [--duration <ms>]
```

#### `hex back` — 返回上一页

```bash
hex back
```

#### `hex screen` — 查询屏幕宽高

```bash
hex screen [--udid <udid>]
```

输出格式：`<宽>x<高> <单位> @<密度>`

| 平台 | 单位 | 密度标识 | 示例 |
|------|------|----------|------|
| iOS | pt | `@<scale>x` | `390x844 pt @3x` |
| Android | dp | `@<dpi>dpi` | `360x780 dp @420dpi` |
| HarmonyOS | vp | `@<density>x` | `1379x1967 vp @1.61875x` |

#### `hex screenshot` — 设备截图

```bash
hex screenshot [-o <path>] [--udid <udid>]
```

默认保存到 `~/Desktop/`。

#### `hex inspect` — 查看视图树

```bash
hex inspect [--json] [--all] [--udid <udid>]
```

| 选项 | 说明 |
|------|------|
| `--json` | JSON 格式输出（默认树形文本） |
| `--all` | 显示完整视图树（含系统 UI、多 Window） |

输出包含每个元素的类型、文本、frame（坐标+宽高）。坐标单位与 `hex tap` 一致，可直接复制用于点击操作。

---

### 一键登录

#### `hex login` — 一键登录设备应用

```bash
hex login --havana-id <id> --sso-key <key>
```

| 选项 | 说明 | 必填 |
|------|------|------|
| `--havana-id` | Havana ID | 是 |
| `--sso-key` | SSO Key | 是 |

示例：

```bash
hex login --havana-id 2219654313054 --sso-key "4114126c44c969125d952945"
```

---

## 通信协议

- **WebSocket Server** 端口：12588
- **IPC HTTP Server** 端口：12589
- 设备通过 WebSocket 连接到 Mac，命令以 JSON 格式发送（binary frame）
- 消息格式：`{ "command": "commandName", "uuid": "...", "params": {...} }`
- 响应格式：`{ "command": "commandName", "uuid": "...", "result": {...} }`

## 项目结构

```
HexCli/
├── bin/hex.js              # CLI 可执行入口
├── src/
│   ├── index.ts               # Commander.js 主入口（注册全局 --udid + preAction hook）
│   ├── commands/
│   │   ├── env.ts             # 基础环境设置命令组
│   │   ├── h5.ts              # 页面配置命令（open-url/whitelist/redirect）
│   │   ├── query.ts           # 查询命令组
│   │   ├── mock.ts            # Mock 规则管理命令组
│   │   ├── login.ts           # 一键登录命令
│   │   ├── open.ts            # 启动手机应用命令（按 udid 自动反查平台）
│   │   ├── stop.ts            # 停止 Daemon 命令
│   │   ├── devices.ts         # hex device list/use/clear/disconnect 命令族
│   │   ├── debug.ts           # 调试事件流（按 deviceId 订阅 + 日志分桶）
│   │   ├── screenshot.ts      # 设备截图（本地，按 udid 直发）
│   │   ├── tap.ts             # 触控模拟 + 按文本点击（本地，按 udid 直发）
│   │   ├── screen.ts          # 查询屏幕宽高（iOS pt / Android dp / HarmonyOS vp）
│   │   └── inspect.ts         # 查看视图树（WDA / uiautomator / uitest dumpLayout）
│   ├── daemon/
│   │   ├── server.ts          # Daemon 服务端（WS + IPC HTTP，selector + /devices）
│   │   ├── client.ts          # Daemon 客户端（ensureDaemon/sendToDaemon/listDevices）
│   │   └── startup.ts         # Daemon 独立启动脚本
│   ├── mock/
│   │   ├── store.ts           # Mock 配置文件读写与校验（~/.hexcli/mock.json）
│   │   └── sync.ts            # Mock payload 下发到设备
│   ├── socket/
│   │   └── command-socket.ts  # WebSocket 通信层（DeviceRegistry + hello + dispatch）
│   └── utils/
│       ├── logger.ts          # 日志工具
│       ├── network.ts         # 网络工具（获取本机 IP）
│       ├── port.ts            # 端口管理工具
│       ├── launcher.ts        # 应用启动工具（iOS/Android，注入 Hex_Device_UDID）
│       ├── selector.ts        # 设备选择器（resolveTarget 5 步优先级链）
│       ├── dispatch.ts        # 命令分发助手（绑定 selector）
│       ├── session.ts         # 默认设备记忆（~/.hexcli/session.json）
│       ├── global-opts.ts     # 全局 --udid 注入
│       ├── debug-worker.ts    # debug 流后台 worker（按 deviceId 分桶日志）
│       └── harmony-layout.ts  # HarmonyOS uitest dumpLayout 共享工具
├── package.json
├── tsconfig.json
└── tsup.config.ts
```
