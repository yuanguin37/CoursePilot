#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { APP_NAME, VERSION } from './src/version.js';
import { ICON_SIZES, writeIcons } from './scripts/make-icons.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** 同时驱动油猴 @match 与扩展 content_scripts.matches，改一处即可 */
export const MATCHES = [
  '*://*.yuketang.cn/*',
  '*://*.xuetangx.com/*',
  '*://*.zhihuishu.com/*',
  '*://*.icve.com.cn/*',
  '*://*.chaoxing.com/*',
  '*://*.xueyinonline.com/*',
  '*://*.icourse163.org/*',
  '*://*.smartedu.cn/*',
  '*://*.ouchn.cn/*',
];

/** 显式依赖顺序：被依赖者在前，保证单一作用域下 const 初始化完成 */
export const MODULES = [
  'src/version.js',
  'src/util.js',
  'src/log.js',
  'src/config.js',
  'src/dom.js',
  'src/media.js',
  'src/reader.js',
  'src/outline.js',
  'src/platforms/base.js',
  'src/platforms/profiles.js',
  'src/platforms/xtplayer.js',
  'src/platforms/index.js',
  'src/engine.js',
  'src/ui/styles.js',
  'src/ui/panel.js',
  'src/api.js',
  'src/main.js',
];

const DESCRIPTION = '多平台网课播放托管：倍速突破、自动续播、自动下一节、图形化控制面板（不答题、不伪造记录）';

export const HEADER = [
  '// ==UserScript==',
  `// @name         ${APP_NAME} 课程托管助手`,
  `// @namespace    https://github.com/Tiwing/CoursePilot`,
  `// @version      ${VERSION}`,
  `// @description  ${DESCRIPTION}`,
  '// @author       Tiwing',
  ...MATCHES.map((pattern) => `// @match        ${pattern}`),
  '// @grant        GM_getValue',
  '// @grant        GM_setValue',
  '// @grant        GM_registerMenuCommand',
  '// @run-at       document-idle',
  '// @noframes',
  '// ==/UserScript==',
].join('\n');

function stripModuleSyntax(source, file) {
  const stripped = source
    .replace(/^\s*import\s+[^;\n]+;\s*$/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+function|function|const|let|var|class)\b)/gm, '');

  if (/^\s*(?:import|export)\b/m.test(stripped)) {
    throw new Error(`模块语法未完全剥离：${file}`);
  }
  return stripped.trim();
}

export async function build({ write = true } = {}) {
  const parts = [];

  for (const file of MODULES) {
    const absolute = join(ROOT, file);
    const source = await readFile(absolute, 'utf8');
    parts.push(`// ---------- ${file} ----------\n${stripModuleSyntax(source, file)}`);
  }

  const source = [
    HEADER,
    '(function () {',
    "  'use strict';",
    '',
    parts.join('\n\n'),
    '',
    '  bootstrap();',
    '})();',
    '',
  ].join('\n');

  // 拼接进同一作用域后可能出现重名声明，构建期直接编译一次暴露问题
  new vm.Script(source, { filename: 'coursepilot.user.js' });

  const target = join(ROOT, 'dist', 'coursepilot.user.js');
  if (write) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source, 'utf8');
  }

  return { source, target, bytes: Buffer.byteLength(source, 'utf8'), modules: MODULES.length };
}

/** Chrome / Edge MV3 清单：与油猴版共用同一份构建产物 */
export function createManifest() {
  const icons = Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon${size}.png`]));

  return {
    manifest_version: 3,
    name: `${APP_NAME} 课程托管助手 by Tiwing`,
    version: VERSION,
    author: 'Tiwing',
    description: DESCRIPTION,
    minimum_chrome_version: '111',
    permissions: ['activeTab', 'scripting'],
    background: { service_worker: 'background.js' },
    action: {
      default_title: 'CoursePilot：打开面板 / 在当前页启动',
      default_icon: icons,
    },
    icons,
    content_scripts: [
      {
        matches: MATCHES,
        js: ['coursepilot.js'],
        run_at: 'document_idle',
        all_frames: false,
        // 必须运行在页面主世界：雨课堂适配要读 __vue__ 与页面 jQuery
        world: 'MAIN',
      },
    ],
  };
}

export async function buildExtension({ write = true, source } = {}) {
  const bundle = source || (await build({ write: false })).source;
  const manifest = createManifest();
  const directory = join(ROOT, 'dist', 'extension');

  if (write) {
    await mkdir(join(directory, 'icons'), { recursive: true });
    await writeFile(join(directory, 'coursepilot.js'), bundle, 'utf8');
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await copyFile(join(ROOT, 'extension', 'background.js'), join(directory, 'background.js'));
    await writeIcons(join(directory, 'icons'));
  }

  return { directory, manifest, bytes: Buffer.byteLength(bundle, 'utf8') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const userscript = await build();
    const extension = await buildExtension({ source: userscript.source });
    console.log(`built ${userscript.target}`);
    console.log(`built ${extension.directory}`);
    console.log(`${userscript.modules} modules, ${(userscript.bytes / 1024).toFixed(1)} KB`);
  } catch (error) {
    console.error(`build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
