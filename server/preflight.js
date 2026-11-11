'use strict';

/**
 * 运行时环境自检：换一台机器跑（尤其是树莓派 / Linux）之前先跑这个。
 *
 * 不联网、不读凭据、不启动服务、不写业务数据。
 * 只回答一个问题：这台机器能不能把五个板块都算出来 / 取回来。
 *
 * 重点覆盖 PC → ARM/Linux 迁移最容易踩的坑：
 *   1. Node 构建是不是 small-icu（中国农历会静默退化成公历）
 *   2. tzdata 在不在（DST / 双时区会全变成 UTC）
 *   3. crypto 有没有 sha1/sha256（三家云签名）
 *   4. 依赖里有没有需要在 ARM 上重编译的 .node 原生模块
 *   5. 网卡名变了没有（Windows WLAN → Linux wlan0 / eth0 / end0）
 *   6. data/ 可不可写（每日图片缓存）
 *   7. 树莓派无 RTC，系统时钟没同步会让 TLS 校验和云 API 时间戳签名全挂
 */

var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..');
var results = [];

function record(level, name, detail) {
  results.push({ level: level, name: name, detail: detail });
}
function pass(n, d) { record('PASS', n, d); }
function warn(n, d) { record('WARN', n, d); }
function fail(n, d) { record('FAIL', n, d); }

/** 1. Node 版本 */
(function () {
  var major = parseInt(process.versions.node.split('.')[0], 10);
  var engines = (require('../package.json').engines || {}).node || '>=18';
  if (major >= 18) {
    pass('Node 版本', process.version + '（要求 ' + engines + '，platform=' +
      process.platform + '-' + process.arch + '）');
  } else {
    warn('Node 版本', process.version + ' 低于 ' + engines +
      '；大部分代码仍能跑，但 ICU / Intl 行为可能不同，建议装 Node 18+ LTS');
  }
})();

/** 2. full ICU + 中国农历（时钟标题行依赖） */
(function () {
  var small = !!process.config.variables.icu_small;
  var text = '';
  var err = '';
  try {
    text = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric'
    }).format(new Date());
  } catch (e) { err = e.message; }
  var ok = !small && !err && /[\u4e00-\u9fa5]/.test(text) && /月/.test(text);
  if (ok) {
    pass('Node ICU 中国农历', 'ICU ' + process.versions.icu + '（full-icu），样例输出「' + text + '」');
  } else {
    fail('Node ICU 中国农历',
      (small ? '当前是 small-icu 构建' : '输出异常「' + text + ' ' + err + '」') +
      '；农历会退化成公历。改用官方完整 Node 构建 / NodeSource 包，或 npm i full-icu 并设 NODE_ICU_DATA');
  }
})();

/** 3. IANA 时区与 DST 数据 */
(function () {
  try {
    var clock = require('./fetchers/clock');
    var sh = clock.zoneOffsetMinutes('Asia/Shanghai', new Date());
    var nyJan = clock.zoneOffsetMinutes('America/New_York', new Date(Date.UTC(2026, 0, 15)));
    var nyJul = clock.zoneOffsetMinutes('America/New_York', new Date(Date.UTC(2026, 6, 15)));
    if (sh === 480 && nyJan === -300 && nyJul === -240) {
      pass('IANA 时区 / DST', 'Asia/Shanghai +480，America/New_York EST -300 / EDT -240，tzdata 正常');
    } else {
      fail('IANA 时区 / DST', '偏移异常 sh=' + sh + ' nyJan=' + nyJan + ' nyJul=' + nyJul +
        '；通常是缺 tzdata 或 small-icu，请 sudo apt install tzdata 并换完整 ICU 的 Node');
    }
  } catch (e) {
    fail('IANA 时区 / DST', '加载 clock.js 失败: ' + e.message);
  }
})();

/** 4. crypto（BCE / TC3 / 阿里 RPC 三家签名都要） */
(function () {
  var hashes = crypto.getHashes();
  var err = '';
  try { crypto.createHmac('sha256', 'k').update('x').digest('hex'); }
  catch (e) { err = e.message; }
  if (hashes.indexOf('sha256') === -1 || err) {
    fail('crypto 摘要算法', 'sha256 不可用 ' + err + '；三家云签名都会失败');
  } else if (hashes.indexOf('sha1') === -1) {
    warn('crypto 摘要算法', 'sha256 可用，但缺 sha1；阿里云 RPC HMAC-SHA1 那一路会失败，其余不受影响');
  } else {
    pass('crypto 摘要算法', 'sha256 / sha1 / HMAC 均可用（' + process.versions.openssl + '）');
  }
})();

/** 5. 原生模块（ARM 上要重编译的话会是迁移地雷） */
(function () {
  var dir = path.join(ROOT, 'node_modules');
  var found = [];
  var dirsSeen = 0;
  function walk(d, depth) {
    if (depth > 7 || found.length > 20 || dirsSeen > 3000) return;
    var entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (e) { return; }
    dirsSeen++;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.isFile() && /\.node$/.test(e.name)) found.push(path.relative(ROOT, path.join(d, e.name)));
      else if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
    }
  }
  if (!fs.existsSync(dir)) {
    fail('依赖安装', 'node_modules 不存在，请先 npm install --omit=dev');
  } else {
    walk(dir, 0);
    if (found.length) {
      warn('原生模块', '发现 ' + found.length + ' 个 .node（' + found.slice(0, 3).join(', ') +
        '），换 ARM 平台后需要重新编译');
    } else {
      pass('原生模块', '依赖全部是纯 JS（multicast-dns / dns-packet / thunky），ARM 直接可用');
    }
  }
})();

/** 6. 网卡发现 */
(function () {
  var mdns = require('./mdns');   // 只 require，不 start()，不会开 socket
  var ifaces = os.networkInterfaces();
  var lan = mdns.pickLan();
  var configured = mdns.state().preferredInterfaces;
  var hit = configured.filter(function (n) { return !!ifaces[n]; });

  if (lan) {
    pass('局域网网卡', lan.iface + ' → ' + lan.address +
      '（候选 ' + configured.join(', ') + '；命中 ' + (hit.join(', ') || '无，走自动扫描') + '）');
  } else {
    warn('局域网网卡', '未找到可用 LAN IPv4；检查 config.network.excludePrefixes、网线/WiFi，' +
      '以及 KINDLE_BOARD_IFACE=' + (process.env.KINDLE_BOARD_IFACE || '(未设置)'));
  }
  if (!hit.length) {
    warn('网卡名配置', '候选名 ' + configured.join(' / ') + ' 都不存在，' +
      '已自动扫描其他网卡；建议在 systemd EnvironmentFile 里设 KINDLE_BOARD_IFACE=<实际网卡名>');
  }
})();

/** 6b. Linux 上内置 mDNS 与 avahi-daemon 是否撞名 */
(function () {
  if (process.platform !== 'linux') return;
  var off = /^(0|off|false|no|disabled)$/i.test(String(process.env.KINDLE_BOARD_MDNS || ''));
  var hn = os.hostname().toLowerCase();
  if (off) {
    pass('mDNS 应答器', 'KINDLE_BOARD_MDNS=off，已交给 avahi-daemon 发布 .local');
  } else if (hn === 'kindle-board' || hn === 'kindle-board.local') {
    warn('mDNS 应答器', '主机名已是 ' + hn + '，Avahi 与内置应答器会同时回答 ' +
      'kindle-board.local；在 EnvironmentFile 里加 KINDLE_BOARD_MDNS=off');
  } else {
    pass('mDNS 应答器', 'Avahi 发布 ' + hn + '.local，内置应答器发布 kindle-board.local，名字不冲突');
  }
})();

/** 7. 数据目录可写 */
(function () {
  var data = path.join(ROOT, 'data');
  var media = path.join(data, 'media');
  try {
    if (!fs.existsSync(data)) fs.mkdirSync(data, { recursive: true });
    if (!fs.existsSync(media)) fs.mkdirSync(media, { recursive: true });
    fs.accessSync(data, fs.constants.W_OK);
    fs.accessSync(media, fs.constants.W_OK);
    pass('数据目录可写', path.relative(ROOT, data) + ' / media（每日池与图片缓存）');
  } catch (e) {
    fail('数据目录可写', e.message + '；服务会降级但不缓存，检查 User= / chown');
  }
})();

/** 8. 凭据文件权限（Linux 才有意义） */
(function () {
  if (process.platform === 'win32') return;
  var f = require('./secrets').filePath;
  if (!fs.existsSync(f)) {
    pass('凭据文件权限', '未使用凭据文件（推荐用 systemd EnvironmentFile 注入环境变量）');
    return;
  }
  var mode = fs.statSync(f).mode & 0o777;
  if (mode & 0o077) {
    warn('凭据文件权限', f + ' 当前是 ' + mode.toString(8) +
      '，同组/其他用户可读；执行 chmod 600 ' + f);
  } else {
    pass('凭据文件权限', f + ' 权限 ' + mode.toString(8));
  }
})();

/** 9. 系统时钟（树莓派无 RTC，这条最容易被忽略） */
(function () {
  if (Date.now() < 1735689600000) {   // 2025-01-01
    fail('系统时钟', '当前时间明显不对（' + new Date().toISOString() +
      '）；HTTPS 证书校验、飞书 CalDAV、三家云签名时间戳都会失败');
    return;
  }
  if (process.platform !== 'linux') {
    pass('系统时钟', new Date().toISOString() + '（Windows 有 RTC/时间同步服务）');
    return;
  }
  var syncFile = '/run/systemd/timesync/synchronized';
  if (fs.existsSync(syncFile)) {
    pass('系统时钟 / NTP', 'systemd-timesyncd 已同步，' + new Date().toISOString());
  } else {
    warn('系统时钟 / NTP', '未检测到 ' + syncFile + '。树莓派没有硬件 RTC，断电后时钟会漂；' +
      '执行 timedatectl 确认 System clock synchronized: yes' +
      '（sudo timedatectl set-ntp true），否则 TLS 校验与 TC3/BCE/阿里签名时间戳会全部失败');
  }
})();

/** 10. locale（只影响日志显示） */
(function () {
  if (process.platform === 'win32') return;
  var lang = process.env.LANG || process.env.LC_ALL || '';
  if (!lang || /^(C|POSIX)$/.test(lang) || !/utf-?8/i.test(lang)) {
    warn('locale', 'LANG=' + (lang || '(未设置)') + '；Node 内部 UTF-8 不受影响，' +
      '但 journalctl -u kindle-board 里的中文日志会乱码，建议设为 C.UTF-8 / en_US.UTF-8');
  } else {
    pass('locale', lang);
  }
})();

/** 汇总 */
var counts = { PASS: 0, WARN: 0, FAIL: 0 };
console.log('');
console.log('  Kindle Board 运行时自检');
console.log('  ' + process.version + ' / ' + process.platform + '-' + process.arch +
  ' / ' + os.hostname() + ' / ICU ' + process.versions.icu);
console.log('  ' + new Date().toString());
console.log('');
results.forEach(function (r) {
  counts[r.level]++;
  console.log('  [' + r.level + '] ' + r.name + ' — ' + r.detail);
});
console.log('');
console.log('  ' + counts.PASS + ' PASS / ' + counts.WARN + ' WARN / ' + counts.FAIL + ' FAIL');
console.log('  提示：mDNS 端口 5353 的占用情况要在服务启动后看 /api/discovery 的 mdns.enabled / lastError。');
console.log('');
if (counts.FAIL) {
  console.error('  存在 FAIL，请不要直接 npm start，先修好上面几项。');
  process.exitCode = 1;
}
