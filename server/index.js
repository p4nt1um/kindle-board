'use strict';

/**
 * PC 侧本地聚合服务入口。
 *
 * Kindle 浏览器只访问服务端的纯 HTTP：
 *   - 公网 HTTPS、API Key、CalDAV 凭据、农历/DST/RRULE 计算、图片下载全在服务端；
 *   - 浏览器只拿到一份无凭据的 board.json，做 ES5/XHR/DOM 文本 diff。
 *
 * 严格静态文件白名单，不做任意路径映射。
 */

var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var urlLib = require('url');

var cfg = require('../config.json');
var mdns = require('./mdns');
var aggregator = require('./aggregator');

var PORT = cfg.service.port;
var PUBLIC = path.join(__dirname, '..', 'public');
var MEDIA = path.join(__dirname, '..', 'data', 'media');
var HOSTNAME = os.hostname();
var PING_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'
);

var STATIC = {
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/board.css': ['board.css', 'text/css; charset=utf-8'],
  '/board.js': ['board.js', 'application/javascript; charset=utf-8'],
  '/probe.html': ['probe.html', 'text/html; charset=utf-8']
};

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveFile(res, file, type) {
  fs.readFile(file, function (err, buf) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + path.basename(file));
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Content-Length': buf.length
    });
    res.end(buf);
  });
}

function discoveryPayload() {
  var st = mdns.state();
  var ip = st.ip || mdns.pickIp();
  var p = ':' + PORT + '/';
  var candidates = [];
  var seen = {};
  var i;

  function add(label, url) {
    if (url && !seen[url]) { seen[url] = 1; candidates.push({ label: label, url: url }); }
  }

  // 2026-11-11 真机结论：Kindle 旧 WebKit 没有 mDNS resolver，.local / 短名都解析不了，
  // 唯一可靠入口是直连当前 DHCP 地址。候选链据此排序，让 probe.html 的「第一个 OK」
  // 直接落到 IP，并提示做 DHCP 静态保留；服务端仍不硬编码任何 IP（ip 来自网卡实时读取）。
  if (ip) add('当前 IP（Kindle 首选）', 'http://' + ip + p);
  add('mDNS .local（仅 PC 可用）', 'http://' + cfg.service.host + p);
  for (i = 0; i < cfg.network.fallbackHostnames.length; i++) {
    add('路由器本地 DNS', 'http://' + cfg.network.fallbackHostnames[i] + p);
  }
  add('DHCP 主机名', 'http://' + HOSTNAME + p);

  return {
    generatedAt: Date.now(),
    hostname: HOSTNAME,
    mdns: st,
    candidates: candidates,
    probePath: '/probe.html',
    note: '真机实测：Kindle 旧 WebKit 无 mDNS 解析器，.local / 短名均不可用；' +
      'Kindle 请用当前 IP 直连并在路由器做 DHCP 静态保留，PC 才用 .local。' +
      '候选链随 DHCP 每 30 秒动态更新，服务端不含硬编码 IP。'
  };
}

var server = http.createServer(function (req, res) {
  var parsed = urlLib.parse(req.url, true);
  var p = parsed.pathname;
  var i, f;

  if (p === '/') {
    serveFile(res, path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
    return;
  }
  if (STATIC[p]) {
    serveFile(res, path.join(PUBLIC, STATIC[p][0]), STATIC[p][1]);
    return;
  }
  if (p === '/ping.gif') {
    res.writeHead(200, {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store',
      'Content-Length': PING_GIF.length
    });
    res.end(PING_GIF);
    return;
  }
  if (p === '/media/daily.jpg') {
    f = path.join(MEDIA, 'daily.jpg');
    if (fs.existsSync(f)) {
      serveFile(res, f, 'image/jpeg');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('no image cached');
    }
    return;
  }
  if (p === '/api/discovery') { sendJson(res, 200, discoveryPayload()); return; }
  if (p === '/api/board.json') { sendJson(res, 200, aggregator.payload()); return; }
  if (p === '/api/health') { sendJson(res, 200, aggregator.status()); return; }
  if (p === '/api/refresh') {
    var ra = (req.socket && req.socket.remoteAddress) || '';
    var loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    // 局域网侧只允许读，避免任意设备反复触发上游请求；本机诊断可直接调用
    if (!loopback && !cfg.debug.allowForceRefresh) {
      sendJson(res, 403, { ok: false, error: '仅本机可触发刷新（或开启 debug.allowForceRefresh）' });
      return;
    }
    aggregator.forceRefresh().then(function (r) {
      sendJson(res, 200, r);
    }).catch(function (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

try {
  aggregator.start();
} catch (e) {
  console.error('[board] 启动自检失败: ' + e.message);
  process.exit(1);
}

mdns.start();

server.listen(PORT, '0.0.0.0', function () {
  var d = discoveryPayload();
  var i;
  console.log('');
  console.log('  Kindle Board listening on 0.0.0.0:' + PORT);
  console.log('  hostname    : ' + HOSTNAME);
  console.log('  LAN IP      : ' + (d.mdns.ip || '(none)') +
    (d.mdns.iface ? '  via ' + d.mdns.iface : ''));
  console.log('  runtime     : Node ' + process.version + ' / ' +
    process.platform + '-' + process.arch + ' / ICU ' + process.versions.icu +
    (process.config.variables.icu_small ? ' (small-icu!)' : ' (full-icu)'));
  console.log('');
  console.log('  看板地址（先在真机跑一次 probe.html 再定书签）：');
  for (i = 0; i < d.candidates.length; i++) {
    console.log('    [' + (i + 1) + '] ' + d.candidates[i].label + '  ' + d.candidates[i].url);
  }
  console.log('    [P] 兼容性与域名探测  ' + d.candidates[0].url + 'probe.html');
  console.log('');
  console.log('  后台刷新 ' + (cfg.board.refreshMs / 3600000) + 'h / 浏览器轮询 ' +
    (cfg.board.browserPollMs / 60000) + 'min；失败保留内容并标记 stale。');
  console.log('');
});

server.on('error', function (e) {
  console.error('[http] ' + e.message);
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 被占用；改 config.json 的 service.port 后重启。');
  }
  process.exit(1);
});

/** 优雅退出：Ctrl+C 发 SIGINT，systemd / docker stop 发 SIGTERM，两条都要接 */
var shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[board] ' + sig + ' → shutting down');
  try { aggregator.stop(); } catch (e) { /* ignore */ }
  try { mdns.stop(); } catch (e) { /* ignore */ }
  try {
    server.close(function () { process.exit(0); });
  } catch (e) {
    process.exit(0);
  }
  // 有 keep-alive 连接挂着时 server.close() 会等，2 秒兜底，别让 systemd 等到超时 SIGKILL
  var t = setTimeout(function () { process.exit(0); }, 2000);
  if (t.unref) t.unref();
}
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
