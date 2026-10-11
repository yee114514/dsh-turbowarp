# dsh-turbowarp

让 DSH 的 agent 在你**正在用的 TurboWarp** 里做 Scratch 项目：
写脚本、画造型、加声音、跑起来、看截图，然后接着改。

它不修改 TurboWarp 本身，也不往你的项目里塞看不见的东西——只是在旁边操作它，
就像另一个坐在电脑前的人。

---

## 它能做什么

对 agent 说一句「用 scratch 工具做个接苹果的小游戏」，它就会自己开工：
新建项目 → 画苹果和篮子 → 写脚本 → 按键测试 → 看舞台截图 → 发现问题再改。

具体一点，它能：

- **写脚本**：用 Scratch 自己的积木方言（可读的 XML），支持自定义积木和脚本注释。
- **画美术**：造型和背景直接写 SVG；也可以给位图。
- **加声音**：给个音高和时长就**合成**一个（上滑＝跳跃/得分，下滑＝失败，游戏音效基本就这两种）。
- **建变量、列表、角色**，改名字、摆位置、调大小。
- **真的跑起来**：点绿旗、推进 N 秒、返回坐标和变量值，还能截图给模型"看"。
- **模拟键盘和鼠标**：这是测游戏唯一靠谱的办法——按住空格键，看小人有没有动。
- **不打开 TurboWarp 也能改文件**：手上有个 `.sb3`，可以直接读它、改它、存回去。

## 快速开始

```powershell
# 1. 装进你要用的 profile（两个都装也可以）
dsh plugin --profile dsh-tui add https://github.com/yee114514/dsh-turbowarp
dsh plugin --profile web     add https://github.com/yee114514/dsh-turbowarp

# 2. 告诉插件 TurboWarp 装在哪（也可以写进配置文件，如下）
$env:TURBOWARP_SCRATCH_APP_PATH = 'E:\turbowarp-portable\TurboWarp.exe'

# 3. 重启 DSH
```

装完可以用 `dsh --profile <profile> --dump-config` 确认配置里真的出现了
`turbowarp-scratch` 这一行。第一次安装如果中途断网，可能会**静默回滚**（配置文件不变），
重跑一次即可。

> **改完代码要重启 DSH 才生效。** 宿主面插件不支持热重载。

## 前置条件

| 项 | 要求 |
| --- | --- |
| Node | `^22.19` 或 `>=24` |
| TurboWarp Desktop | 1.16.0 已验证（Windows 便携版） |
| 模型 | 需要能看图片，否则截图会降级成"把 PNG 写到某个路径，你自己去读" |

插件通过 Chrome DevTools 协议连进编辑器，所以 **TurboWarp 必须带调试端口启动**。
`scratch_launch` 会替你加这个参数。

### 一个必须知道的坑：单实例锁

TurboWarp 只允许开一个窗口。如果你已经从开始菜单启动了它，那个窗口**没有调试端口**，
插件连不上——这时 agent 会告诉你"关掉它再让我启动"，照做即可。

想自己启动的话：

```powershell
TurboWarp.exe --remote-debugging-port=9222
```

## 配置

写进 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: turbowarp-scratch
  config:
    appPath: 'E:\turbowarp-portable\TurboWarp.exe'
    port: 9222
    autoLaunch: true
```

**每个键都有默认值**，都可以省略。因为"TurboWarp 装在哪"是机器级事实、在两个 profile 里
写两遍很烦，所以也支持环境变量覆盖：

| 配置键 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `appPath` | `TURBOWARP_SCRATCH_APP_PATH` | 自动探测常见安装位置 | `TurboWarp.exe` 的绝对路径 |
| `port` | `TURBOWARP_SCRATCH_PORT` | `9222` | 调试端口 |
| `autoLaunch` | `TURBOWARP_SCRATCH_AUTO_LAUNCH` | `false` | 连不上时是否自动拉起 TurboWarp |
| `leaseIdleMs` | — | `300000` | 编辑权空闲多久后自动让出 |
| `launchTimeoutMs` | — | `45000` | 等待编辑器就绪的上限 |
| `maxTextChars` | — | `20000` | 单个工具输出的文本上限 |
| `screenshotOnRun` | — | `true` | 跑完是否附一张舞台截图 |
| `allowOutsideWorkspace` | — | `false` | 是否允许读写会话工作目录之外的路径 |
| `enableSystemPrompt` | — | `false` | 是否注入一段简短的提示词 |
| `registerSkill` | — | `true` | 是否注册 `scratch-authoring` 技能 |
| `debug` | `DSH_TUI_DEBUG` | `false` | 把诊断写到 stderr |

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `scratch_status` | 端口、连接、打开的项目、谁在编辑。**出问题先看它** |
| `scratch_launch` | 带调试端口拉起 TurboWarp，等它就绪 |
| `scratch_open` | 把磁盘上的项目载入编辑器 |
| `scratch_new` | 新建项目（舞台 + 一个起始角色）；`empty:true` 只要舞台 |
| `scratch_sprite` | 新建空角色（只留你给的造型）、复制角色、重命名、删除、选中 |
| `scratch_costume` | 加造型，或给舞台加背景。写 SVG 或给位图 |
| `scratch_sound` | 加声音：合成一个，或上传字节 |
| `scratch_extension` | **打开扩展**（画笔、音乐、朗读、翻译…），或看看现在开了哪些 |
| `scratch_variable` | 建、改、重命名、删 变量与列表（全局或角色私有） |
| `scratch_place` | 直接摆位置、朝向、大小、显隐，不写脚本 |
| `scratch_inspect` | 读项目：角色、造型、变量、脚本。**给 `path` 就读磁盘上的文件，不需要编辑器** |
| `scratch_apply` | 写脚本。**给 `path` 就改磁盘上的文件，不需要编辑器** |
| `scratch_run` | 点绿旗，推进 N 秒，返回运行状态 + 舞台图 |
| `scratch_input` | 模拟键盘鼠标。**测游戏必须用它** |
| `scratch_stop` | 停止所有脚本（红色停止牌） |
| `scratch_observe` | 读运行状态：坐标、造型、变量值、线程数 |
| `scratch_screenshot` | 只截一张舞台图 |
| `scratch_save` | 导出成 `.sb3` |

写脚本前可以先 `scratch_apply` 加 `dryRun: true`：只检查不落地。**有问题的脚本会被拒绝应用**，
免得留下半个坏项目。

### 扩展

画笔、音乐、朗读、翻译这些都要先打开，方块才会真的动：

```
scratch_extension {action:'load', extensions:['pen']}     # 打开画笔
scratch_extension {}                                      # 看看开了哪些、还能开哪些
```

内置的十二个：`pen`（画笔）、`music`（音乐）、`text2speech`（朗读）、`translate`（翻译）、
`videoSensing`（摄像头动作）、`makeymakey`、`microbit`、`wedo2`、`ev3`、`boost`、
`gdxfor`（这五个要接硬件）、`tw`（TurboWarp 附加）。

自定义扩展传 URL 就行，和你在编辑器里粘贴一个扩展是一样的；插件会把 URL 记进项目，
免得换台机器就打不开。

一个容易踩的坑：编辑器面板上那个方块叫 `pen down`，但脚本里要写 `pen_penDown`。
插件在打开扩展时会把对照表打出来，照着抄就不会错。

## 两种用法

| | 对着 TurboWarp 用 | 直接改文件 |
| --- | --- | --- |
| 前提 | 编辑器开着 | 只要一个 `.sb3` |
| 读 | `scratch_inspect` | `scratch_inspect {path}` |
| 写 | `scratch_apply` | `scratch_apply {path}`（可 `outPath` 另存） |
| 跑 / 看 | `scratch_run` / `scratch_screenshot` / `scratch_input` | 做不到——没有编辑器就没有运行时 |
| 画造型、加声音、建变量、建角色 | 都可以 | 做不到（这些要用到运行时） |
| 打开扩展 | `scratch_extension` | 做不到——但读项目时会告诉你它**需要**哪些扩展 |

两种方式用**同一套脚本格式**，所以「读出来 → 改 → 写回去 → 打开看」是一条完整通路。

路径默认限制在会话工作目录内；要写到外面得显式开 `allowOutsideWorkspace`。

## 排错

| 现象 | 原因与做法 |
| --- | --- |
| `TurboWarp is running but not listening on the debug port` | 单实例锁。关掉它，再让 agent 调 `scratch_launch` |
| `no TurboWarp executable found` | 设 `appPath` 或 `TURBOWARP_SCRATCH_APP_PATH` |
| 工具没出现在模型目录里 | 确认 `dsh --profile <p> --dump-config` 里有 `turbowarp-scratch` 行，然后重启 DSH |
| 脚本跑了但画面没变 | 不是 bug：截图前会主动重绘。若用了 `screenshot: false`，画面可能还是旧的 |
| 截图变成了一个文件路径 | 这个部署没有图片附件服务，插件按设计写成 PNG 文件，读那个文件即可 |
| `session ... is driving TurboWarp` | 另一个会话持有编辑权。等它空闲，或传 `force: true` 抢占 |
| 写文件被拒 | 默认只允许会话工作目录内。改到工作目录里，或设 `allowOutsideWorkspace: true` |
| 舞台是白的 | 空项目没有背景，正常。打开一个有造型的项目作为起点 |

## 当前限制

- **云变量没做。**
- **它不是 TurboWarp 的扩展。** 不会出现在 TurboWarp 的「添加扩展」列表里，也不改 TurboWarp
  的界面或代码——它是从外面驱动编辑器，所以 TurboWarp 得开着、并且带调试端口。
- **没有发布到 npm**，所以不能按包名安装，要指定路径（或 git 地址）：
  `dsh plugin --profile <p> add E:/dsh-turbowarp`。
  （顺带说明：`dsh plugin` 本身就是把参数转发给 profile 目录里的 pnpm，没有额外的插件市场。）
- 只在 `dsh-tui` 和 web 上验证过，**没在 desktop surface 上验证**。
- 「新建角色」的实现是"复制一个已有角色，再把脚本、私有变量和造型清空换成你给的"，
  所以项目里至少要有一个角色可复制——这就是新建项目会自带一个起始角色的原因。

## 卸载

```powershell
dsh plugin --profile dsh-tui remove dsh-turbowarp
dsh plugin --profile web     remove dsh-turbowarp
```

删掉即可完全还原：它不写应用数据目录，不改 TurboWarp，也不打包任何 Scratch 美术资源。

---

## 想改这个插件

开发相关的约定、上游陷阱、怎么跑测试、怎么加新工具，都写在
[`AGENTS.md`](./AGENTS.md) 里——那份是给**改代码的 agent** 看的，这份 README 是给人看的。

一句话版本：

```powershell
node --test                 # 单元测试
node tools/e2e.mjs          # 验收测试（会驱动真的编辑器）
```

改代码时请守住两条：**不碰 TurboWarp 的代码**，**零第三方依赖**。
