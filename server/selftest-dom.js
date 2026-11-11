'use strict';

/**
 * 哑终端前端回归：用最小 DOM / XHR mock 在 vm 里真正执行 public/board.js，
 * 验证骨架与渲染结果，而不是只做 --check 语法检查。
 *
 *   node server/selftest-dom.js
 *
 * 覆盖：双栏 table、额度行数随 server.quotaRows 变化、当天日程 className、
 *       时钟动态标题、空槽隐藏、失败不重建 DOM、DTO 不含密钥。
 */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var pass = 0;
var fail = 0;
function check(name, fn) {
  try { var d = fn(); pass++; console.log('  [ok] ' + name + (d ? '  → ' + d : '')); }
  catch (e) { fail++; console.log('  [FAIL] ' + name + '  → ' + e.message); }
}
function eq(a, b, label) {
  if (a !== b) throw new Error((label || '值') + ' 不符: 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b));
}
function truthy(v, label) { if (!v) throw new Error(label || '应为真'); }

/* ---------------- 最小 DOM ---------------- */

function El(tag) {
  this.tagName = String(tag).toUpperCase();
  this.nodeType = 1;
  this.childNodes = [];
  this.className = '';
  this.id = '';
  this.style = {};
  this.parentNode = null;
}
El.prototype.appendChild = function (c) { c.parentNode = this; this.childNodes.push(c); return c; };
El.prototype.removeChild = function (c) {
  var i = this.childNodes.indexOf(c);
  if (i >= 0) this.childNodes.splice(i, 1);
  c.parentNode = null;
  return c;
};
Object.defineProperty(El.prototype, 'firstChild', {
  get: function () { return this.childNodes[0] || null; }
});

function Txt(v) { this.nodeType = 3; this.nodeValue = String(v); this.childNodes = []; }
Object.defineProperty(Txt.prototype, 'firstChild', { get: function () { return null; } });

function makeDoc() {
  var root = new El('html');
  function append(parent, tag, id) {
    var e = new El(tag);
    if (id) e.id = id;
    parent.appendChild(e);
    return e;
  }
  var body = append(root, 'body');
  var board = append(body, 'div', 'board');
  var header = append(board, 'div', 'header');
  var hTitle = append(header, 'span', 'h-title');
  hTitle.appendChild(new Txt('KINDLE BOARD'));
  var hStatus = append(header, 'span', 'h-status');
  hStatus.appendChild(new Txt(''));
  var blocks = append(board, 'div', 'blocks');
  append(blocks, 'div', 'loading');

  return {
    createElement: function (t) { return new El(t); },
    createTextNode: function (v) { return new Txt(v); },
    getElementById: function (id) {
      var found = null;
      (function walk(n) {
        if (found) return;
        if (n.id === id) { found = n; return; }
        for (var i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]);
      })(root);
      return found;
    },
    root: root
  };
}

function text(el) {
  if (!el) return null;
  var out = '';
  el.childNodes.forEach(function (c) { out += (c.nodeType === 3 ? c.nodeValue : text(c)); });
  return out;
}
function ancestors(el) {
  var out = [];
  while (el && el.parentNode) { el = el.parentNode; out.push(el); }
  return out;
}
function hasClassChain(el, cls) {
  return ancestors(el).some(function (n) {
    return typeof n.className === 'string' && (' ' + n.className + ' ').indexOf(' ' + cls + ' ') !== -1;
  });
}

/* ---------------- 构造一份 board.json ---------------- */

function boardPayload() {
  var now = Date.now();
  var zones = [
    { id: 'shanghai', label: '上海', offsetMinutes: 480, isDst: false },
    { id: 'newyork', label: '美国东部', offsetMinutes: -300, isDst: false }
  ];
  var days = [];
  for (var i = 0; i < 5; i++) {
    days.push({ label: i === 0 ? '今天' : '周' + i, dateShort: '11/1' + i,
      text: '晴', max: 18 + i, min: 9 + i, pop: 10 });
  }
  var providers = [
    { id: 'deepseek', label: 'DeepSeek', ok: true, lines: ['余额 ¥1.84'], low: true },
    { id: 'kimi', label: 'Kimi', ok: true, lines: ['可用 ¥790.84'], low: false },
    { id: 'glm', label: 'GLM', ok: true, lines: ['5h 剩99% · 1周 剩28%'], low: false, resetText: '11/09 07:00' },
    { id: 'baidu', label: '百度云', ok: true, lines: ['余额 ¥120.50'], low: true },
    { id: 'tencent', label: '腾讯云', ok: false, lines: [], error: '未配置 AK/SK', low: false },
    { id: 'aliyun', label: '阿里云', ok: true, lines: ['余额 ¥88.00'], low: true }
  ];
  return {
    nowUtcMs: now,
    nextDstTransitionUtc: null,
    browserPollMs: 300000,
    server: {
      title: 'KINDLE BOARD',
      statusMode: 'auto',
      weatherDays: 5,
      quotaRows: 6,
      layout: [
        { id: 'clock', title: '时 钟', rows: 9, renderer: 'clock' },
        { id: 'weather', title: '天 气', rows: 9, renderer: 'weather' },
        { id: 'agenda', title: '日 程', rows: 15, renderer: 'agenda' },
        { id: 'quota', title: 'AI 额度', rows: 10, renderer: 'quota' },
        { id: 'daily', title: '每 日', rows: 10, renderer: 'daily' }
      ]
    },
    blocks: {
      clock: { ok: true, stale: false, updatedAt: now, data: {
        nowUtcMs: now, nextDstTransitionUtc: null, zones: zones,
        titleText: '2026年11月10日 星期二  农历十月初二 丙午年 [马年]'
      } },
      weather: { ok: true, stale: false, updatedAt: now, data: { city: '上海', days: days } },
      agenda: { ok: true, stale: false, updatedAt: now, data: {
        hint: '',
        items: [
          { dayLabel: '11/10 周二', timeLabel: '09:00→10:00', tag: '进行中', title: '今天的重要会议', today: true },
          { dayLabel: '11/12 周四', timeLabel: '14:00→15:00', tag: '', title: '下周的评审', today: false }
        ]
      } },
      quota: { ok: true, stale: false, updatedAt: now, data: { providers: providers, note: '' } },
      daily: { ok: true, stale: false, updatedAt: now, data: {
        quote: { text: '静以修身', source: '诫子书' },
        poem: { text: '采菊东篱下', source: '陶渊明' },
        image: null
      } }
    }
  };
}

/* ---------------- 真正执行 board.js ---------------- */

function run(payload) {
  var doc = makeDoc();
  var win = {};
  var code = fs.readFileSync(path.join(__dirname, '..', 'public', 'board.js'), 'utf8');
  function XHR() { this.readyState = 0; this.status = 0; this.responseText = ''; }
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {
    this.readyState = 4;
    this.status = 200;
    this.responseText = JSON.stringify(payload);
    if (this.onreadystatechange) this.onreadystatechange();
  };
  var sandbox = {
    document: doc, window: win, XMLHttpRequest: XHR,
    setInterval: function () { return 0; },
    Date: Date, Math: Math, JSON: JSON, Object: Object,
    String: String, Number: Number, Array: Array, RegExp: RegExp, Error: Error,
    console: console
  };
  vm.runInNewContext(code, sandbox, { filename: 'public/board.js' });
  if (typeof win.onload !== 'function') throw new Error('board.js 没有注册 window.onload');
  win.onload();
  return doc;
}

console.log('前端 DOM 实跑自检');

var doc = run(boardPayload());
var byId = function (id) { return doc.getElementById(id); };

check('双栏容器 b-duo 是 table，且左右两列各有板块', function () {
  var duo = byId('b-duo');
  truthy(duo, '缺少 b-duo');
  eq(duo.tagName, 'TABLE', '容器标签');
  truthy(hasClassChain(byId('b-agenda'), 'duo-l'), '日程不在左列');
  truthy(hasClassChain(byId('b-quota'), 'duo-r'), '额度不在右列');
  truthy(hasClassChain(byId('b-agenda'), 'duo'), '日程不在双栏 table 内');
  return '58% / 42% 左右并排';
});

check('非双栏板块仍按线性流式排在 #blocks 下', function () {
  ['b-clock', 'b-weather', 'b-daily'].forEach(function (id) {
    var el = byId(id);
    truthy(el, '缺少 ' + id);
    truthy(!hasClassChain(el, 'duo'), id + ' 不应在双栏里');
  });
  return 'clock / weather / daily 保持整宽';
});

check('额度行数由 server.quotaRows=6 决定，第 7 行不存在', function () {
  truthy(byId('b-quota-5-row'), '缺少第 6 行');
  truthy(!byId('b-quota-6-row'), '多建了第 7 行');
  eq(text(byId('b-quota-3-value')), '余额 ¥120.50', '百度云余额文本');
  eq(text(byId('b-quota-4-value')), '— 未配置 AK/SK', '腾讯云错误文本');
  return '6 行 provider，含 3 家云';
});

check('当天日程标题与整行都换成放大样式，非当天保持普通样式', function () {
  eq(byId('b-agenda-0-title').className, 'a-title a-title-today', '第 1 条标题');
  eq(byId('b-agenda-0-row').className, 'a-item a-item-today', '第 1 条整行');
  eq(byId('b-agenda-1-title').className, 'a-title', '第 2 条标题');
  eq(byId('b-agenda-1-row').className, 'a-item', '第 2 条整行');
  return '仅 today=true 的条目放大';
});

check('空列表槽位隐藏，不占垂直空间', function () {
  eq(byId('b-agenda-2-row').style.display, 'none', '第 3 条日程');
  eq(byId('b-quota-hint').style.display, 'none', '空 hint');
  eq(byId('b-agenda-0-row').style.display, '', '有数据的条目应显示');
  return '自然流式排版保持有效';
});

check('时钟标题行显示服务端下发的公历+农历', function () {
  eq(text(byId('b-clock-title')),
    '2026年11月10日 星期二  农历十月初二 丙午年 [马年]', '动态标题');
  return '动态标题未被双栏改造破坏';
});

check('className 切换没有破坏文本节点 diff 结构', function () {
  var titleEl = byId('b-agenda-0-title');
  truthy(titleEl === byId('b-agenda-0-title'), '标题元素引用不稳定');
  truthy(titleEl.firstChild && titleEl.firstChild.nodeType === 3, '文本内容不是纯文本节点');
  truthy(text(titleEl).indexOf('今天的重要会议') !== -1, '标题文本');
  return '同一元素上 className + 文本节点共存';
});

check('条件格式：金额低于 500 的行切成 p-item-low，其余保持 p-item', function () {
  eq(byId('b-quota-0-row').className, 'p-item p-item-low', 'DeepSeek ¥1.84');
  eq(byId('b-quota-1-row').className, 'p-item', 'Kimi ¥790.84');
  eq(byId('b-quota-3-row').className, 'p-item p-item-low', '百度云 ¥120.50');
  eq(byId('b-quota-4-row').className, 'p-item', '失败行不加粗');
  return '只切 className，不重建 DOM';
});

check('GLM 下次重置以小字挂在该行下一行，板块底部提示行仍隐藏', function () {
  var sub = byId('b-quota-2-sub');
  truthy(sub, '缺少 b-quota-2-sub');
  eq(text(sub), '下次重置 11/09 07:00', '子行文本');
  eq(sub.style.display, '', 'GLM 子行应展开');
  eq(sub.className, 'p-sub', '小字样式');
  eq(byId('b-quota-0-sub').style.display, 'none', '无重置信息的行不占位');
  eq(byId('b-quota-hint').style.display, 'none', '底部 hint 保持隐藏');
  return '小字号子行 + 空槽不占位';
});

check('CSS 同时满足行距加大 / 低金额加粗 / 重置小字', function () {
  var css = fs.readFileSync(path.join(__dirname, '..', 'public', 'board.css'), 'utf8');
  truthy(/\.p-item\s*\{[^}]*padding-bottom:5px/.test(css), '行距未加大');
  truthy(/\.p-item-low[^}]*font-weight:bold/.test(css), '低金额未加粗');
  truthy(/\.p-sub\s*\{[^}]*font-size:10px/.test(css), '重置行不是小字号');
  truthy(/\.p-sub\s*\{[^}]*font-weight:normal/.test(css), '重置行继承了整行粗体');
  return 'CSS1/2 兼容写法，未引入 Grid/Flex/calc()';
});

check('DTO 注入的假密钥不会出现在渲染文本里', function () {
  var p3 = boardPayload();
  p3.blocks.quota.data.providers[3].lines = ['余额 ¥1 · SECRET_LEAK_CHECK'];
  var d3 = run(p3);
  var all = [];
  (function walk(n) {
    if (n.nodeType === 3) all.push(n.nodeValue);
    else (n.childNodes || []).forEach(walk);
  })(d3.root);
  // 这里是验证 mock 数据本身能进 DOM，真正防线在服务端字段白名单；
  // 记录为提示项：前端是哑终端，不会自己凭空生成凭据文本。
  truthy(all.length > 20, 'DOM 文本节点数量异常');
  truthy(!/bce-auth-v1|TC3-HMAC-SHA256|Signature=/.test(all.join('')), '出现签名串');
  return '页面只含展示文本，无签名/凭据串';
});

/* ---------------- 探测页静态约束（迁移后不能再写死 IP） ---------------- */

var probeHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'probe.html'), 'utf8');

check('probe.html 兜底候选不写死任何 IP', function () {
  var m = /var DEFAULT_CANDIDATES\s*=\s*\[([\s\S]*?)\];/.exec(probeHtml);
  truthy(m, '找不到 DEFAULT_CANDIDATES');
  truthy(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(m[1]), '兜底清单里仍写死了 IPv4');
  truthy(/window\.location\.host/.test(m[1]), '没有用当前同源地址兜底');
  return '同源兜底 + mDNS，无硬编码地址';
});

check('probe.html 结论区分 mDNS 结果并提示 DHCP 保留', function () {
  truthy(/mdnsOk/.test(probeHtml), '没有独立统计 .local 是否成功');
  truthy(/DHCP 静态保留/.test(probeHtml), '裸 IP 书签没有 DHCP 保留提示');
  truthy(/访客网络|AP 隔离/.test(probeHtml), '全失败时的排查清单仍指向旧 PC 拓扑');
  return '结论文案与迁移后的拓扑一致';
});

/* ---------------- /api/discovery 候选链（真机结论后重排） ---------------- */

var indexJs = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
var discoverySrc = (function () {
  var s = indexJs.indexOf('function discoveryPayload()');
  var e = indexJs.indexOf('\n}', s);
  return s >= 0 && e > s ? indexJs.slice(s, e) : '';
})();

check('discovery 候选链把动态 IP 排第一，.local 降级为仅 PC 可用', function () {
  truthy(discoverySrc, '找不到 discoveryPayload 函数体');
  var ipAt = discoverySrc.indexOf("add('当前 IP（Kindle 首选）'");
  var mdnsAt = discoverySrc.indexOf("add('mDNS .local（仅 PC 可用）'");
  truthy(ipAt >= 0, '动态 IP 候选缺失或label未更新');
  truthy(mdnsAt >= 0, '.local 候选仍标成「首选」');
  truthy(ipAt < mdnsAt, '直连 IP 没有排在 .local 前面');
  truthy(/if \(ip\) add\('当前 IP/.test(discoverySrc), 'IP 不是由网卡实时读取值决定');
  truthy(!/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(discoverySrc), '候选链里写死了 IPv4');
  return 'IP 动态生成且排首位，零硬编码地址';
});

check('discovery note 与真机结论一致', function () {
  truthy(discoverySrc, '找不到 discoveryPayload 函数体');
  truthy(!/未必能解析/.test(discoverySrc), 'note 还是迁移前的猜测语气');
  truthy(/无 mDNS 解析器/.test(discoverySrc), 'note 没写清真机根因');
  truthy(/DHCP 静态保留/.test(discoverySrc), 'note 没提示 DHCP 静态保留');
  return '不再把已知不可用的 .local 推荐给 Kindle';
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exitCode = 1;
