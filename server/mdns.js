'use strict';

/**
 * mDNS 公告端（跑在服务端主机上，可以是 Windows PC，也可以是树莓派 / Linux）。
 *
 * 重要：mDNS 有「公告方 / 查询方」两种角色。
 * 本文件只做公告方 —— 让局域网里其他设备能用 kindle-board.local 找到服务。
 * Kindle 5.16.2.1.1 的旧 WebKit 没有 mDNS 解析器，浏览器未必能解析 .local，
 * 所以必须配合 public/probe.html 在真机实测；失败时走 config 里的回退域名。
 *
 * 跨平台说明：
 *   - Windows 网卡名是「WLAN」「以太网」，Linux/Raspberry Pi 是 wlan0 / eth0 / end0。
 *     config.json 的 network.preferredInterface 现在支持数组或逗号分隔字符串，
 *     按顺序挑第一个存在的网卡；也可用环境变量 KINDLE_BOARD_IFACE 覆盖（systemd 里很方便）。
 *   - node_modules/multicast-dns 是纯 JS（只用 dgram），没有需要为 ARM 重编译的原生模块。
 *   - Windows 上 UDP 5353 常被 Windows mDNS(svchost) / Chrome 占用；
 *     Raspberry Pi OS 上则常被 avahi-daemon 占用。两边都用 reuseAddr 共存。
 *     若异步报 EADDRINUSE / EACCES，这里会把 mDNS 标记为 disabled（HTTP 服务照常可用）。
 */

var os = require('os');
var cfg = require('../config.json');

var HOST = cfg.service.host;
var PORT = cfg.service.port;
var STYPE = cfg.service.type;
var INSTANCE = cfg.service.instance + '.' + STYPE;
var EXCLUDE = cfg.network.excludePrefixes || [];

/** 网卡名候选：环境变量 > config（数组 / 逗号串 / 单个字符串） */
var PREFER_RAW = process.env.KINDLE_BOARD_IFACE || cfg.network.preferredInterface || '';
var PREFER = [];
(function () {
  var arr = Array.isArray(PREFER_RAW) ? PREFER_RAW : String(PREFER_RAW).split(',');
  var i, s;
  for (i = 0; i < arr.length; i++) {
    s = String(arr[i]).trim();
    if (s && PREFER.indexOf(s) === -1) PREFER.push(s);
  }
})();

/** Docker / VPN / 虚拟网桥：有物理网卡时绝不选它们，否则 A 记录会指到容器网段 */
var VIRTUAL_IFACE = /^(docker|br-|veth|vEthernet|virbr|tun|tap|tailscale|zt|wg|utun|awdl|lo)/i;

/**
 * Raspberry Pi OS 自带 avahi-daemon。若已把主机名设成 kindle-board 让 Avahi 发布
 * kindle-board.local，就设 KINDLE_BOARD_MDNS=off 关掉内置应答器，避免两个 responder 撞车。
 * 注意：关掉的只是 UDP 5353 应答，pickLan() / IP 变化监听 / /api/discovery 回退链照常工作。
 */
var MDNS_OFF = /^(0|off|false|no|disabled)$/i.test(String(process.env.KINDLE_BOARD_MDNS || ''));

var mdns = null;
var ipTimer = null;
var currentIp = null;
var currentIface = null;
var lastChangeAt = 0;
var lastError = null;

function excluded(ip) {
  var i;
  for (i = 0; i < EXCLUDE.length; i++) {
    if (ip.indexOf(EXCLUDE[i]) === 0) return true;
  }
  return false;
}

function isPreferred(name) {
  return PREFER.indexOf(name) !== -1;
}

/**
 * 挑一个「真正能到局域网」的 IPv4，返回 { iface, address }。
 * 顺序：① 显式指定的候选网卡 → ② 其余物理网卡（按名称排序，稳定） → ③ 虚拟网卡兜底。
 * family 在 Node 18 早期曾返回数字 4，之后返回字符串 'IPv4'，两种都接受。
 */
function pickLan() {
  var ifaces = os.networkInterfaces();
  var names = Object.keys(ifaces);
  var order = [];
  var rest = [];
  var i, j, k, n, addrs, a;

  for (i = 0; i < PREFER.length; i++) {
    if (ifaces[PREFER[i]]) order.push(PREFER[i]);
  }
  for (i = 0; i < names.length; i++) {
    n = names[i];
    if (isPreferred(n) || VIRTUAL_IFACE.test(n)) continue;
    rest.push(n);
  }
  rest.sort();
  order = order.concat(rest);
  for (i = 0; i < names.length; i++) {
    if (order.indexOf(names[i]) === -1) order.push(names[i]);
  }

  for (j = 0; j < order.length; j++) {
    addrs = ifaces[order[j]] || [];
    for (k = 0; k < addrs.length; k++) {
      a = addrs[k];
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !excluded(a.address)) {
        return { iface: order[j], address: a.address };
      }
    }
  }
  return null;
}

/** 兼容旧调用方：只要 IP */
function pickIp() {
  var lan = pickLan();
  return lan ? lan.address : null;
}

function txtRecords(ip) {
  return [
    'v=1',
    'path=' + cfg.service.path,
    'port=' + PORT,
    'ip=' + ip,
    'ts=' + String(Date.now())
  ].map(function (s) { return Buffer.from(s, 'utf8'); });
}

/** 收到查询就应答；A 记录是核心，PTR/SRV/TXT 是给支持 DNS-SD 的设备用的 */
function onQuery(query) {
  if (!mdns || !currentIp) return;

  var qs = query.questions || [];
  var want = false;
  var i;
  for (i = 0; i < qs.length; i++) {
    if (qs[i].name === HOST || qs[i].name === INSTANCE || qs[i].name === STYPE) want = true;
  }
  if (!want) return;

  var answers = [{ name: HOST, type: 'A', ttl: 120, data: currentIp }];
  var additionals = [];
  try {
    additionals.push({ name: STYPE, type: 'PTR', ttl: 120, data: INSTANCE });
    additionals.push({
      name: INSTANCE, type: 'SRV', ttl: 120,
      data: { priority: 0, weight: 0, port: PORT, target: HOST }
    });
    additionals.push({ name: INSTANCE, type: 'TXT', ttl: 120, data: txtRecords(currentIp) });
  } catch (e) {
    additionals = [];
  }

  try {
    mdns.respond({ answers: answers, additionals: additionals });
  } catch (e) {
    // 某些 multicast-dns 版本对 SRV/TXT 的 data 格式敏感，降级成纯 A 应答
    try { mdns.respond({ answers: answers }); } catch (e2) { lastError = e2.message; }
  }
}

/** 主动公告一次（IP 变化时重新公告，让局域网缓存尽快更新） */
function announce() {
  if (!mdns || !currentIp) return;
  onQuery({ questions: [{ name: HOST, type: 'A' }] });
}

/** DHCP 续租 / 换 WiFi 后 IP 会变，定时检查并重新公告 */
function watchIp() {
  var lan = pickLan();
  if (lan && lan.address !== currentIp) {
    var old = currentIp;
    currentIp = lan.address;
    currentIface = lan.iface;
    lastChangeAt = Date.now();
    announce();
    console.log('[mdns] IP changed: ' + old + ' -> ' + currentIp +
      ' (' + currentIface + ', re-announced ' + HOST + ')');
  }
}

function start() {
  var lan = pickLan();
  if (lan) {
    currentIp = lan.address;
    currentIface = lan.iface;
  } else {
    lastError = 'no LAN IPv4 address found (check network.preferredInterface / KINDLE_BOARD_IFACE / excludePrefixes)';
    console.warn('[mdns] ' + lastError);
  }

  if (MDNS_OFF) {
    console.log('[mdns] 应答器已由 KINDLE_BOARD_MDNS=off 关闭（交给 avahi-daemon）；' +
      'HTTP 与 /api/discovery 回退链照常可用');
    ipTimer = setInterval(watchIp, cfg.network.ipCheckIntervalMs || 30000);
    return state;
  }

  try {
    var create = require('multicast-dns');
    mdns = create({
      reuseAddr: true,      // 关键：与 Windows mDNS / Chrome / Linux avahi-daemon 共存
      loopback: true,
      multicast: true,
      port: 5353,
      ip: '224.0.0.251',
      ttl: 255
    });
    mdns.on('query', onQuery);
    mdns.on('error', function (e) {
      lastError = e && e.message ? e.message : String(e);
      console.warn('[mdns] socket error: ' + lastError);
      // 绑定失败是异步 error：此时 mdns 对象已创建但不可用，必须置空，
      // 否则 /api/discovery 会误报 enabled=true。Linux 上可改用 avahi 发布别名。
      if (/EADDRINUSE|EACCES|EPERM/i.test(lastError)) {
        try { mdns.destroy(); } catch (ignore) { /* already closed */ }
        mdns = null;
        console.warn('[mdns] disabled: .local 不生效（HTTP 服务仍可用）；Linux 可用 avahi 别名或改主机名');
      }
    });
    announce();
    console.log('[mdns] announced ' + HOST + ' -> ' + currentIp + ':' + PORT +
      ' via ' + currentIface);
  } catch (e) {
    lastError = e.message;
    mdns = null;
    console.warn('[mdns] disabled: ' + lastError + ' (HTTP 服务仍可用，只是 .local 不生效)');
  }

  ipTimer = setInterval(watchIp, cfg.network.ipCheckIntervalMs || 30000);
  return state;
}

/** systemd / docker stop 会发 SIGTERM，退出前关掉多播 socket */
function stop() {
  if (ipTimer) { clearInterval(ipTimer); ipTimer = null; }
  if (mdns) {
    try { mdns.destroy(); } catch (ignore) { /* already closed */ }
    mdns = null;
  }
}

function state() {
  return {
    enabled: !!mdns,
    host: HOST,
    instance: INSTANCE,
    serviceType: STYPE,
    ip: currentIp,
    iface: currentIface,
    preferredInterfaces: PREFER,
    port: PORT,
    path: cfg.service.path,
    url: currentIp ? 'http://' + HOST + ':' + PORT + cfg.service.path : null,
    lastChangeAt: lastChangeAt,
    lastError: lastError
  };
}

module.exports = {
  start: start,
  stop: stop,
  state: state,
  pickIp: pickIp,
  pickLan: pickLan
};
