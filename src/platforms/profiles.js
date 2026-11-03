/**
 * 平台矩阵：hosts 按域名后缀匹配，新增平台只需追加一条。
 * quirk: native = 标准 HTML5 video；xtplayer = 雨课堂/学堂在线 的 Vue 播放器。
 * reader: 图文/文档页的阅读容器选择器（命中即可自动滚动）。
 * download: 课件/附件入口选择器，找不到时按文件后缀兜底。
 * outline: 课程目录容器，用于定位“下一个未完成小节”。
 */
export const PLATFORM_PROFILES = [
  {
    id: 'yuketang',
    name: '雨课堂',
    quirk: 'xtplayer',
    hosts: ['yuketang.cn'],
    obstacle: ['.xt-popup', '.xt-exam-layer', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.xt-next-btn', '[class*="next-video"]'],
    reader: ['.rich-text', '.markdown-body', '.lms-detail', '.xt-content'],
    download: ['.attach-list a', '.file-item a', '[class*="attachment"] a'],
    outline: [
      '.learning-space-student-chapter-nav .nav-item-list',
      '.learning-space-student .nav-item-list',
      '.nav-item-list',
      '[class*="chapter-nav"]',
      '[class*="nav-list"]',
      '.chapter-list',
      '.section-list',
      '.xt-video-list',
      '.lms-chapter',
    ],
    done: [],
    notes: 'Vue 播放器：倍速写入 xt-speedbutton 菜单；新版学习页无“下一节”按钮，按 .nav-item-leaf-box 目录顺序切换。',
  },
  {
    id: 'xuetangx',
    name: '学堂在线',
    quirk: 'xtplayer',
    hosts: ['xuetangx.com'],
    obstacle: ['.xt-popup', '.xt-exam-layer', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.xt-next-btn', '[class*="next-video"]'],
    reader: ['.courseware-content', '.rich-text', '.markdown-body', '.xt-content'],
    download: ['.attach-list a', '.file-item a', '[class*="attachment"] a'],
    outline: ['.chapter-list', '.section-list', '.course-chapter', '.xt-course-chapter'],
    done: [],
    notes: '与雨课堂同源播放器；页面若未渲染 .xtplayer，会自动降级为原生倍速。',
  },
  {
    id: 'zhihuishu',
    name: '智慧树',
    quirk: 'native',
    hosts: ['zhihuishu.com'],
    obstacle: ['.examLayer', '.dialog-body', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn', '.nextChapter'],
    reader: ['.text-content', '.article-content', '.study-content', '.course-content'],
    download: ['.file-list a', '.attach a', '[class*="download"] a'],
    outline: ['.chapter-list', '.catalog-list', '.section-list', '.chapters'],
    done: [],
    notes: '标准 video 元素；平台在标签页失焦时会暂停，需要保持窗口在前台，弹题出现时会暂停托管。',
  },
  {
    id: 'icve',
    name: '智慧职教',
    quirk: 'native',
    hosts: ['icve.com.cn'],
    obstacle: ['.el-dialog__wrapper', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn', '.nextChapter'],
    reader: ['.el-main', '.content-box', '.article-content', '.courseware'],
    download: ['.file-list a', '.attach a', '[class*="download"] a'],
    outline: ['.el-menu', '.chapter-list', '.catalog-list'],
    done: [],
    notes: '播放器常位于同源 iframe 内，已由跨层探测覆盖；跨域 iframe 需油猴在同源域另行注入。',
  },
  {
    id: 'chaoxing',
    name: '超星学习通',
    quirk: 'native',
    hosts: ['chaoxing.com', 'xueyinonline.com'],
    obstacle: ['.TiMu', '.questionLi', '[class*="question-dialog"]'],
    next: ['.nextChapter', '#next'],
    reader: ['.richText', '.article-content', '.markdown-body', '#content'],
    download: ['.attachList a', '.annextitle a', '[class*="attach"] a'],
    outline: ['#chapterList', '.chapter-item', '.posCatalog_select', '.catalog_list'],
    done: ['.ans-job-icon.ans-job-finished'],
    notes: '任务点型课程，进度由播放器自行上报；脚本只在原速基础上加速，不做跳转。',
  },
  {
    id: 'icourse163',
    name: '中国大学MOOC',
    quirk: 'native',
    hosts: ['icourse163.org'],
    obstacle: ['.j-quiz', '.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn', '.ux-mooc-next'],
    reader: ['.j-richText', '.course-content', '.m-textContent'],
    download: ['.j-attachment a', '.f-files a'],
    outline: ['.chapter', '.j-chapter', '.section-list'],
    done: [],
    notes: '标准 video 元素，直接使用原生倍速。',
  },
  {
    id: 'smartedu',
    name: '国家智慧教育平台',
    quirk: 'native',
    hosts: ['smartedu.cn'],
    obstacle: ['.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn'],
    reader: ['.article-content', '.content-text', '.doc-content'],
    download: ['.resource-list a', '[class*="download"] a'],
    outline: ['.chapter-list', '.catalog-list'],
    done: [],
    notes: '标准 video 元素，默认按通用策略工作。',
  },
  {
    id: 'ouchn',
    name: '国家开放大学',
    quirk: 'native',
    hosts: ['ouchn.cn'],
    obstacle: ['.question-wrap', '[class*="question-dialog"]'],
    next: ['.next-btn'],
    reader: ['.content-body', '.article-content', '.text-content'],
    download: ['.file-list a', '[class*="download"] a'],
    outline: ['.chapter-list', '.course-catalog'],
    done: [],
    notes: '通用策略；若播放器为跨域 iframe，需要在 iframe 所在域单独放行。',
  },
];

export const GENERIC_PROFILE = {
  id: 'generic',
  name: '通用网页',
  quirk: 'native',
  hosts: [],
  obstacle: ['[class*="question-dialog"]', '.question-wrap', '.popup-quiz'],
  next: [],
  reader: ['article', '.article-content', '.rich-text', '.markdown-body', '.doc-content', '#js_content'],
  download: [],
  outline: [],
  done: [],
  notes: '未登记的平台按标准 HTML5 video 处理，可在面板中直接调速；图文页按通用阅读容器识别。',
};

export function matchProfile(href) {
  let hostname = '';
  try {
    hostname = new URL(String(href)).hostname.toLowerCase();
  } catch {
    hostname = '';
  }
  for (const profile of PLATFORM_PROFILES) {
    const hit = profile.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    if (hit) return profile;
  }
  return GENERIC_PROFILE;
}
