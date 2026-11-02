/* CoursePilot 演示脚本：用一个假的 <video> 模拟课程播放器，驱动真实的面板与引擎 */
(function () {
  'use strict';

  const LESSONS = [
    '3.1 二叉树的定义',
    '3.2 二叉树的存储结构',
    '3.3 二叉树的遍历',
    '3.4 线索二叉树',
    '3.5 哈夫曼树与编码',
  ];

  const video = document.getElementById('player');
  const lessonName = document.getElementById('lessonName');
  const clock = document.getElementById('clock');
  const fill = document.getElementById('fill');
  const playPause = document.getElementById('playPause');
  const lessonsEl = document.getElementById('lessons');
  const progressText = document.getElementById('progressText');
  const playerBox = document.getElementById('playerBox');
  const docView = document.getElementById('docView');
  const docBody = document.getElementById('docBody');
  const modeBtn = document.getElementById('modeBtn');
  let docMode = false;

  const state = { time: 0, duration: 600, paused: true, ended: false };
  let index = 0;

  const define = (key, descriptor) => Object.defineProperty(video, key, { configurable: true, ...descriptor });
  define('duration', { get: () => state.duration });
  define('currentTime', { get: () => state.time, set: (value) => { state.time = value; } });
  define('paused', { get: () => state.paused, set: (value) => { state.paused = value; } });
  define('ended', { get: () => state.ended, set: (value) => { state.ended = value; } });
  define('seeking', { get: () => false });
  define('readyState', { get: () => 4 });
  define('currentSrc', { get: () => `https://demo.coursepilot.local/lesson-${index + 1}.mp4` });

  video.play = () => {
    state.paused = false;
    state.ended = false;
    return Promise.resolve();
  };
  video.pause = () => {
    state.paused = true;
    return undefined;
  };

  function formatClock(seconds) {
    const total = Math.floor(Math.max(0, seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function renderLessons() {
    lessonsEl.textContent = '';
    LESSONS.forEach((title, i) => {
      const li = document.createElement('li');
      if (i === index) li.className = 'active';
      else if (i < index) li.className = 'done';
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);
      const text = document.createElement('span');
      text.textContent = title;
      li.append(idx, text);
      lessonsEl.appendChild(li);
    });
    progressText.textContent = `${index + 1} / ${LESSONS.length}`;
  }

  function render() {
    const ratio = state.duration > 0 ? state.time / state.duration : 0;
    fill.style.width = `${(ratio * 100).toFixed(2)}%`;
    clock.textContent = `${formatClock(state.time)} / ${formatClock(state.duration)}`;
    playPause.textContent = state.paused ? '播放' : '暂停';
    lessonName.textContent = LESSONS[index];
  }

  function goNext() {
    index = (index + 1) % LESSONS.length;
    state.time = 0;
    state.ended = false;
    state.paused = false;
    docBody.scrollTop = 0;
    renderLessons();
    render();
  }

  /** 视频 <-> 图文切换：演示 CoursePilot 的内容自动识别 */
  function setMode(next) {
    docMode = next === 'doc';
    if (docMode) {
      video.pause();
      video.remove(); // 移除视频，模拟纯图文章节
      playerBox.hidden = true;
      docView.hidden = false;
      docBody.scrollTop = 0;
      modeBtn.textContent = '切换到视频';
    } else {
      playerBox.hidden = false;
      playerBox.prepend(video);
      docView.hidden = true;
      modeBtn.textContent = '切换到图文';
      state.time = 0;
      state.ended = false;
      state.paused = false;
      render();
    }
  }

  modeBtn.addEventListener('click', () => setMode(docMode ? 'video' : 'doc'));

  playPause.addEventListener('click', () => {
    if (state.paused) video.play();
    else video.pause();
    render();
  });

  document.getElementById('nextBtn').addEventListener('click', goNext);

  document.getElementById('resetBtn').addEventListener('click', () => {
    state.time = 0;
    state.ended = false;
    render();
  });

  document.getElementById('quizBtn').addEventListener('click', () => {
    if (document.querySelector('.question-dialog')) return;
    state.paused = true;
    render();

    const dialog = document.createElement('div');
    dialog.className = 'question-dialog';
    dialog.innerHTML = '<h3>随堂练习</h3><p>二叉树中度为 2 的结点个数与叶子结点个数有什么关系？</p>';
    const close = document.createElement('button');
    close.textContent = '关闭弹题';
    close.addEventListener('click', () => dialog.remove());
    dialog.appendChild(close);
    document.body.appendChild(dialog);
  });

  let last = performance.now();
  function frame(now) {
    const delta = Math.min(0.5, (now - last) / 1000);
    last = now;
    if (!state.paused && !state.ended) {
      state.time = Math.min(state.duration, state.time + delta * (Number(video.playbackRate) || 1));
      if (state.time >= state.duration) {
        state.ended = true;
        state.paused = true;
      }
    }
    render();
    requestAnimationFrame(frame);
  }

  renderLessons();
  render();
  requestAnimationFrame(frame);

  // 演示页面不在 @match 列表中，显式 force 启动
  if (typeof window.CoursePilotBootstrap === 'function') {
    window.CoursePilotBootstrap({ force: true });
  }
})();
