# HexCli 完整参数参考

## 全局选项

```bash
hex --version                          # 当前版本
hex --help                             # 主帮助（按分组列出所有命令）
hex --udid <udid> <subcommand> [...]   # 全局指定设备（preAction hook 注入到下游命令）
```

UDID 字符集白名单：`[A-Za-z0-9._:-]`，含其他字符直接拒绝（防 shell 注入）。

---

## 会话生命周期

### `hex open` — 启动手机端应用

```bash
hex open [--udid <udid>] [--bundle-id <id>] [--no-wait]
```

| 选项 | 说明 | 默认 |
| --- | --- | --- |
| `--udid` | 设备 UDID/Serial | 单设备时自动选中 |
| `--bundle-id` | 目标 App 包名 | `com.alibaba.wireless`（iOS / Android 同名） |
| `--no-wait` | launch 后立即返回，不等设备 hello 注册 | false（兼容旧版 SDK 时启用） |

行为：
- 自动按 udid 反查平台（无需 `--platform`）
- iOS 通过 `xcrun devicectl device process launch` 启动；Android 通过 `cmd package query-activities -a MAIN -c LAUNCHER` 解析 LAUNCHER Activity 后 `am start -n`；HarmonyOS 通过 `hdc shell aa start -a EntryAbility -b <bundleId>` 启动
- 通过 Intent extra / Want 参数 `Hex_Device_UDID` + `Hex_XCTest_Web_Server_Ip` 注入设备身份和 WebSocket 地址
- 默认等待端侧发 `hello` 帧后才返回成功
- HarmonyOS 默认 bundle-id 为 `com.alibaba.wireless_hmos`（其他平台为 `com.alibaba.wireless`）

### `hex stop` — 停止当前调试会话

```bash
hex stop [-v] [--udid <udid>] [--bundle-id <id>]
```

| 选项 | 说明 |
| --- | --- |
| `-v, --verbose` | 显示详细进度日志 |
| `--udid` | 仅停指定设备 |
| `--bundle-id` | 目标 App 包名 |

执行顺序（最长 15s 强制退出）：
1. 停手机端 App（10s 超时）
2. 停 debug worker（3s 超时）
3. 停 Daemon 进程（kill PID）
4. 清理 `~/.hexcli/daemon.json`

---

## 多设备路由

### `hex device list`

表格输出（双行表头）：

```
#  默认  平台   名称   UDID  USB     WS        AppVer  WS 时长
                            (本机)  (Daemon)
```

- `USB ✔` = 本机 USB 已接入（可执行 `hex open` / `hex tap` / `hex screenshot`）
- `WS ✔` = App 已通过 WebSocket 连到 Daemon（可执行下发类命令）
- `★` 标记 session 默认设备

### `hex device use <udid>`

写入 `~/.hexcli/session.json`：

```json
{
  "defaultDeviceId": "00008110-001A...",
  "defaultDeviceLabel": "ios·iPhone 15 Pro (00008110-...)",
  "rememberedAt": 1717000000000,
  "rememberedBy": "explicit"
}
```

- 设备未在线时仍写入，上线后自动生效
- 默认设备离线 7 天自动失效

### `hex device clear`

删除 `~/.hexcli/session.json`，回到"无默认设备"状态。

### `hex device disconnect <udid>`

通过 Daemon IPC 主动关闭 WebSocket。若清掉的是默认设备，session 同步失效。

---

## 环境切换 `hex env`

> 所有 `env` 子命令成功后会自动重启目标 App（`stopApp` → `launchApp`），失败时 fallback 提示手动 `hex open`。

| 命令 | 参数 | 端侧命令 | 说明 |
| --- | --- | --- | --- |
| `hex env online` | — | `networkOnline { isOnline: true }` | 切线上 |
| `hex env pre` | — | `networkOnline { isOnline: false }` | 切预发 |
| `hex env gray --on/--off` | 必须二选一 | `rocGray { isGray }` | 灰度 |
| `hex env downgrade --on/--off` | 同上 | `demoteSpdy { demoteSpdy, persistance: true }` | 降级 |
| `hex env cybert --on/--off` | 同上 | `widgetDebug { open }` | CyberT 调试 |
| `hex env https-downgrade --on/--off` | 同上 | `httpsDemote { isOpen }` | HTTPS 降级 |

`--on` 与 `--off` 必须明确给一个，都不给会报错。

---

## 页面与重定向

### `hex open-url <url>`

```bash
hex open-url "https://m.1688.com/path?x=1"
```

端侧命令：`openUrl { url }`。

### `hex whitelist`

```bash
# 添加单个域名白名单
hex whitelist "m.1688.com"
# 开启全域名白名单（放行所有域名）
hex whitelist --all-pass-on
# 关闭全域名白名单（恢复域名拦截）
hex whitelist --all-pass-off
```

| 参数 / 选项 | 端侧命令 | 说明 |
| --- | --- | --- |
| `<host>` | `addWhiteHost { whiteHost }` | 添加单个域名到白名单 |
| `--all-pass-on` | `allWhite { isOpen: true }` | 开启全域名白名单 |
| `--all-pass-off` | `allWhite { isOpen: false }` | 关闭全域名白名单 |

`<host>` 与 `--all-pass-on/--all-pass-off` 互斥，必须二选一，不能同时使用。

### `hex redirect`

```bash
hex redirect --type <type> --source <source> --target <target>
```

| `--type` | 匹配语义 |
| --- | --- |
| `urlToUrl` | source 与 URL 字符串完全相等（忽略 schema） |
| `pathToUrl` | source 与 URL 的 path 完全相等 |
| `regexToUrl` | source 作为正则匹配整条 URL |

端侧命令：`UrlRedirect { type, source, target }`。

- iOS：基于 `ECHRemoteDebug` 内部转发
- Android：注册到 Nav 框架原生 `Redirector` 接口（`HexUrlRedirector`），所有 `Navn.from().to(uri)` 自动经过；进程重启清空

---

## 配置查询 `hex query`

> 全部命令直接 IPC 调 Daemon，输出端侧返回的 JSON。

| 命令 | 端侧命令 | 参数 |
| --- | --- | --- |
| `hex query appinfo` | `appInfo` | — |
| `hex query orange <groupName>` | `orangeInfo { groupName }` | 必填 groupName |
| `hex query ab --component <comp> [--module <mod>]` | `ABTest { component, module }` | `--component` 必填；`--module` 默认 `""` |
| `hex query cookie [--web] [--url <url>]` | `cookie { webCookie, url }` | `--web` 默认 `false`，加上后查 WebView Cookie |
| `hex query lastpageapm` | `lastPageAPM` | — |
| `hex query launchapm` | `launchAPM` | — |

`appinfo` 会把端侧返回的 `appInfoString`（中文 key）映射成英文 key（`appName/appVersion/buildNumber/...`）后输出。

---

## Mock `hex mock`

配置文件：`~/.hexcli/mock.json`

```jsonc
{
  "rules": [
    {
      "method": "mtop.xxx.search",       // 必填，模糊匹配
      "params": "keyword",                // 选填，模糊匹配，默认 ""
      "content": { "ret": ["SUCCESS::"], "data": {} }   // 对象（CLI 自动 stringify）
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

字段约束：
- `rules[].method` 必填
- `rules[].content` 与 `rules[].contentFile` **二选一**，同时存在报错
- `contentFile` 路径解析顺序：绝对路径 → `~/` 展开 → 相对 `~/.hexcli/`
- `headers` 是对象形式，apply 时一并下发

| 命令 | 行为 |
| --- | --- |
| `hex mock init` | 写入 `~/.hexcli/mock.json` 模板，文件已存在则报错 |
| `hex mock show [-f]` | 不联机解析 + 校验，打印将下发的 payload。`-f/--full` 不截断超长字符串 |
| `hex mock apply` | 校验后下发到设备 |
| `hex mock clear` | 下发空规则集，关闭设备端 mock；**不修改本地文件** |

> 修改 `mock.json` 后必须显式 `hex mock apply` 才会影响设备。

---

## 一键登录

```bash
hex login --havana-id <id> --sso-key <key>
```

| 选项 | 说明 | 必填 |
| --- | --- | --- |
| `--havana-id` | Havana ID（数字） | 是 |
| `--sso-key` | SSO Key | 是 |

端侧命令：`oneKeyLogin { havanaId, ssoKey }`。

---

## UI 自动化

> 这一组是**本机直发**：不走 Daemon，按 `--udid` 直接对 USB 接入的设备操作。坐标单位跨平台一致：iOS = pt、Android = dp、HarmonyOS = vp（自动按 density 换算物理像素）。
>
> **最佳实践**：执行 `hex tap` / `hex swipe` 前先 `hex screen` 查询当前设备屏幕宽高，确保坐标在有效范围内，防止坐标越界。

### `hex tap` — 点击

```bash
# 先查屏幕宽高，确认坐标范围
hex screen
# 坐标模式
hex tap -x <x> -y <y> [--duration <ms>] [--udid <udid>]
# 文本模式
hex tap --text <text> [--exact] [--index <n>] [--udid <udid>]
```

| 选项 | 说明 |
| --- | --- |
| `-x` `-y` | 坐标（pt/dp），与 --text 互斥 |
| `--text` | 按文本内容查找并点击元素（与 -x/-y 互斥） |
| `--exact` | 精确匹配文本（默认模糊 CONTAINS） |
| `--index` | 匹配多个元素时点击第 n 个（默认 1） |
| `--duration` | 长按毫秒数；不传 = 普通点击（仅坐标模式） |
| `--udid` | 多设备必填 |

实现：
- iOS 坐标模式：通过 WDA 走 `/wda/tap` / `/wda/touchAndHold`
- iOS 文本模式：WDA `POST /elements`（predicate string: `label CONTAINS[cd] 'xxx' OR value CONTAINS[cd] 'xxx'`）→ `POST /element/{uuid}/click`
- Android 坐标模式：`adb shell input tap`（普通） / `input swipe x y x y duration`（长按）
- Android 文本模式：`uiautomator dump` → 解析 XML 匹配 text/content-desc → 计算 bounds 中心 → `input tap`
- HarmonyOS 坐标模式：`hdc shell uitest uiInput click x y`（普通） / `uitest uiInput longClick x y`（长按），vp 自动换算为 px
- HarmonyOS 文本模式：`hdc shell uitest dumpLayout` → 解析 JSON 控件树匹配 text/description → 计算 bounds 中心 → `uitest uiInput click cx cy`（物理像素）

### `hex tap reset`

```bash
hex tap reset [--udid <udid>] [--all]
```

| 选项 | 说明 | 默认 |
| --- | --- | --- |
| `--udid` | 仅重置指定设备的 iproxy 与端口映射（不动 `.xctestrun` 与其它设备） | — |
| `--all` | 重置全部：所有 iproxy / xcodebuild / `.xctestrun` / 端口映射 | **默认行为**（不传 `--udid` 时即按 `--all` 处理） |

适用场景：换设备、切 Xcode、WDA 卡死、`~/.hex-cli/wda-ports.json` 端口冲突。

### `hex swipe` — 滑动

```bash
# 先查屏幕宽高，确认坐标范围
hex screen
# 写法 A
hex swipe -x <x1> -y <y1> --x2 <x2> --y2 <y2> [--duration <ms>]
# 写法 B（更短）
hex swipe --from x,y --to x,y [--duration <ms>]
```

`--duration` 默认 500ms。

实现：
- iOS：通过 WDA `/wda/dragfromtoforduration`
- Android：`adb shell input swipe x1 y1 x2 y2 duration`
- HarmonyOS：`hdc shell uitest uiInput swipe x1 y1 x2 y2 velocity`（velocity 根据 distance/duration 自动计算，范围 200-40000）

### `hex back` — 返回

```bash
hex back
```

端侧命令：`navigateBack`（走 Daemon，不是本机直发）。

### `hex screen` — 查询屏幕宽高

```bash
hex screen [--udid <udid>]
```

| 选项 | 说明 |
| --- | --- |
| `--udid` | 多设备必填 |

输出单位与 `hex tap` / `hex swipe` 完全一致：

- **iOS**：pt（通过 `xcrun devicectl device info displays` 读取 `nativeSize / pointScale` 计算，需 Xcode 15+，**不依赖 WDA**）
- **Android**：dp（通过 `adb shell wm size` + `wm density` 计算：`dp = px / (dpi / 160)`）
- **HarmonyOS**：vp（通过 `hdc shell hidumper -s RenderService -a screen` 读取物理分辨率 + `DisplayManagerService` 获取 density：`vp = px / density`）

输出格式为单行 `<W>x<H> <unit>`，并附带密度标识（iOS 为 `@<scale>x`、Android 为 `@<dpi>dpi`、HarmonyOS 为 `@<density>x`）：

```
ℹ 目标设备: ios·iPhone (00008140-...)
390x844 pt @3x
```

```
ℹ 目标设备: android·SM S9210 (RFCX51815QK)
360x780 dp @420dpi
```

```
ℹ 目标设备: harmonyos·emulator (127.0.0.1:5555)
1379x1967 vp @1.61875x
```

### `hex screenshot` — 截图

```bash
hex screenshot [-o <path>] [--udid <udid>]
```

| 选项 | 说明 | 默认 |
| --- | --- | --- |
| `-o, --output` | 保存路径 | `~/Desktop/screenshot_<ISO 时间戳>.png` |
| `--udid` | 多设备必填 | — |

实现：
- iOS：通过 WDA `/screenshot` 接口拉 base64 PNG
- Android：`adb exec-out screencap -p`
- HarmonyOS：`hdc shell uitest screenCap -p <remote>` + `hdc file recv`（失败时 fallback `snapshot_display`）

### `hex inspect` — 查看视图树

```bash
hex inspect [--json] [--all] [--udid <udid>]
```

| 选项 | 说明 | 默认 |
| --- | --- | --- |
| `--json` | 以 JSON 格式输出 | 默认树形文本 |
| `--all` | 显示完整视图树（含系统 UI、多 Window） | 仅展示目标应用主窗口 |
| `--udid` | 多设备必填 | — |

输出包含每个元素的类型、文本、frame（坐标+宽高）。

实现：
- iOS：WDA `GET /session/{sid}/source?format=json`，默认只保留面积最大的主 Window
- Android：`uiautomator dump` 解析 XML，默认按前台包名过滤（只展示目标应用节点）
- HarmonyOS：`hdc shell uitest dumpLayout` 获取控件树 JSON，坐标 px ÷ density 转 vp（与 tap 单位一致）；`--all` 模式追加 `-i` 参数（不过滤不可见控件、不合并窗口），多窗口数组自动合并为 Screen 根节点
- 有 Dialog/浮层时：自动检测并通过 `dumpsys activity` 补充底层 Activity 的完整视图

---

## 实时调试 `hex debug`

```bash
hex debug [--type <types>] [--script <path>] [--stop] [--status] [--udid <udid>]
```

| 选项 | 说明 |
| --- | --- |
| `--type` | 逗号分隔过滤：`nav,ut,mtop,mtop-ssr` |
| `--script <path>` | 提供后命令立即返回，事件以 `<script> <type> <dataJson>` 形式异步回调 |
| `--stop` | 停止后台 debug worker |
| `--status` | 查看后台 worker 状态 |
| `--script-worker` | **内部参数，请勿手工使用**：父进程 fork worker 子进程时自带，标识进入 worker 模式 |
| `--udid` | 多设备必填 |

事件类型：

| Type | 来源 | 终端格式 |
| --- | --- | --- |
| `nav` | AppLog | `[time] [NAV] <message>` |
| `ut` | UT 埋点 | `[time] [UT] <eventName>` |
| `mtop` | mtop 接口 | `[time] [MTOP] <api> <method> <totalTime>ms` |
| `mtop-ssr` | mtop SSR | `[time] [MTOP-SSR] <api> <method> requestId:<id>` |

worker 模式日志：`~/.hexcli/logs/debug-<deviceId>.log`。

---

## CLI 维护

### `hex doctor`

无参数。一键体检：

- Node ≥ 18
- Daemon 端口（12588 / 12589）占用
- iOS：`xcrun devicectl` / `pymobiledevice3` / WDA 镜像
- Android：`adb` / 设备授权状态
- HarmonyOS：`hdc` / 设备连接状态
- `~/.hexcli/` 目录权限

输出每项 `ok / fail / warn / skip` + 修复建议命令。

### `hex update`

```bash
hex update
```

等价于（首次安装也用这条）：

```bash
npm i -g @ali/hexcli --registry=$HEX_NPM_REGISTRY
```

EEXIST 错误时会提示 `rm $(which hex)` 后重试。

### `hex doc`

打开 HexCli 文档页面（地址由环境变量 `HEX_DOC_URL` 配置）。

### `hex log`

```bash
hex log [-f] [-e] [-d <YYYY-MM-DD>] [-l] [--dir]
```

| 选项 | 说明 |
| --- | --- |
| 无参数 | `open` 当天日志 |
| `-f, --follow` | `tail -f` 实时跟随当天日志 |
| `-e, --error` | 只看 `<date>.error.log`（仅 ERROR 级别） |
| `-d, --date <YYYY-MM-DD>` | 指定日期，默认今天 |
| `-l, --list` | 列出日志目录所有 `.log` |
| `--dir` | 仅打印日志目录路径（适合 `cd $(hex log --dir)`） |

日志目录：`~/.hex-cli/logs/`（注意：与 daemon 系的 `~/.hexcli/` 是**两个不同目录**）。

---

## 本地存储路径速查

CLI 使用了两个 home 目录，按用途分工：

| 目录 | 内容 | 何时关注 |
| --- | --- | --- |
| `~/.hexcli/daemon.json` | Daemon 进程信息（PID / 端口 / 启动时间） | `hex stop` 清理 / 排错 daemon 占用 |
| `~/.hexcli/session.json` | `hex device use` 默认设备记录 | TTL 7 天 |
| `~/.hexcli/mock.json` | Mock 规则配置 | `hex mock` 全部子命令 |
| `~/.hexcli/debug/<deviceId>.log` | debug worker 分桶日志 | `hex debug --status` 后查看 |
| `~/.hexcli/debug.lock` | debug worker 启动锁 | 极少手动清理 |
| `~/.hex-cli/logs/<date>.log` | CLI 主日志（按天） | `hex log` |
| `~/.hex-cli/logs/<date>.error.log` | 仅 ERROR 级别 | `hex log -e` |
| `~/.hex-cli/WebDriverAgent/` | WDA Xcode 工程（iOS UI 自动化） | iOS 首次 `hex tap` 自动 clone |
| `~/.hex-cli/wda-ports.json` | 每台 iOS 设备的 WDA 本地端口（`8100-8199`） | 多设备并发；`hex tap reset` 会清空 |
| `~/.hex-cli/wda-ports.lock` | 端口分配锁（mkdir 风格，5s 重试） | 极少手动清理 |

---

## 通信协议（开发参考）

```
WebSocket Server : ws://<本机 IP>:12588
IPC HTTP Server  : http://127.0.0.1:12589

设备 → Daemon hello 帧（连接成功立刻发送）：
{
  "command": "hello",
  "params": {
    "deviceId": "00008110-001A...",     // = Hex_Device_UDID
    "platform": "ios",                   // ios | android | harmonyos
    "appVersion": "9.7.0",
    "deviceName": "iPhone 15 Pro",
    "sdkVersion": "1.0.0"
  }
}

CLI → Daemon → 设备命令格式（binary frame）：
{ "command": "<name>", "uuid": "<id>", "params": {...} }

设备 → Daemon → CLI 响应：
{ "command": "<name>", "uuid": "<id>", "result": {...} }
```

旧版 SDK（缺 `deviceId` 或版本低）会被 Daemon 1s 后关闭，并回 `version-mismatch` 提示升级。
