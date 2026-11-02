# 架构说明

## 分层

```
main.js          启动、存储选择（GM / localStorage）、油猴菜单、子框架降级
  ├── api.js     window.coursepilot 对外门面
  ├── engine.js  托管引擎：状态机 + 轮询主循环 + 会话统计
  │     ├── platforms/index.js   profile × quirk 组合
  │     ├── media.js             原生倍速读写 / 媒体快照
  │     └── dom.js              跨 iframe / Shadow DOM 探测
  ├── ui/panel.js Shadow DOM 面板
  ├── config.js   配置 schema + 持久化
  └── log.js      环形日志
```

依赖方向单向向下，没有循环依赖；`build.mjs` 里 `MODULES` 的顺序就是依赖顺序。

## 两种分发形态

同一份 IIFE 产物喂给两个宿主，功能完全一致：

| 宿主 | 入口 | 存储 | 限制 |
| --- | --- | --- | --- |
| Chrome / Edge 扩展 | `dist/extension/`（MV3） | 站点自己的 localStorage | 需要 Chrome 111+ |
| 油猴脚本 | `dist/coursepilot.user.js` | `GM_getValue` / `GM_setValue`，跨站点共享 | 需要脚本管理器 |

扩展的 `content_scripts` 必须声明 `world: "MAIN"`：雨课堂适配要读 DOM 元素上的 `__vue__` 与页面全局 `jQuery`，这两者都是主世界的 expando，隔离世界（isolated world）拿不到。代价是要求 Chrome 111+，且 `window.coursepilot` 对页面脚本可见。

`build.mjs` 里的 `MATCHES` 同时驱动油猴的 `// @match` 与扩展的 `content_scripts.matches`，避免两处清单漂移；扩展图标由 `scripts/make-icons.mjs` 在构建时用零依赖 PNG 编码器生成，仓库里不存二进制。

## 主循环

引擎用固定间隔轮询（默认 1000 ms，可配 300–5000 ms）而不是事件驱动，每次 `tick()` 做 10 件事：

1. **平台切换检测**：`location.href` 变化就重建适配器，重置分段计时
2. **找视频 / 分派内容**：适配器优先返回可见且就绪的视频；找不到就转 `tickDocument()` 做图文 / 资料识别
3. **就绪判断**：`readyState < 1` 时停在 `searching`，不碰未加载的媒体
4. **身份与源变更**：video 元素或 `currentSrc` 变化 → 重置分段
5. **倍速下发**：`|实际倍速 - 目标| > 0.01` 才写入，避免每帧打站点接口
6. **弹题检测**：只在视频暂停时判定，命中即 `blocked` 并直接返回
7. **自动续播**：暂停且非结束态才 `play()`
8. **进度记账**：按"耗时 × 倍率"给出推进预算，超出预算视为拖动，不计入
9. **卡顿检测**：播放中连续 3 秒时间轴不动 → 按 16→12→10→8 阶梯降档，并写明原因
10. **完成 / 下一节**：达到阈值 → `finished`，按延迟点击下一节

一次 `tick()` 只 `emit()` 一次，面板渲染成本与轮询次数线性相关。

### 图文 / 资料分支

没有可见视频时进入 `tickDocument()`，判定顺序是固定的：

1. **扫资料**（2 秒节流）：平台 `download` 选择器优先，再按 `.pdf/.docx/.pptx/.zip` 等后缀兜底，按 URL 去重
2. **找阅读容器**：平台 `reader` 选择器命中即用；否则要求整页可滚动且正文 ≥ 400 字
3. 有容器 → `document`：按 `16 px/s × 倍速` 每秒滚动，到底后按延迟点下一节
4. 无容器但有附件 → `material`：自动点「预览 / 查看」而不点下载，停留达到 `materialReadSec`（默认 15s）即计一节；下载只是可选手动动作
5. 都不满足 → `unknown`，继续等待

两个抗误判点：

- `display:none` 的占位 `<video>` 在适配层就被过滤（图文页很常见），否则会一直卡在"视频尚未就绪"
- 视频存在但 `readyState < 1` 时，如果图文可读就回退到图文分支，而不是干等

### 目录扫描与跳转

`outline.js` 负责回答「哪一章哪一节还没看」：

1. 找容器：平台 `profile.outline` 选择器优先，否则按 `catalog / chapter / outline / courseTree / section-list` 类名匹配，取 `li/a` 最多且类名命中的那个
2. 判状态：单项依次看文案（已学完 / 未完成）、进度百分比（≥99% 视为完成）、自身类名（`finished` / `complete` / `done`，用词边界避免命中 `incomplete`）、图标子元素
3. 出结论：只要有任意一项带状态，就认为这是可信目录；`next` = 第一个非完成项
4. 跳转：`element.click()`，不做 URL 拼接

误点防护：没有任何状态标记的列表直接放弃（返回 `null`），宁可让用户手动点，也不要在正文里乱跳。

引擎侧还有两重节流：目录 3 秒扫一次、同一个 key 60 秒内不重复跳、两次跳转至少间隔 8 秒。

## 状态机

```
idle ──start──> searching ──找到视频──> running
                    ↑                      │
                    │                 ┌────┴────┐
              切换下一节              │         │
                    │              弹题       完成
                 finished <─────────┘         │
                    └──── blocked            ▼
                                          finished
```

- `searching`：页面还没有可用视频（SPA 路由切换时短暂出现）
- `running`：托管中，包含"播放中 / 已暂停 / 缓冲中"三种文案
- `blocked`：弹题阻断，**所有自动动作停止**，包括自动续播与自动下一节
- `finished`：本节完成；开启自动下一节时会继续走切换流程
- `error`：倍速写入被播放器拒绝，日志给出原因，下一轮继续尝试
- `disabled`：总开关关闭，只观察不下发

## 关键决策

### 1. 不 seek，只改速度

跳转时间轴是最容易被平台判定异常、也最容易让进度记录失真的操作。CoursePilot 全程不写 `currentTime`，只改 `playbackRate` 与播放/下一节两个动作。副作用是"必须真的把视频放一遍"，但这是本项目的刻意取舍。

### 2. 平台专用适配优先于原生倍速

雨课堂 / 学堂在线 的播放器把倍速存在 `options.speed.value` 与 `options.isDrag` 里，直接改 `video.playbackRate` 会被下一次内部同步覆盖。所以 `xtplayer` quirk 走菜单：写 `data-speed`、`keyt`、`jQuery.data` 再模拟点击，最后由播放器自己完成赋值。写菜单失败才降级原生倍速，并在日志标注 `native-fallback`。

### 3. 弹题一律停下来

识别到答题弹窗时进入 `blocked`，不点击、不关闭、不尝试作答。这样既不会误触提交，也不会把"有人替你答题"变成工具行为。

### 4. 探测必须排除自身面板

面板里有"下一节"按钮，文案与站点按钮一致。如果探测不排除 `#coursepilot-host`，"自动下一节"会点到自己，形成自激循环。`dom.js` 的两个遍历函数都会跳过带 `data-coursepilot` 标记的节点及其影子树。

### 5. 扫描要有预算

`querySelectorAll('*')` 在复杂课程页上开销不小，所以：

- 每次遍历最多 6000 个节点、最多 3 层 iframe / Shadow 嵌套
- 选择器查询结果缓存 400 ms（同一轮询内多次查询复用）
- 视频发现不走缓存，保证新插入的播放器能被立刻看到

### 6. quirk 组合而不是继承

`createAdapter()` 先造出 base，再用 quirk 的方法覆盖同名项，quirk 内部通过 `ctx.base` 调回默认实现。新增平台只需要写它真正不同的那两三个方法，不用继承一棵树。

### 7. 突破上限靠属性拦截，而不是反复抢写

很多播放器把倍速封顶在 2×：它们在自己的状态里存 2，并在 `ratechange`、定时器或重新渲染时把 `video.playbackRate` 写回 2。只靠"每秒补写一次"会和播放器来回拉扯，日志刷屏、真实倍速在 2 与目标值之间抖动。

`media.js` 的突破模式改为在 `video` **实例**上定义一个同名访问器：

```js
Object.defineProperty(video, 'playbackRate', {
  configurable: true,
  get: () => target,
  set: () => target,   // 平台写回被吞掉
});
```

真正的写入走缓存下来的原生描述符 `HTMLMediaElement.prototype.playbackRate.set`，因此底层媒体元素确实在按目标倍速解码。恢复时 `delete video.playbackRate` 让原型访问器重新生效，再写回原始倍速。

代价与边界：

- 平台自己的倍速标签不会跟着变（它读的是自己的状态）
- 播放器若把 `playbackRate` 缓存在闭包里而不是读 DOM，拦截无效——这类情况只能靠原生倍速
- Canvas / WebRTC 自绘播放器不吃 `playbackRate`，无法突破

### 8. 卡顿靠"时间轴不动"而不是 `waiting` 事件

高倍速下卡顿主要有两种来源：网络/解码跟不上（`readyState` 掉到 2 以下），以及播放器自己在限速。用 `waiting` / `stalled` 事件只能覆盖第一种，而且各播放器对事件的派发并不可靠。

引擎改用可观测结果判断：**播放中且 `currentTime` 连续 3 秒没有推进**就判定卡顿。暂停、拖动、缓冲一律不参与计时，因此不会误报。

判定的动作是**降档而不是硬等**：`16 → 12 → 10 → 8 → 5 …`，每次降一档并写日志（含原因）。这解决的是"16× 时进度停住不动，用户以为脚本挂了"的体验问题——16× 意味着每秒要解码 16 秒内容，多数课程视频在普通网络下撑不住。

### 9. 面板置顶用 top layer，不用 z-index 战争

站点浮层经常用 `z-index: 999999`，而更麻烦的是**堆叠上下文**：只要某个祖先有 `transform`/`filter`，`position: fixed` 的包含块就变成该祖先，z-index 再大也压不过外面的元素。

所以宿主元素声明 `popover="manual"` 并调用 `showPopover()`，直接进入浏览器 top layer——这一层不受任何 z-index 与堆叠上下文影响，也不会像 `dialog.showModal()` 那样拦截页面交互。不支持 Popover API 时自动摘掉属性，退回"最高 z-index + fixed"。

全屏是另一个坑：浏览器只渲染全屏元素的子树，面板留在 body 里就会消失。监听 `fullscreenchange` 把宿主搬进 `document.fullscreenElement`，退出时搬回 body，并在每次搬迁后重新 `showPopover()` 以保持顶层顺序。

### 10. 构建期编译校验

源码是 ESM，产物是单作用域 IIFE。拼接后一旦出现同名 `const`（例如两个模块都写 `TABS`）就会整包报废，所以 `build.mjs` 在写文件前先 `new vm.Script(source)` 编译一次，把这类问题挡在提交前。

## 配置与持久化

- 存储优先级：`GM_getValue`/`GM_setValue` → `localStorage` → 内存
- 读取时统一过 `sanitizeConfig()`：越界裁剪、类型纠错、未知字段丢弃，损坏的配置不会让脚本起不来
- 写入后同步通知所有订阅者（面板、引擎之外的观察者）

## 验证方式

`npm run build` 会在写出产物前用 `vm.Script` 编译一次单文件脚本，拦截模块拼接后的语法错误与重名声明。

功能验证使用 `npm run demo` 打开模拟课程页，依次检查面板挂载、倍速下发、自动续播、弹题阻断与目录跳转；真实平台兼容性仍需登录课程页确认，见 README「已知限制」。
