'use strict';

/**
 * 极简应用日志：只服务「异常 / 状态翻转 / 启动 / 凭据变化」，常态刷新不写。
 *
 * 背景：Pi 3B 用 SD 卡，且本机 systemd 用户级 journal 没有持久化文件，
 * 过去 10 天的运行日志无法回看。这里不依赖 journald、不需要 root，
 * 直接把少量高价值事件落到 data/board.log。
 *
 * 约束（用户明确要求「写入不要太频繁、控制日志的存储容量」）：
 *   - 平时零写入；只有值得回看的事件才 append 一行
 *   - 单文件 256 KB，超过即轮转，最多保留 3 份 ⇒ 硬上限约 768 KB
 *   - data/ 已被 .gitignore 排除；unit 的 UMask=0077 保证文件 600
 *   - 同步写、失败静默：日志写不出去绝不能拖垮看板
 *
 * KINDLE_BOARD_LOG=0 可完全关闭；KINDLE_BOARD_LOG_FILE 可改路径（自检用）。
 */

var fs = require('fs');
var path = require('path');

var MAX_BYTES = 256 * 1024;
var KEEP = 3;

function logFile() {
  return process.env.KINDLE_BOARD_LOG_FILE ||
    path.join(__dirname, '..', 'data', 'board.log');
}

function enabled() {
  return process.env.KINDLE_BOARD_LOG !== '0';
}

/** 删最旧一份，其余依次后移：board.log → .1 → .2 */
function rotate(file) {
  var i, from, to;
  var oldest = file + '.' + (KEEP - 1);
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (i = KEEP - 2; i >= 1; i--) {
    from = file + '.' + i;
    to = file + '.' + (i + 1);
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }
  if (fs.existsSync(file)) fs.renameSync(file, file + '.1');
}

function write(level, msg) {
  if (!enabled()) return false;
  try {
    var file = logFile();
    var dir = path.dirname(file);
    // 严格模式下不能用 0600 / 0700 这种八进制字面量，必须写 0o 前缀
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    var text = new Date().toISOString() + ' [' + level + '] ' + String(msg) + '\n';
    var bytes = Buffer.byteLength(text);
    var size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size + bytes > MAX_BYTES) rotate(file);
    fs.appendFileSync(file, text, { mode: 0o600 });
    return true;
  } catch (e) {
    return false;   // 日志失败绝不影响看板
  }
}

module.exports = {
  info: function (m) { return write('INFO', m); },
  warn: function (m) { return write('WARN', m); },
  error: function (m) { return write('ERROR', m); },
  __internals: {
    MAX_BYTES: MAX_BYTES,
    KEEP: KEEP,
    logFile: logFile,
    enabled: enabled,
    rotate: rotate,
    write: write
  }
};
