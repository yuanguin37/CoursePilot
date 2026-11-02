# 平台适配指南

## 适配模型

一个平台 = 一条 profile + 可选的一个 quirk：

```js
{
  id: 'zhihuishu',          // 唯一标识
  name: '智慧树',            // 面板徽标文案
  quirk: 'native',          // native | xtplayer
  hosts: ['zhihuishu.com'], // 域名后缀匹配（含子域）
  obstacle: ['.examLayer'], // 弹题容器选择器，命中且视频暂停 → blocked
  next: ['.next-btn'],      // “下一节”按钮选择器，找不到时回落到文案匹配
  reader: ['.text-content'],// 图文/文档的阅读容器，命中后按节奏自动滚动
  download: ['.file-list a'],// 课件/附件入口，找不到时按文件后缀兜底
  outline: ['.chapter-list'],// 课程目录容器，用于找“下一个未完成小节”
  done: [],                 // 平台自己的“已完成”标记，可选
}
```

`quirk: native` 覆盖绝大多数平台：标准 `<video>` + 原生 `playbackRate`。只有播放器把倍速藏在自家状态里时才需要写 quirk。

## 各平台现状

### 雨课堂（yuketang.cn）

- 播放器：`.xtplayer`，Vue 实例挂在 `host.__vue__.$data.player`
- 倍速：`xt-speedbutton` 内的 `li[data-speed]`，点击后播放器写 `options.speed.value` 与 `options.isDrag`
- 适配点：写 `data-speed` / `keyt` / `jQuery.data(li,'speed')` 后模拟 `mouseover → mousemove → click`
- 兜底：识别不到唯一 `.xtplayer`、没有 jQuery、或写入后 `playbackRate` 未变化时，回退原生倍速
- 切下一节：雨课堂多数页面没有“下一节”按钮，脚本会按文案找可点击的 div/span，再退回到点课程目录里的下一条
- 已知变化：播放器改版后 `.xtplayer` / `xt-speedbutton` 类名可能变化，改 `profiles.js` 与 `xtplayer.js` 的选择器即可

### 学堂在线（xuetangx.com）

与雨课堂同源播放器，直接复用 `xtplayer` quirk。页面若没有渲染 `.xtplayer`（例如新版课程页），quirk 的 `findXtPlayer` 返回 `null`，自动落到 base 的原生倍速实现，不会报错。

### 智慧树（zhihuishu.com）

- 标准 `<video>`，原生倍速即可
- 弹题：`.examLayer` / `.dialog-body` / `[class*="question-dialog"]`，出现时视频被暂停 → 进入 `blocked`
- 注意：平台对标签页失焦敏感，切到别的窗口会被暂停；建议保持窗口在前台

### 智慧职教（icve.com.cn）

- 播放器常嵌在同源 iframe 内，`dom.js` 的跨层探测已覆盖
- 弹题：`.el-dialog__wrapper` / `.question-wrap`
- 跨域 iframe 无法从顶层控制，需要在那个域名下单独放行脚本

### 超星学习通（chaoxing.com / xueyinonline.com）

- videojs 播放器，标准 `<video>`
- 完成标记：`.ans-job-icon.ans-job-finished`，命中即判定本节完成（比按进度百分比更准）
- 弹题：`.TiMu` / `.questionLi`

### 其他平台

`icourse163.org`、`smartedu.cn`、`ouchn.cn` 都是标准 `<video>`，使用通用策略。

## 新增一个平台

1. 在 `src/platforms/profiles.js` 的 `PLATFORM_PROFILES` 追加一条
2. 在 `build.mjs` 的 `HEADER` 里加一行 `// @match *://*.example.com/*`
3. 跑 `npm run build`，再用 Demo 页面或真实课程页确认选择器

例：

```js
{
  id: 'example',
  name: '示例平台',
  quirk: 'native',
  hosts: ['example.com'],
  obstacle: ['[class*="question-dialog"]'],
  next: ['.next-lesson'],
  done: [],
  notes: '标准 video 元素，先按通用策略观察一轮日志再决定是否要写 quirk',
}
```

## 排查“没生效”

按日志页顺序看：

| 现象 | 检查点 |
| --- | --- |
| 面板没出现 | 域名是否在 `@match` 列表；油猴里脚本是否启用；控制台执行 `CoursePilotBootstrap({force:true})` 试一次 |
| 一直是“等待页面中的视频” | 播放器是否在跨域 iframe；视频是否还没加载元数据（`readyState`） |
| 倍速被弹回 1× | 平台有重置逻辑，日志会连续出现倍速写入；若持续失败说明播放器拒绝该值，降低倍速 |
| “未找到下一节入口” | 按钮文案不在 `NEXT_LABELS` 里，或按钮在跨域 iframe；补 `next` 选择器 |
| 视频进度停住不动 | 16× 时多为解码/带宽跟不上，日志会写“播放停滞 Ns”；开启卡顿降档会自动回退到 12/10/8× |
| 平台课程进度条停滞但视频在走 | 平台对单次上报的进度增量有上限，属于平台侧策略；把倍速降到 5×–8× 通常更稳 |
| 图文章节不滚动 | 面板状态条是否显示「图文」；没有说明没识别到容器，把该站的正文容器类名补进 profile 的 `reader` |
| 面板显示「PDF 预览 · x/15s」 | 该页用浏览器内置 PDF 阅读器，脚本无法滚动，已改为停留计时；停留时长在设置页「资料停留时长」里调 |
| 目录项点了没变化 | 日志会出现「改用链接直达」并直接跳 `href`；若仍无反应，说明该行是纯 JS 绑定且无 `href`，需要按平台补点击目标选择器 |
| 停在「学习内容」列表页不动 | 面板应显示「未完成：…」并自动点进去；若显示「资料」，说明该行带 `download/attach/file` 语义，把它从 profile 的 `download` 里去掉 |
| 资料数量为 0 | 附件不是 `<a href>`（可能是 JS 按钮），把入口选择器补进 profile 的 `download` |
| 资料页不点预览 | 入口文案不含“预览/查看/阅读”，链接也不含 preview/view；可在 profile 的 `download` 里补更精确的选择器 |
| 资料页停留很久不切下一节 | 看日志是否卡在“未找到下一节入口”；补 `next` 选择器，或确认该章节本就没有下一节 |
| 面板不显示「未完成：…」 | 先点面板上的「诊断」：日志会列出候选容器的 class、条目数与完成标记数。若条目数正常但标记为 0，说明该站不做完成态标记；若完全没有候选，把目录容器类名补进 profile 的 `outline` |
| 诊断显示有容器但 `stateMarkers` 为 0 | 该站用图标或自定义属性标记完成，可在 `outline.js` 的 `stateOf` 里补匹配规则 |
| 跳过去没反应 | 站点用 hash 路由不重渲染，再点一次或手动刷新；也可能目录项是 `<div>` 而非 `<li>/<a>` |
| 「下一节」点了没反应 | 点面板「诊断」或控制台 `coursepilot.report()`，把日志里的“下一节候选”行发出来，据此补 `profile.next` |
| 图文滚动但平台不计入 | 平台可能靠"点击已读完"或服务端心跳判定，脚本不会伪造这类动作 |
| 一直 `blocked` | 弹题容器选择器命中了常驻元素（不是弹窗），把该选择器从 `obstacle` 移除 |
| 进度不涨 | 脚本不写进度，只改速度；平台是否计入取决于平台规则与倍速上限 |

调试时可以在控制台直接看原始状态：

```js
window.coursepilot.state()
window.coursepilot.log.entries().slice(-20)
```
