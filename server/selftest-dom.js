'use strict';

/**
 * 哑终端前端回归：用最小 DOM / XHR mock 在 vm 里真正执行 public/board.js，
 * 验证骨架与渲染结果，而不是只做 --check 语法检查。
 *
 *   node server/selftest-dom.js
 *
 * 覆盖：双栏 table（日程 | 每日 50/50）、额度整宽横向 6 格与三行拆字、
 *       每日窄栏上文下图 / 旧 layout 回滚、额度行数随 server.quotaRows 变化、
 *       当天日程 className、时钟动态标题、空槽隐藏、失败不重建 DOM、DTO 不含密钥、
 *       双地区天气热区 / 线条图标类别 / 点击切换 / 二次 poll 保持选择 /
 *       旧单城市 DTO 降级、严格 ES5 语法。
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

/* ---------------- 构造一份 board.json ----------------
   注意：下面的地名、坐标、日程标题与账户金额全部是通用示例 / 虚构值，
   不含任何真实地点、日程或余额数据。 */

function boardPayload() {
  var now = Date.now();
  var zones = [
    { id: 'shanghai', label: '上海', offsetMinutes: 480, isDst: false },
    { id: 'newyork', label: '纽约', offsetMinutes: -300, isDst: false }
  ];
  var shanghaiDays = [];
  var newyorkDays = [];
  for (var i = 0; i < 5; i++) {
    shanghaiDays.push({ label: i === 0 ? '今天' : '周' + i, dateShort: '11/1' + i,
      text: '晴', code: 0, category: 'sun', max: 18 + i, min: 9 + i, pop: 10 });
    newyorkDays.push({ label: i === 0 ? '今天' : '周' + i, dateShort: '11/1' + i,
      text: '雪', code: 71, category: 'snow', max: 2 + i, min: -5 + i, pop: 60 });
  }
  var providers = [
    { id: 'deepseek', label: 'DeepSeek', ok: true, lines: ['余额 ¥100.00'], low: true },
    { id: 'kimi', label: 'Kimi', ok: true, lines: ['可用 ¥800.00'], low: false },
    { id: 'glm', label: 'GLM', ok: true, lines: ['5h 剩99% · 1周 剩28%'], low: false, resetText: '11/09 07:00' },
    { id: 'baidu', label: '百度云', ok: true, lines: ['余额 ¥200.00'], low: true },
    { id: 'tencent', label: '腾讯云', ok: false, lines: [], error: '未配置 AK/SK', low: false },
    { id: 'aliyun', label: '阿里云', ok: true, lines: ['余额 ¥80.00'], low: true }
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
        { id: 'daily', title: '每 日', rows: 10, renderer: 'daily' },
        { id: 'quota', title: 'AI 额度', rows: 10, renderer: 'quota' }
      ]
    },
    blocks: {
      clock: { ok: true, stale: false, updatedAt: now, data: {
        nowUtcMs: now, nextDstTransitionUtc: null, zones: zones,
        titleText: '2026年11月10日 星期二  农历十月初二 丙午年 [马年]'
      } },
      weather: { ok: true, stale: false, updatedAt: now, data: {
        provider: 'open-meteo',
        defaultCity: 'shanghai',
        cities: [
          { key: 'shanghai', name: '上海', lat: 31.2304, lon: 121.4737,
            timezone: 'Asia/Shanghai', days: shanghaiDays, ok: true, error: '' },
          { key: 'newyork', name: '纽约', lat: 40.7128, lon: -74.0060,
            timezone: 'America/New_York', days: newyorkDays, ok: true, error: '' }
        ]
      } },
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

/** 返回 doc；另挂 __intervals / __timeouts / __reloads / __setPayload，
 *  用来手动触发 5 分钟轮询、5 秒定时器并统计整页重载次数。 */
function run(payload) {
  var doc = makeDoc();
  var win = {};
  var holder = { payload: payload };
  var intervals = [];
  var timeouts = [];
  var reloads = 0;
  win.location = { href: 'http://board.test/', reload: function () { reloads++; } };
  var code = fs.readFileSync(path.join(__dirname, '..', 'public', 'board.js'), 'utf8');
  function XHR() { this.readyState = 0; this.status = 0; this.responseText = ''; }
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {
    this.readyState = 4;
    this.status = 200;
    this.responseText = JSON.stringify(holder.payload);
    if (this.onreadystatechange) this.onreadystatechange();
  };
  var sandbox = {
    document: doc, window: win, XMLHttpRequest: XHR,
    setInterval: function (fn) { intervals.push(fn); return intervals.length; },
    setTimeout: function (fn, ms) { timeouts.push({ fn: fn, ms: ms }); return timeouts.length; },
    clearTimeout: function () {},
    Date: Date, Math: Math, JSON: JSON, Object: Object,
    String: String, Number: Number, Array: Array, RegExp: RegExp, Error: Error,
    console: console
  };
  vm.runInNewContext(code, sandbox, { filename: 'public/board.js' });
  if (typeof win.onload !== 'function') throw new Error('board.js 没有注册 window.onload');
  win.onload();
  doc.__intervals = intervals;
  doc.__timeouts = timeouts;
  doc.__reloads = function () { return reloads; };
  doc.__setPayload = function (p) { holder.payload = p; };
  return doc;
}

console.log('前端 DOM 实跑自检');

var doc = run(boardPayload());
var byId = function (id) { return doc.getElementById(id); };

check('双栏容器 b-duo 是 table，左右两列是「日程 | 每日」且等宽 50/50', function () {
  var duo = byId('b-duo');
  truthy(duo, '缺少 b-duo');
  eq(duo.tagName, 'TABLE', '容器标签');
  truthy(hasClassChain(byId('b-agenda'), 'duo-l'), '日程不在左列');
  truthy(hasClassChain(byId('b-daily'), 'duo-r'), '每日不在右列');
  truthy(hasClassChain(byId('b-agenda'), 'duo'), '日程不在双栏 table 内');
  truthy(!hasClassChain(byId('b-quota'), 'duo'), '额度不应再在双栏里');
  var duoRow = duo.childNodes[0].childNodes[0];
  eq(duoRow.childNodes[0].style.width, '50%', '日程列宽');
  eq(duoRow.childNodes[1].style.width, '50%', '每日列宽');
  return 'agenda | daily 50/50 等宽并排';
});

check('非双栏板块仍按线性流式排在 #blocks 下，额度整宽沉底', function () {
  ['b-clock', 'b-weather', 'b-quota'].forEach(function (id) {
    var el = byId(id);
    truthy(el, '缺少 ' + id);
    truthy(!hasClassChain(el, 'duo'), id + ' 不应在双栏里');
  });
  eq(byId('b-quota').parentNode.id, 'blocks', '额度未直接挂在 #blocks 下');
  return 'clock / weather / quota 保持整宽';
});

check('额度整宽后排成横向 6 格 table.q6，第 7 格不存在', function () {
  var grid = byId('b-quota-grid');
  truthy(grid, '缺少 b-quota-grid');
  eq(grid.tagName, 'TABLE', '额度容器不是 table');
  eq(grid.className, 'q6', '额度容器类名');
  var row = grid.childNodes[0].childNodes[0];
  eq(row.childNodes.length, 6, '横向格子数不是 6');
  for (var i = 0; i < 6; i++) {
    eq(row.childNodes[i].id, 'b-quota-' + i + '-row', '第 ' + (i + 1) + ' 格 id');
    truthy(row.childNodes[i].className.indexOf('q-cell') === 0, '第 ' + (i + 1) + ' 格不是 q-cell');
  }
  eq(row.childNodes[0].style.borderLeft, '0', '首格仍画了分隔竖线');
  truthy(byId('b-quota-5-row'), '缺少第 6 格');
  truthy(!byId('b-quota-6-row'), '多建了第 7 格');
  eq(byId('b-quota-3-name').parentNode.id, 'b-quota-3-row', '三行未落在同一格内');
  return '6 个 td 在同一 tr 里，不再纵向堆叠';
});

check('每格「名称 / 标签 / 纯数字」三行纵排，减少文字并突出数字', function () {
  eq(byId('b-quota-3-name').className, 'q-name', '名称样式');
  eq(byId('b-quota-3-label').className, 'q-label', '标签样式');
  eq(byId('b-quota-3-num').className, 'q-num', '数字样式');
  var cell = byId('b-quota-3-row');
  eq(cell.childNodes[0].id, 'b-quota-3-name', '第 1 行应是名称');
  eq(cell.childNodes[1].id, 'b-quota-3-label', '第 2 行应是标签');
  eq(cell.childNodes[2].id, 'b-quota-3-num', '第 3 行应是数字');
  eq(text(byId('b-quota-3-name')), '百度云', '名称文本');
  eq(text(byId('b-quota-3-label')), '余额', '标签文本');
  eq(text(byId('b-quota-3-num')), '200', '数字应去掉 ¥、小数与「余额」');
  eq(text(byId('b-quota-1-label')), '可用', 'Kimi 沿用原文「可用」');
  eq(text(byId('b-quota-1-num')), '800', 'Kimi 数字');
  eq(text(byId('b-quota-0-name')), 'Deep…', '英文长名称裁到 5 字符');
  return '纯前端拆字，服务端 DTO 不变';
});

check('余额一律只保留整数（用户要求），真机上不再贴满格边', function () {
  var p = boardPayload();
  p.blocks.quota.data.providers[0].lines = ['余额 ¥1234.56'];
  p.blocks.quota.data.providers[1].lines = ['可用 ¥987.65'];
  p.blocks.quota.data.providers[2].lines = ['余额 ¥0.99'];
  var d = run(p);
  eq(text(d.getElementById('b-quota-0-num')), '1234', '带小数金额应截成整数');
  eq(text(d.getElementById('b-quota-1-num')), '987', '另一家也应截成整数');
  eq(text(d.getElementById('b-quota-2-num')), '0', '不足 1 的余额应显示 0');
  truthy(text(d.getElementById('b-quota-0-num')).length <= 7, '数字超过 7 字符');
  return '整数 + 20px 大数字 + 94px 限宽 + 3px 留白';
});

check('无 ¥ 金额的 provider 取剩余百分比，失败/空格子显示大号 —', function () {
  eq(text(byId('b-quota-2-num')), '99%', 'GLM 应取第一个剩余百分比');
  eq(text(byId('b-quota-2-label')), '剩', 'GLM 标签');
  eq(text(byId('b-quota-4-num')), '—', '失败格子应显示 —');
  eq(text(byId('b-quota-4-label')), '', '失败格子不应有标签文字');
  var p = boardPayload();
  p.blocks.quota.data.providers = [];
  var d = run(p);
  eq(text(d.getElementById('b-quota-5-num')), '—', '空 provider 的格子应填 —');
  truthy(d.getElementById('b-quota-5-row').style.display !== 'none', '空格子不应隐藏 td');
  return '6 格始终填满，不空档、不破坏等分列';
});

check('每日进窄栏后「上文下图」：图片挂在文字之后且按栏宽放大', function () {
  var img = byId('b-daily-img');
  truthy(hasClassChain(img, 'duo-r'), '每日图片不在双栏右列');
  truthy(img.className.indexOf('d-img-narrow') !== -1, '窄栏图片缺少 d-img-narrow');
  truthy(hasClassChain(img, 'bc'), '图片未直接挂在 .bc 下');
  var bc = img.parentNode;
  var posImg = -1, posQuote = -1, posCaption = -1, i, hasTable = false;
  for (i = 0; i < bc.childNodes.length; i++) {
    if (bc.childNodes[i].id === 'b-daily-img') posImg = i;
    if (bc.childNodes[i].id === 'b-daily-quote') posQuote = i;
    if (bc.childNodes[i].id === 'b-daily-caption') posCaption = i;
    if (bc.childNodes[i].tagName === 'TABLE') hasTable = true;
  }
  truthy(posQuote >= 0 && posCaption >= 0 && posImg > posCaption, '图片必须排在全部文字之后');
  truthy(!hasTable, '窄栏不应再建左右两列的 table.fixed');
  return 'quote / src / poem / src / caption / img 顺序纵排';
});

check('窄栏收紧每日文字截断；改回旧 layout 可无缝回滚', function () {
  var longQuote = '这是一个非常非常长的引语句子用来验证窄栏截断';
  var p = boardPayload();
  p.blocks.daily.data.quote.text = longQuote;
  var d = run(p);
  truthy(text(d.getElementById('b-daily-quote')).length <= 18, '窄栏引语未收紧截断');
  var old = boardPayload();
  old.server.layout = [
    { id: 'clock', title: '时 钟', rows: 9, renderer: 'clock' },
    { id: 'weather', title: '天 气', rows: 9, renderer: 'weather' },
    { id: 'agenda', title: '日 程', rows: 15, renderer: 'agenda' },
    { id: 'quota', title: 'AI 额度', rows: 10, renderer: 'quota' },
    { id: 'daily', title: '每 日', rows: 10, renderer: 'daily' }
  ];
  old.blocks.daily.data.quote.text = longQuote;
  var d2 = run(old);
  truthy(text(d2.getElementById('b-daily-quote')).length <= 30, '整宽截断长度被误改');
  truthy(d2.getElementById('b-daily-img').className.indexOf('d-img-narrow') === -1,
    '回滚旧 layout 后图片不应还是窄栏形态');
  truthy(hasClassChain(d2.getElementById('b-quota'), 'duo-r'), '旧 layout 双栏未恢复');
  return 'isDuo 保留旧配对，只改 config 即可回滚';
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

check('条件格式：金额低于 500 的格子切成 q-cell-low，其余保持 q-cell', function () {
  eq(byId('b-quota-0-row').className, 'q-cell q-cell-low', 'DeepSeek ¥100.00');
  eq(byId('b-quota-1-row').className, 'q-cell', 'Kimi ¥800.00');
  eq(byId('b-quota-3-row').className, 'q-cell q-cell-low', '百度云 ¥200.00');
  eq(byId('b-quota-4-row').className, 'q-cell', '失败格子不加粗');
  return '只切 className，不重建 DOM';
});

check('减少文字：不再渲染「下次重置」小字行与底部提示行', function () {
  eq(byId('b-quota-2-sub'), null, '窄格内仍建了 p-sub 子行');
  eq(text(byId('b-quota-2-num')).indexOf('下次重置'), -1, '数字行混入了重置文字');
  eq(byId('b-quota-hint').style.display, 'none', '底部 hint 应保持隐藏');
  return 'resetText / note 均不占版面';
});

check('CSS：日程 / 额度 / 每日正文加大，注释小字字号不变，弹窗样式齐备', function () {
  var css = fs.readFileSync(path.join(__dirname, '..', 'public', 'board.css'), 'utf8');
  // 头注释里有「不用 Grid / Flex / calc()」的说明文字，禁用特性检测必须剥离注释
  var cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
  truthy(/\.p-item\s*\{[^}]*padding-bottom:12px/.test(css), '额度行距未加大到 12px');
  truthy(/\.a-title\s*\{[^}]*font-size:17px/.test(css), '日程标题字号未加大');
  truthy(/\.a-day\s*\{[^}]*font-size:15px/.test(css), '日程日期字号未加大');
  truthy(/\.p-name\s*\{[^}]*font-size:15px/.test(css), '额度名称字号未加大');
  truthy(/\.p-value,\s*\.p-value span\s*\{[^}]*font-size:15px/.test(css), '额度数值字号未加大');
  truthy(/\.d-line\s*\{[^}]*font-size:17px/.test(css), '每日正文字号未加大');
  truthy(/\.d-line\s*\{[^}]*line-height:24px/.test(css), '每日正文行距未加大');
  // 注释类小字必须维持 12px，不能跟着放大
  truthy(/\.row-s\s*\{[^}]*font-size:12px/.test(css), '注释小字 .row-s 字号被改动');
  truthy(/\.p-sub\s*\{[^}]*font-size:12px/.test(css), '注释小字 .p-sub 字号被改动');
  truthy(/\.bt-s\s*\{[^}]*font-size:12px/.test(css), '注释小字 .bt-s 字号被改动');
  truthy(/\.p-item-low[^}]*font-weight:bold/.test(css), '低金额未加粗');
  truthy(/\.p-sub\s*\{[^}]*font-weight:normal/.test(css), '重置行继承了整行粗体');
  truthy(/td\.zone-on\s*\{[^}]*border-bottom:2px solid #000/.test(css), '选中半栏加粗规则缺失');
  truthy(!/\.wx-hit\.wx-on\s*\{[^}]*border-bottom/.test(css), '热区底部仍画选中下划线');
  truthy(/#b-clock\s*\{[^}]*padding-bottom:0/.test(css), '选中线未贴合板块分隔线');
  truthy(/\.wico-sun\s+\.wk-sun-circle/.test(css), '线条图标显隐规则缺失');
  // 第三轮：天气图标放大 + 温度/天气文字移到图标右侧，改字号时务必同步这段断言
  truthy(/\.wico\s*\{[^}]*width:54px/.test(css), '天气图标宽度未放大到 54px');
  truthy(/\.wico\s*\{[^}]*height:58px/.test(css), '天气图标高度未放大到 58px');
  truthy(/\.wico\s+\.wk-shape\s*\{[^}]*border:3px/.test(css), '放大后图标笔画未加粗到 3px');
  truthy(/td\.zone-l\s*\{[^}]*width:140px/.test(css), '时钟列未收窄');
  truthy(/td\.zone-r\s*\{[^}]*width:160px/.test(css), '天气列未加宽到 160px');
  truthy(/td\.wx-ico-cell\s*\{[^}]*width:58px/.test(css), '图标列宽度缺失');
  truthy(/td\.wx-txt-cell\s*\{[^}]*vertical-align:middle/.test(css), '右侧两行文字未垂直居中');
  truthy(/\.wx-temp\s*\{[^}]*font-size:18px/.test(css), '时钟温度字号未放大到 18px');
  truthy(/\.wx-text\s*\{[^}]*font-size:17px/.test(css), '时钟天气文字字号未放大到 17px');
  truthy(/\.w5-temp\s*\{[^}]*font-size:16px/.test(css), '5 日预报温度字号未放大');
  truthy(/\.w5-text\s*\{[^}]*font-size:15px/.test(css), '5 日预报天气文字字号未放大');
  truthy(/\.w5-pop\s*\{[^}]*font-size:12px/.test(css), '降水概率等注释小字被改动');
  truthy(/#board\s*\{[^}]*position:relative/.test(css), '弹窗缺少定位参照');
  truthy(/\.lb\s*\{[^}]*position:absolute/.test(css), '大图弹窗未用 absolute 覆盖层');
  truthy(/\.lb-img\s*\{[^}]*width:560px/.test(css), '大图未放大');
  // 第四轮：右下角缩略图的黑边框已按用户要求移除，防止回滚
  var imgRule = (css.match(/#b-daily-img\s*\{[^}]*\}/) || [''])[0];
  truthy(imgRule && !/border\s*:/.test(imgRule), '右下角缩略图又出现边框');
  // 第六轮：额度横向 6 格，每格名称 / 标签 / 纯数字三行，数字必须够大够醒目
  truthy(/table\.q6\s*\{[^}]*table-layout:fixed/.test(css), '横向 6 格表格缺少 table-layout:fixed');
  truthy(/td\.q-cell\s*\{[^}]*border-left:1px solid #999/.test(css), '格子分隔竖线缺失');
  truthy(/\.q-num\s*\{[^}]*font-family:monospace/.test(css), '数字未用等宽字体');
  truthy(/\.q-num\s*\{[^}]*font-size:20px/.test(css), '整数余额应放大到 20px 突出数字');
  truthy(/\.q-num\s*\{[^}]*width:94px/.test(css), '数字未限宽，旧 WebKit 的 td 内 overflow 不可靠');
  truthy(/td\.q-cell\s*\{[^}]*padding:2px 3px/.test(css), '格子左右留白不足');
  truthy(/\.q-num\s*\{[^}]*font-weight:bold/.test(css), '数字未加粗');
  truthy(/\.q-name\s*\{[^}]*font-size:12px/.test(css), '名称应是精简小字');
  truthy(/\.q-label\s*\{[^}]*font-size:12px/.test(css), '标签应是精简小字');
  truthy(/\.q-cell-low\s+\.q-num\s*\{[^}]*font-size:22px/.test(css), '低余额数字未再放大');
  var lowRule = (css.match(/\.q-cell-low\s+\.q-num\s*\{[^}]*\}/) || [''])[0];
  truthy(lowRule && /text-decoration:underline/.test(lowRule), '低余额未用数字下划线强调');
  truthy(lowRule && !/border-bottom/.test(lowRule), '低余额又画了横跨整格的表格线');
  // 第六轮：窄栏每日图片按栏宽放大，且同样不得出现黑边框
  var narrowRule = (css.match(/#b-daily-img\.d-img-narrow\s*\{[^}]*\}/) || [''])[0];
  truthy(narrowRule && /width:280px/.test(narrowRule), '窄栏图片未按栏宽放大到 280px');
  truthy(narrowRule && /height:164px/.test(narrowRule), '窄栏图片高度未按比例放大');
  truthy(narrowRule && !/border\s*:/.test(narrowRule), '窄栏缩略图又出现边框');
  truthy(!/display\s*:\s*(grid|flex)/.test(cssCode), '引入了 Grid/Flex');
  truthy(!/calc\(/.test(cssCode), '引入了 calc()');
  return 'CSS1/2 兼容写法 + 正文放大 / 注释小字不变 + 6 格数字 / 大图弹窗';
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
  // 第六轮：额度小格只提取数字与简短标签，provider 原文（含错误串 / 追踪串）
  // 一律不进 DOM，减少文字的同时也收窄了信息暴露面。
  truthy(all.length > 20, 'DOM 文本节点数量异常');
  truthy(text(d3.getElementById('b-quota-3-num')) === '1', '注入行的金额数字未正确提取');
  truthy(all.join('').indexOf('SECRET_LEAK_CHECK') === -1, '额度原文里的追踪串进了 DOM');
  truthy(!/bce-auth-v1|TC3-HMAC-SHA256|Signature=/.test(all.join('')), '出现签名串');
  return '额度只渲染数字与标签，原文 / 签名 / 凭据串均不进 DOM';
});

/* ---------------- 双地区天气：图标 / 温度 / 点击切换 ---------------- */

check('两个时钟各有一个天气热区，且线条图标笔画已一次性预建', function () {
  var i, hit, ico;
  for (i = 0; i < 2; i++) {
    hit = byId('b-clock-' + i + '-wx');
    ico = byId('b-clock-' + i + '-ico');
    truthy(hit, '缺少 b-clock-' + i + '-wx');
    truthy(ico, '缺少 b-clock-' + i + '-ico');
    truthy(typeof hit.onclick === 'function', '热区没有绑定 DOM0 onclick');
    truthy(ico.childNodes.length >= 20, '图标笔画未预建（只有 ' + ico.childNodes.length + ' 个）');
    truthy(hit.style.display !== 'none', '热区被误隐藏');
  }
  return '每侧 24 笔画，靠父 className 显隐';
});

check('天气图标在左列，温度与天气文字在右列纵向排列', function () {
  var i, ico, temp, txt;
  for (i = 0; i < 2; i++) {
    ico = byId('b-clock-' + i + '-ico');
    temp = byId('b-clock-' + i + '-temp');
    txt = byId('b-clock-' + i + '-text');
    truthy(ico && temp && txt, '缺少天气图标或文字元素');
    truthy(hasClassChain(ico, 'wx-ico-cell'), '图标未放进左侧单元格');
    truthy(hasClassChain(temp, 'wx-txt-cell'), '温度未放进右侧单元格');
    truthy(hasClassChain(txt, 'wx-txt-cell'), '天气文字未放进右侧单元格');
    truthy(hasClassChain(ico, 'wx-grid') && hasClassChain(temp, 'wx-grid'),
      '图标与文字不在同一行两列表格里');
    eq(temp.className, 'wx-temp', '温度样式类名');
    eq(txt.className, 'wx-text', '天气文字样式类名');
  }
  return '两侧都是「放大图标 | 温度 + 天气文字」，b-* id 不变';
});

check('默认选中 defaultCity=shanghai：标题、5 日列、选中框与图标类别正确', function () {
  eq(text(byId('b-weather-title')), '天 气 · 上海', '天气标题');
  eq(text(byId('b-weather-0-text')), '晴', '第 1 天天气');
  eq(text(byId('b-weather-0-temp')), '18°/9°', '第 1 天温度');
  eq(byId('b-clock-0-wx').className, 'wx-hit wx-on', '上海热区未选中');
  eq(byId('b-clock-1-wx').className, 'wx-hit', '纽约 热区不应选中');
  eq(byId('b-clock-0-zone').className, 'zone zone-on', '上海半栏未加粗');
  eq(byId('b-clock-1-zone').className, 'zone', '纽约 半栏不应加粗');
  eq(byId('b-clock-0-ico').className, 'wico wico-sun', '上海图标类别');
  eq(byId('b-clock-1-ico').className, 'wico wico-snow', '纽约 图标类别');
  eq(text(byId('b-clock-0-temp')), '18°/9°', '上海时钟温度');
  eq(text(byId('b-clock-1-temp')), '2°/-5°', '纽约 时钟温度');
  return '上海 / 纽约 天气同时可见，5 日区默认上海';
});

check('点击第二个时钟热区后，5 日预报与标题切换到 纽约', function () {
  byId('b-clock-1-wx').onclick();
  eq(text(byId('b-weather-title')), '天 气 · 纽约', '标题未切换');
  eq(text(byId('b-weather-0-text')), '雪', '第 1 天天气未切换');
  eq(text(byId('b-weather-0-temp')), '2°/-5°', '第 1 天温度未切换');
  eq(byId('b-clock-0-wx').className, 'wx-hit', '上海热区应取消选中');
  eq(byId('b-clock-1-wx').className, 'wx-hit wx-on', '纽约 热区应选中');
  eq(byId('b-clock-1-zone').className, 'zone zone-on', '纽约 半栏未加粗');
  eq(byId('b-clock-0-zone').className, 'zone', '上海半栏应取消加粗');
  return '纯本地切换，无新请求、骨架不重建';
});

check('点击第一个时钟热区可切回上海', function () {
  byId('b-clock-0-wx').onclick();
  eq(text(byId('b-weather-title')), '天 气 · 上海', '标题未切回');
  eq(text(byId('b-weather-0-text')), '晴', '天气未切回');
  eq(byId('b-clock-0-wx').className, 'wx-hit wx-on', '上海热区应选中');
  return '双向切换可用';
});

check('二次 poll 后仍保持用户选中的地区（不会被 defaultCity 拉回）', function () {
  var p = boardPayload();
  var d = run(p);
  d.getElementById('b-clock-1-wx').onclick();
  eq(text(d.getElementById('b-weather-0-text')), '雪', '切换后应为 纽约');
  p.blocks.weather.data.cities[1].days[0].text = '阴';
  p.blocks.weather.data.cities[1].days[0].category = 'overcast';
  d.__setPayload(p);
  d.__intervals[1]();      // 手动触发 5 分钟轮询回调
  eq(text(d.getElementById('b-weather-0-text')), '阴', '二次 poll 后仍应显示 纽约');
  eq(text(d.getElementById('b-weather-title')), '天 气 · 纽约', '标题保持 纽约');
  eq(d.getElementById('b-clock-1-wx').className, 'wx-hit wx-on', '选中框应保持');
  eq(d.getElementById('b-clock-1-ico').className, 'wico wico-overcast', '图标类别应随新数据更新');
  return '选中态不随 5 分钟刷新回落';
});

check('旧单城市 DTO 降级：隐藏两个天气热区但 5 日天气仍显示', function () {
  var p = boardPayload();
  var legacyDays = p.blocks.weather.data.cities[0].days;
  p.blocks.weather.data = { city: '上海', days: legacyDays };
  var d = run(p);
  eq(d.getElementById('b-clock-0-wx').style.display, 'none', 'legacy 应隐藏上海热区');
  eq(d.getElementById('b-clock-1-wx').style.display, 'none', 'legacy 应隐藏 纽约 热区');
  eq(text(d.getElementById('b-weather-0-text')), '晴', '5 日区仍应渲染');
  eq(text(d.getElementById('b-weather-title')), '天 气 · 上海', '标题应取旧 city 字段');
  return '向后兼容，不白屏';
});

check('天气数据整体失败时显示占位，不抛异常', function () {
  var p = boardPayload();
  p.blocks.weather.data = null;
  p.blocks.weather.ok = false;
  var d = run(p);
  eq(text(d.getElementById('b-clock-0-temp')), '—', '上海温度占位');
  eq(d.getElementById('b-clock-0-ico').className, 'wico wico-na', '图标兜底类别');
  eq(text(d.getElementById('b-weather-title')), '天 气', '标题回退静态文案');
  return '无数据也不白屏';
});

/* ---------------- 主动刷新：右下角大图弹窗 / 服务端 reloadToken ---------------- */

check('每日正文用 .d-line，来源与图注仍是注释小字 .row-s', function () {
  eq(byId('b-daily-quote').className, 'd-line', '引语正文样式');
  eq(byId('b-daily-poem').className, 'd-line', '诗句正文样式');
  eq(byId('b-daily-quote-src').className, 'row-s', '引语出处应保持小字');
  eq(byId('b-daily-poem-src').className, 'row-s', '诗句出处应保持小字');
  eq(byId('b-daily-caption').className, 'row-s', '图注应保持小字');
  return '只放大正文，注释小字字号不变';
});

check('无图时图片隐藏、有图时显示且可点；右下角不放任何操作提示文字', function () {
  eq(byId('b-daily-img').style.display, 'none', '无图时图片应隐藏');
  eq(byId('b-daily-img-hint'), null, '右下角不应再建提示元素');
  var p = boardPayload();
  p.blocks.daily.data.image = { url: '/media/daily.jpg?d=20261113', source: 'Bing 每日一图' };
  var d = run(p);
  eq(d.getElementById('b-daily-img').style.display, 'block', '有图时图片应显示');
  truthy(typeof d.getElementById('b-daily-img').onclick === 'function', '图片没有绑定 DOM0 onclick');
  var all = [];
  (function walk(n) {
    if (n.nodeType === 3) all.push(n.nodeValue);
    else (n.childNodes || []).forEach(walk);
  })(d.root);
  truthy(!/点按查看大图|操作提示|查看大图 \/ 刷新/.test(all.join('')), '页面仍残留操作提示文字');
  return '只保留图片本身作为点按区，无任何提示文案';
});

check('点按右下角图片：弹大图、注册 5 秒定时器、到点整页刷新', function () {
  var p = boardPayload();
  p.blocks.daily.data.image = { url: '/media/daily.jpg?d=20261113', source: 'Bing 每日一图' };
  var d = run(p);
  var img = d.getElementById('b-daily-img');
  var box = d.getElementById('b-lightbox');
  var big = d.getElementById('b-lightbox-img');
  truthy(box && box.style.display === 'none', '弹窗初始应隐藏');
  img.onclick();
  eq(box.style.display, 'block', '弹窗未显示');
  eq(big.src, '/media/daily.jpg?d=20261113', '大图 src 未取原图地址');
  eq(d.__timeouts.length, 1, '未注册 5 秒定时器');
  eq(d.__timeouts[0].ms, 5000, '定时器不是 5 秒');
  eq(d.__reloads(), 0, '点击瞬间不应立即刷新');
  d.__timeouts[0].fn();
  eq(d.__reloads(), 1, '5 秒到点未整页重载');
  return '大图 → 5s → window.location.reload()';
});

check('重复点按不叠加定时器；点弹窗可立即刷新', function () {
  var p = boardPayload();
  p.blocks.daily.data.image = { url: '/media/daily.jpg', source: 'Bing' };
  var d = run(p);
  var img = d.getElementById('b-daily-img');
  img.onclick();
  img.onclick();
  eq(d.__timeouts.length, 1, '重复点按叠加了定时器');
  eq(d.__reloads(), 0, '点图片不应立即刷新');
  d.getElementById('b-lightbox').onclick();
  eq(d.__reloads(), 1, '点弹窗应立即刷新');
  return '可跳过 5 秒等待，且无重复刷新';
});

check('首次加载只记录 reloadToken，绝不自我刷新', function () {
  var p = boardPayload();
  p.server.reloadToken = 'v1';
  var d = run(p);
  eq(d.__reloads(), 0, '首屏不应 reload（否则会无限刷新）');
  return '令牌只在变化时生效';
});

check('token 不变时 5 分钟轮询保持局部刷新', function () {
  var p = boardPayload();
  p.server.reloadToken = 'v1';
  var d = run(p);
  var p2 = boardPayload();
  p2.server.reloadToken = 'v1';
  p2.blocks.weather.data.cities[0].days[0].text = '多云';
  d.__setPayload(p2);
  d.__intervals[1]();
  eq(text(d.getElementById('b-weather-0-text')), '多云', '局部刷新未生效');
  eq(d.__reloads(), 0, 'token 未变不应整页重载');
  return '哑终端行为不变';
});

check('服务端换 reloadToken 后，二次 poll 立即整页重载', function () {
  var p = boardPayload();
  p.server.reloadToken = 'v1';
  var d = run(p);
  var p2 = boardPayload();
  p2.server.reloadToken = 'v2';
  d.__setPayload(p2);
  d.__intervals[1]();
  eq(d.__reloads(), 1, 'token 变化未触发立即重载');
  return '改 data/reload-token → Kindle 5 分钟内自动拿新代码';
});

check('board.js 严格 ES5：无箭头函数 / let / const / fetch / Promise / addEventListener', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'public', 'board.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  ['=>', 'const ', 'let ', 'fetch(', 'Promise', 'addEventListener'].forEach(function (k) {
    eq(src.split(k).length - 1, 0, '出现禁用语法 ' + k);
  });
  return '旧 WebKit 语法安全';
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
