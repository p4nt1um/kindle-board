'use strict';

/**
 * 跨平台凭据同步：把「当前进程可见的环境变量」合并进 secrets.local.json。
 *
 * 和 sync-secrets.ps1 的区别：
 *   - ps1 读的是 Windows「用户作用域」环境变量（解决常驻进程看不到后来新增变量的问题）；
 *   - 本脚本读进程环境变量，Windows / Linux / macOS / 树莓派通用，不依赖 PowerShell；
 *   - **合并语义**：环境变量里没有的键保留文件里的原值，不会像 ps1 那样整体覆盖清空。
 *     （腾讯云 SecretId/Key 来自 ~/.tccli/default.credential，曾因重跑 ps1 被写空；
 *      用本脚本不会再发生。）
 *   - Linux 上写出的文件强制 chmod 600。
 *
 * 其实在 systemd 下更推荐根本不生成这个文件：用 EnvironmentFile 直接注入进程环境变量，
 * server/secrets.js 的优先级本来就是「环境变量 > 文件」。
 *
 * 用法：
 *   npm run sync-secrets
 *   npm run sync-secrets -- --prune     # 删掉环境变量里已不存在的键
 */

var fs = require('fs');
var path = require('path');
var secrets = require('./server/secrets');

var FILE = secrets.filePath;
var prune = process.argv.indexOf('--prune') !== -1;

var existing = {};
var note = '';
try {
  existing = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  note = '已读取现有 ' + Object.keys(existing).length + ' 项';
} catch (e) {
  note = '现有文件不存在或不可解析，将新建';
}

var out = {};
var applied = [];
var kept = [];
var missing = [];
var k, i, names, v;

if (!prune) {
  for (k in existing) {
    if (Object.prototype.hasOwnProperty.call(existing, k)) out[k] = existing[k];
  }
}

for (k in secrets.ENV_MAP) {
  if (!Object.prototype.hasOwnProperty.call(secrets.ENV_MAP, k)) continue;
  names = secrets.ENV_MAP[k];
  v = '';
  for (i = 0; i < names.length; i++) {
    if (process.env[names[i]]) { v = String(process.env[names[i]]); break; }
  }
  if (v) {
    out[k] = v;
    applied.push(k);
  } else if (!prune && existing[k] !== undefined && String(existing[k]) !== '') {
    kept.push(k);
  } else {
    delete out[k];
    missing.push(k);
  }
}

// 直接写目标文件：避免 Windows 上 rename 覆盖已存在文件的 EPERM，
// 也避免留下含明文凭据的 .tmp 残留。文件很小，服务端按 mtime 读整份 JSON，
// 不会读到半份内容（loadFile() 解析失败会保留上一次的缓存并告警）。
try {
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(FILE, 0o600);
} catch (e) {
  console.error('[sync-secrets] 写入失败: ' + e.message);
  process.exitCode = 1;
}

if (!process.exitCode) {
  console.log('[sync-secrets] ' + note);
  console.log('[sync-secrets] 写入 ' + path.relative(__dirname, FILE) +
    '：环境变量覆盖 ' + applied.length + ' 项，保留原值 ' + kept.length + ' 项，缺失 ' + missing.length + ' 项');
  if (applied.length) console.log('  覆盖: ' + applied.join(', '));
  if (kept.length) console.log('  保留: ' + kept.join(', '));
  if (missing.length) console.log('  缺失（对应环境变量未设置）: ' + missing.join(', '));
  console.log('  模式: ' + (prune ? '--prune（已清除未设置的键）' : '合并（不会清空已有凭据）'));
  console.log('  只打印键名，不打印任何凭据值。服务端按 mtime 热加载，无需重启。');
  if (process.platform !== 'win32') console.log('  文件权限: 600');
}
