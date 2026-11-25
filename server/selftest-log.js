'use strict';

/**
 * 日志层离线自检：验证「常态零写入 + 容量有硬上限 + 异常必记」这套约定。
 *
 *   node server/selftest-log.js
 *
 * 全部写入临时目录，不碰真实 data/board.log；结束时自动清理。
 * 不读取 config.json、不需要凭据、不联网。
 */

var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-log-selftest-'));
var LOG_FILE = path.join(tmp, 'nested', 'board.log');
process.env.KINDLE_BOARD_LOG_FILE = LOG_FILE;
delete process.env.KINDLE_BOARD_LOG;   // 确保默认启用

var logger = require('./logger');
var I = logger.__internals;

var pass = 0;
var fail = 0;

function check(name, fn) {
  try {
    var d = fn();
    pass++;
    console.log('  [ok] ' + name + (d ? '  → ' + d : ''));
  } catch (e) {
    fail++;
    console.log('  [FAIL] ' + name + '  → ' + e.message);
  }
}
function eq(a, b, label) {
  if (a !== b) throw new Error((label || '值') + ' 不符: 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b));
}
function truthy(v, label) { if (!v) throw new Error(label || '应为真'); }

function logNames() {
  var dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (n) { return n.indexOf('board.log') === 0; });
}
function totalBytes() {
  var dir = path.dirname(LOG_FILE), n = 0;
  logNames().forEach(function (f) { n += fs.statSync(path.join(dir, f)).size; });
  return n;
}
function resetLogs() {
  var dir = path.dirname(LOG_FILE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

console.log('日志层自检（稀疏写入 + 容量硬上限）');

check('写入格式：自动建父目录、ISO 时间戳 + 级别 + 内容', function () {
  resetLogs();
  eq(logger.info('启动横幅'), true, '写入返回 true');
  truthy(fs.existsSync(LOG_FILE), '文件已创建（父目录原本不存在）');
  var s = fs.readFileSync(LOG_FILE, 'utf8');
  truthy(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO\] 启动横幅\n$/.test(s), '行格式');
  return s.trim().replace(/^\S+ /, '<ts> ');
});

check('多行追加且 INFO / WARN / ERROR 级别可区分', function () {
  resetLogs();
  logger.info('A');
  logger.warn('B');
  logger.error('C');
  var lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
  eq(lines.length, 3, '行数');
  truthy(/\[INFO\] A$/.test(lines[0]), 'INFO');
  truthy(/\[WARN\] B$/.test(lines[1]), 'WARN');
  truthy(/\[ERROR\] C$/.test(lines[2]), 'ERROR');
  return '三个级别各一行';
});

check('KINDLE_BOARD_LOG=0 完全不写入', function () {
  var before = fs.statSync(LOG_FILE).size;
  process.env.KINDLE_BOARD_LOG = '0';
  try {
    eq(logger.warn('不应写入'), false, '写入被跳过');
    eq(fs.statSync(LOG_FILE).size, before, '文件大小不变');
  } finally {
    delete process.env.KINDLE_BOARD_LOG;
  }
  return '开关可随时关闭日志，无需改代码';
});

check('超过 256KB 自动轮转，最多 3 份且总量不超硬上限', function () {
  resetLogs();
  var chunk = new Array(200 * 1024).join('x');  // 约 200KB
  var i;
  for (i = 0; i < 6; i++) logger.warn('bulk-' + i + ' ' + chunk);
  var names = logNames().sort();
  eq(names.length, I.KEEP, '文件份数上限');
  truthy(totalBytes() <= I.MAX_BYTES * I.KEEP, '总字节未超上限');
  truthy(fs.existsSync(LOG_FILE), '当前日志存在');
  truthy(fs.existsSync(LOG_FILE + '.1'), '存在 .1');
  truthy(fs.existsSync(LOG_FILE + '.2'), '存在 .2');
  return names.join(' ') + '，共 ' + Math.round(totalBytes() / 1024) + 'KB / 上限 ' +
    Math.round(I.MAX_BYTES * I.KEEP / 1024) + 'KB';
});

check('日志路径不可写时静默失败，不抛异常拖垮看板', function () {
  var saved = process.env.KINDLE_BOARD_LOG_FILE;
  process.env.KINDLE_BOARD_LOG_FILE = path.dirname(LOG_FILE);  // 故意指向目录
  try {
    eq(logger.error('不可写'), false, '返回 false 而非抛错');
  } finally {
    process.env.KINDLE_BOARD_LOG_FILE = saved;
  }
  return '异常被 catch，聚合流程不受影响';
});

check('聚合器：常态成功不写、异常与状态翻转一律记录', function () {
  var agg = fs.readFileSync(path.join(ROOT, 'server', 'aggregator.js'), 'utf8');
  truthy(/require\('\.\/logger'\)/.test(agg), '引入 logger');
  truthy(!/console\.(log|warn|error)\(/.test(agg), '不再有 console 输出');
  truthy(!/if \(!quiet\)/.test(agg), '日志不再被 quiet 门控吞掉');
  truthy(/logger\.warn\('\[board\] ' \+ id \+ ' stale/.test(agg), '硬失败必记');
  truthy(/logger\.warn\('\[board\] ' \+ id \+ ' degraded/.test(agg), '软降级必记');
  truthy(/if \(wasStale && hadData\) logger\.info/.test(agg), '仅真恢复才记成功，首次启动不误记');
  truthy(/var hadData = e\.updatedAt > 0/.test(agg), '区分首次取数与恢复');
  truthy(/logger\.error\('\[board\] 启动失败/.test(agg), '启动失败必记');
  return '降级 / 失败 / 恢复 / 启动失败四类事件落盘';
});

check('日志目录已被 .gitignore 排除，package.json 已接入本自检', function () {
  var g = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  truthy(/^data\/$/m.test(g), 'data/ 被排除');
  var p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  truthy(/selftest-log\.js/.test(p.scripts.selftest), '全套回归包含日志自检');
  return '日志永不进入公开仓库';
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log('\n  ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
