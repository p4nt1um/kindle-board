/* Kindle Board 哑终端前端 —— 严格 ES5，面向 Kindle 5.16.2.1.1 旧 WebKit。
 *
 * 禁用：fetch / Promise / let / const / 箭头函数 / 模板串 / CSS Grid / calc() / addEventListener。
 * 只用：XMLHttpRequest + JSON + DOM 文本节点 diff + setInterval。
 *
 * 设计要点：
 *  1. 骨架只建一次，之后每次刷新只改文本节点（nodeValue），不重建 DOM、不整页 reload，
 *     这能把 e-ink 的重绘面积压到最小。
 *  2. 双时钟不依赖设备本地时区/时间：服务端给 nowUtcMs + 每时区真实偏移，
 *     客户端按「收到数据后经过的分钟数」递增；到 DST 切换点强制重新拉数据。
 *  3. 请求失败时什么都不动，只在标题栏与各板块状态行标记离线/过期，
 *     并保留上一次成功的内容。
 */

(function () {
  'use strict';

  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  var SHANGHAI_OFFSET = 480;
  var st = {
    built: false,
    layoutKey: '',
    receivedAt: 0,
    baseUtcMs: 0,
    nextDstUtc: null,
    zones: [],
    pollMs: 300000,
    offline: false,
    statusMode: 'auto',
    weatherDays: 5,
    quotaRows: 6,
    statusEls: [],
    lastImgUrl: ''
  };

  function byId(id) { return document.getElementById(id); }

  /** 只有文本真的变化时才写 DOM */
  function setText(el, s) {
    if (!el) return;
    var v = (s === undefined || s === null) ? '' : String(s);
    if (el.firstChild && el.firstChild.nodeType === 3) {
      if (el.firstChild.nodeValue !== v) el.firstChild.nodeValue = v;
    } else {
      while (el.firstChild) el.removeChild(el.firstChild);
      el.appendChild(document.createTextNode(v));
    }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function dateStr(localMs) {
    var d = new Date(localMs);
    return pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) + ' 周' + WEEK[d.getUTCDay()];
  }
  function timeStr(localMs) {
    var d = new Date(localMs);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }
  function stamp(localMs) {
    if (!localMs) return '从未';
    var d = new Date(localMs);
    return pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) + ' ' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
  }

  function tzOffset() {
    var i;
    for (i = 0; i < st.zones.length; i++) {
      if (st.zones[i].id === 'shanghai') return st.zones[i].offsetMinutes;
    }
    return SHANGHAI_OFFSET;
  }

  function mk(parent, tag, cls, id) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (id) e.id = id;
    parent.appendChild(e);
    return e;
  }

  function mkText(parent, tag, cls, id, init) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (id) e.id = id;
    e.appendChild(document.createTextNode(init || ''));
    parent.appendChild(e);
    return e;
  }

  /** 一行多列：用 table-layout:fixed 的 table，旧 WebKit 最稳 */
  function grid(parent, specs) {
    var t = mk(parent, 'table', 'fixed', null);
    var tbody = mk(t, 'tbody', null, null);
    var tr = mk(tbody, 'tr', null, null);
    var i, td;
    for (i = 0; i < specs.length; i++) {
      td = mk(tr, 'td', specs[i].cls || '', null);
      mkText(td, 'span', null, specs[i].id, '');
    }
    return t;
  }

  function textRow(parent, id, cls) {
    return mkText(parent, 'div', cls || 'row', id, '');
  }

  /** parent 默认为 #blocks；双栏布局时传入对应列的 td，保持 b-* id 完全不变 */
  function shell(meta, parent) {
    var d = mk(parent || byId('blocks'), 'div', 'block', 'b-' + meta.id);
    // 不再写死 height：板块由内容自然撑开、顺着往下排；meta.rows 仅用于名义预算与骨架 key
    var t = mk(d, 'div', 'bt', null);
    mkText(t, 'span', 'bt-l', 'b-' + meta.id + '-title', meta.title);
    var s = mkText(t, 'span', 'bt-s', 'b-' + meta.id + '-status', '等待数据');
    st.statusEls.push(s);
    return mk(d, 'div', 'bc', null);
  }

  /* ---------------- 骨架构建：与服务端 registry 的 renderer 名一一对应 ---------------- */

  var BUILDERS = {
    clock: function (b) {
      var t = mk(b, 'table', 'fixed', null);
      var tbody = mk(t, 'tbody', null, null);
      var tr = mk(tbody, 'tr', null, null);
      var i, td;
      for (i = 0; i < 2; i++) {
        td = mk(tr, 'td', 'zone', null);
        mkText(td, 'div', 'zlabel', 'b-clock-' + i + '-label', '');
        mkText(td, 'div', 'big', 'b-clock-' + i + '-time', '--:--');
        mkText(td, 'div', 'zdate', 'b-clock-' + i + '-date', '');
      }
    },
    /* 横向 N 天 × 每天 4 行纵排；列数由服务端 weatherDays 下发，td 自动均分 */
    weather: function (b) {
      var t = mk(b, 'table', 'w5', null);
      var tbody = mk(t, 'tbody', null, null);
      var tr = mk(tbody, 'tr', null, null);
      var i, td, n = st.weatherDays || 5;
      for (i = 0; i < n; i++) {
        td = mk(tr, 'td', i === 0 ? 'first' : '', null);
        mkText(td, 'div', 'w5-line w5-day', 'b-weather-' + i + '-day', '');
        mkText(td, 'div', 'w5-line w5-text', 'b-weather-' + i + '-text', '');
        mkText(td, 'div', 'w5-line w5-temp', 'b-weather-' + i + '-temp', '');
        mkText(td, 'div', 'w5-line w5-pop', 'b-weather-' + i + '-pop', '');
      }
    },
    agenda: function (b) {
      var i, h, row;
      for (i = 0; i < 5; i++) {
        row = mk(b, 'div', 'a-item', 'b-agenda-' + i + '-row');
        grid(row, [
          { cls: 'a-day', id: 'b-agenda-' + i + '-day' },
          { cls: 'a-time', id: 'b-agenda-' + i + '-time' },
          { cls: 'cell-tag a-tag', id: 'b-agenda-' + i + '-tag' }
        ]);
        mkText(row, 'div', 'a-title', 'b-agenda-' + i + '-title', '');
        row.style.display = 'none';   // 空槽不占位，实现自然流式排版
      }
      h = textRow(b, 'b-agenda-hint', 'row-s');
      h.style.display = 'none';   // 只在有真实提示时显示
    },
    quota: function (b) {
      var i, row, sub, n = st.quotaRows || 6;
      for (i = 0; i < n; i++) {
        row = mk(b, 'div', 'p-item', 'b-quota-' + i + '-row');
        grid(row, [
          { cls: 'p-name', id: 'b-quota-' + i + '-name' },
          { cls: 'p-value', id: 'b-quota-' + i + '-value' }
        ]);
        // 每行的「下一行」小字（如 GLM 下次重置），默认隐藏，有内容才展开
        sub = mkText(row, 'div', 'p-sub', 'b-quota-' + i + '-sub', '');
        sub.style.display = 'none';
        row.style.display = 'none';
      }
      textRow(b, 'b-quota-hint', 'row-s').style.display = 'none';
    },
    daily: function (b) {
      var t = mk(b, 'table', 'fixed', null);
      var tbody = mk(t, 'tbody', null, null);
      var tr = mk(tbody, 'tr', null, null);
      var left = mk(tr, 'td', '', null);
      var right = mk(tr, 'td', '', null);
      right.style.width = '156px';
      mkText(left, 'div', 'row', 'b-daily-quote', '');
      mkText(left, 'div', 'row-s', 'b-daily-quote-src', '');
      mkText(left, 'div', 'row', 'b-daily-poem', '');
      mkText(left, 'div', 'row-s', 'b-daily-poem-src', '');
      mkText(left, 'div', 'row-s', 'b-daily-caption', '');
      var img = mk(right, 'img', '', 'b-daily-img');
      img.alt = '';
      img.style.display = 'none';
      img.onerror = function () { img.style.display = 'none'; };
    },
    generic: function (b) {
      var i, r;
      for (i = 0; i < 5; i++) {
        r = textRow(b, 'b-generic-' + i, 'row-s');
        r.style.display = 'none';
      }
    }
  };

  /* ---------------- 纯展示渲染器：只吃 DTO，不碰网络、不算时区 ---------------- */

  /* statusMode:
       auto   = 正常时留白，只有过期/失败才提示并带「上次成功时间」（默认，也是需求原意）
       always = 每板块常显「更新 MM/DD HH:MM」
       never  = 完全不显示（异常也不提示，不推荐）
     无论哪种模式，异常时都保证「最后成功更新时间」可见。 */
  function statusText(blk, mode) {
    if (!blk) return '! 无数据';
    var local = blk.updatedAt ? blk.updatedAt + tzOffset() * 60000 : 0;
    var t = stamp(local);
    if (blk.stale) return mode === 'never' ? '! 过期' : '! 过期 上次 ' + t;
    if (!blk.ok) return mode === 'never' ? '! 失败' : '! 失败 上次 ' + t;
    return mode === 'always' ? '更新 ' + t : '';
  }

  function empty(s, n) {
    var v = (s === undefined || s === null) ? '' : String(s);
    return v.length > n ? v.slice(0, n - 1) + '…' : v;
  }

  /** 列表行按需显示：没有数据的槽位整行隐藏，板块才能顺着内容自然收缩 */
  function showRow(id, on) {
    var el = byId(id);
    if (el) el.style.display = on ? '' : 'none';
  }

  /** 提示行：没有真实提示时整行隐藏（连 14px 高度都不占），异常/空状态才显示 */
  function setHint(id, text) {
    var el = byId(id);
    if (!el) return;
    var v = empty(text || '', 70);
    setText(el, v);
    el.style.display = v ? '' : 'none';
  }

  var RENDERERS = {
    clock: function (blk) {
      if (!blk || !blk.data || !blk.data.zones) return;
      st.zones = blk.data.zones;
      var i, z;
      for (i = 0; i < 2; i++) {
        z = st.zones[i];
        if (!z) continue;
        setText(byId('b-clock-' + i + '-label'), z.label + (z.isDst ? '  [夏令时]' : '  [标准时]'));
      }
      tickClock();
    },
    weather: function (blk) {
      var d = blk && blk.data;
      var days = (d && d.days) || [];
      var i, x, n = st.weatherDays || 5;
      for (i = 0; i < n; i++) {
        x = days[i];
        setText(byId('b-weather-' + i + '-day'), x ? (x.label + ' ' + (x.dateShort || x.date)) : '');
        setText(byId('b-weather-' + i + '-text'), x ? x.text : '');
        setText(byId('b-weather-' + i + '-temp'), x && x.max !== null ? (x.max + '°/' + x.min + '°') : '');
        setText(byId('b-weather-' + i + '-pop'), x && x.pop !== null ? ('降水 ' + x.pop + '%') : '');
      }
    },
    agenda: function (blk) {
      var d = blk && blk.data;
      var items = (d && d.items) || [];
      var i, x, row, title, rowCls, titleCls;
      for (i = 0; i < 5; i++) {
        x = items[i];
        showRow('b-agenda-' + i + '-row', !!x);
        setText(byId('b-agenda-' + i + '-day'), x ? x.dayLabel : '');
        setText(byId('b-agenda-' + i + '-time'), x ? x.timeLabel : '');
        setText(byId('b-agenda-' + i + '-tag'), x ? (x.tag || '') : '');
        // 当天日程（含进行中 / 跨天全天）整条加粗放大；只改 className，不重建 DOM
        row = byId('b-agenda-' + i + '-row');
        title = byId('b-agenda-' + i + '-title');
        rowCls = (x && x.today) ? 'a-item a-item-today' : 'a-item';
        titleCls = (x && x.today) ? 'a-title a-title-today' : 'a-title';
        if (row && row.className !== rowCls) row.className = rowCls;
        if (title && title.className !== titleCls) title.className = titleCls;
        // 双栏后左栏约 348px，单行可容纳字数比整宽版少，超长由 CSS 裁切
        setText(title, x ? empty('   ' + x.title + (x.location ? ' @' + x.location : ''), 28) : '');
      }
      // 只显示真实提示（未配置凭据 / 最近没有日程），不再显示说明性的 note
      setHint('b-agenda-hint', d ? (d.hint || '') : '');
    },
    quota: function (blk) {
      var d = blk && blk.data;
      var list = (d && d.providers) || [];
      var i, p, row, sub, subText, rowCls, n = st.quotaRows || 6;
      for (i = 0; i < n; i++) {
        p = list[i];
        showRow('b-quota-' + i + '-row', !!p);
        setText(byId('b-quota-' + i + '-name'), p ? p.label : '');
        setText(byId('b-quota-' + i + '-value'), p ?
          (p.ok ? empty((p.lines || []).join(' · '), 22) : empty('— ' + p.error, 22)) : '');
        // 条件格式：金额低于阈值由服务端判好下发，这里只切 className、不重建 DOM
        row = byId('b-quota-' + i + '-row');
        rowCls = (p && p.low) ? 'p-item p-item-low' : 'p-item';
        if (row && row.className !== rowCls) row.className = rowCls;
        // 「下次重置」小字紧跟在该 provider 余额行的下一行，不再统一放板块底部
        sub = byId('b-quota-' + i + '-sub');
        subText = (p && p.resetText) ? ('下次重置 ' + p.resetText) : '';
        if (sub) {
          setText(sub, subText);
          sub.style.display = subText ? '' : 'none';
        }
      }
      setHint('b-quota-hint', d ? (d.note || '') : '');
    },
    daily: function (blk) {
      var d = blk && blk.data;
      if (!d) return;
      setText(byId('b-daily-quote'), empty('「' + (d.quote ? d.quote.text : '') + '」', 30));
      setText(byId('b-daily-quote-src'), empty('— ' + (d.quote ? d.quote.source : ''), 40));
      setText(byId('b-daily-poem'), empty(d.poem ? d.poem.text : '', 30));
      setText(byId('b-daily-poem-src'), empty('— ' + (d.poem ? d.poem.source : ''), 40));
      var img = byId('b-daily-img');
      var cap = d.image ? (d.image.caption ? '图：' + d.image.caption : ('图：' + (d.image.source || ''))) : '图：暂无';
      setText(byId('b-daily-caption'), empty(cap, 40));
      if (d.image && d.image.url) {
        if (st.lastImgUrl !== d.image.url) {
          st.lastImgUrl = d.image.url;
          img.src = d.image.url;   // 同源 /media/，不碰公网 HTTPS
        }
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
      }
    },
    generic: function (blk) {
      var d = (blk && blk.data) || {};
      var keys = Object.keys(d);
      var i;
      for (i = 0; i < 5; i++) {
        var k = keys[i];
        showRow('b-generic-' + i, !!k);
        setText(byId('b-generic-' + i), k ? (k + ': ' + empty(String(d[k]), 50)) : '');
      }
    }
  };

  /* ---------------- 数据流 ---------------- */

  /** 只有「日程 + AI 额度」相邻时才并排；否则退回原来的线性流式排版 */
  function isDuo(a, b) {
    if (!a || !b) return false;
    var pair = a.id + '|' + b.id;
    return pair === 'agenda|quota' || pair === 'quota|agenda';
  }

  function mount(meta, parent) {
    var body = shell(meta, parent);
    var builder = BUILDERS[meta.renderer] || BUILDERS.generic;
    builder(body);
  }

  function buildSkeleton(layout) {
    var host = byId('blocks');
    while (host.firstChild) host.removeChild(host.firstChild);
    st.statusEls = [];
    var i, meta, t, tbody, tr, left, right;
    for (i = 0; i < layout.length; i++) {
      meta = layout[i];
      if (isDuo(meta, layout[i + 1])) {
        // 旧 WebKit 没有 Grid / Flex，双栏用 table-layout:fixed 的两个 td 最稳；
        // 两个板块仍各自走 shell()，b-* id 完全不变，渲染器无需知道布局变化。
        t = mk(host, 'table', 'duo', 'b-duo');
        tbody = mk(t, 'tbody', null, null);
        tr = mk(tbody, 'tr', null, null);
        left = mk(tr, 'td', 'duo-l', null);
        right = mk(tr, 'td', 'duo-r', null);
        left.style.width = '58%';
        right.style.width = '42%';
        mount(meta, left);
        i++;
        mount(layout[i], right);
        continue;
      }
      mount(meta, host);
    }
    st.built = true;
  }

  function applyBoard(b) {
    var layout = (b.server && b.server.layout) || [];
    var key = [];
    var i;
    st.statusMode = (b.server && b.server.statusMode) || 'auto';
    st.weatherDays = (b.server && b.server.weatherDays) || 5;
    st.quotaRows = (b.server && b.server.quotaRows) || 6;
    for (i = 0; i < layout.length; i++) key.push(layout[i].id + ':' + layout[i].rows + ':' + layout[i].renderer);
    key.push('wd' + st.weatherDays);   // 天数变了要重建天气列骨架
    key.push('qr' + st.quotaRows);     // provider 数量变了要重建额度行骨架
    if (!st.built || key.join('|') !== st.layoutKey) {
      st.layoutKey = key.join('|');
      buildSkeleton(layout);
    }

    st.receivedAt = Date.now();
    st.baseUtcMs = b.nowUtcMs || Date.now();
    st.nextDstUtc = b.nextDstTransitionUtc || null;
    st.pollMs = b.browserPollMs || 300000;
    st.offline = false;

    for (i = 0; i < layout.length; i++) {
      var meta = layout[i];
      var blk = b.blocks[meta.id];
      var fn = RENDERERS[meta.renderer] || RENDERERS.generic;
      fn(blk);
      // 板块可自带动态标题（时钟标题行显示公历 + 农历）；没有就保留注册表的静态标题
      if (blk && blk.data && blk.data.titleText) {
        setText(byId('b-' + meta.id + '-title'), blk.data.titleText);
      }
      setText(byId('b-' + meta.id + '-status'), statusText(blk, st.statusMode));
    }

    var shanghai = st.baseUtcMs + tzOffset() * 60000;
    setText(byId('h-status'), '已同步 ' + stamp(shanghai) + '  ·  每 ' +
      Math.round(st.pollMs / 60000) + ' 分钟');
    tickClock();
  }

  function setOffline(msg) {
    st.offline = true;
    setText(byId('h-status'), '! 离线 · ' + msg + ' · 显示缓存内容');
    // 各板块状态行也标离线，但内容一个字都不动（保留当前内容）
    var i, s, v;
    for (i = 0; i < st.statusEls.length; i++) {
      s = st.statusEls[i];
      v = (s.firstChild && s.firstChild.nodeValue) || '';
      if (v.indexOf('! ') !== 0) setText(s, v ? ('! 离线 · ' + v) : '! 离线');
    }
  }

  function poll() {
    var xhr;
    try { xhr = new XMLHttpRequest(); }
    catch (e) { setOffline('浏览器不支持 XHR'); return; }

    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 200) {
        try { applyBoard(JSON.parse(xhr.responseText)); }
        catch (e) { setOffline('数据解析失败'); }
      } else {
        setOffline('服务不可达 ' + xhr.status);
      }
    };
    try {
      xhr.open('GET', '/api/board.json?t=' + Date.now(), true);
      xhr.send(null);
    } catch (e) {
      setOffline('请求异常');
    }
  }

  /** 每秒检查，但只有跨分钟/内容变化才改文本节点；DST 切换点强制重新同步 */
  function tickClock() {
    if (!st.baseUtcMs || !st.zones.length) return;
    var elapsed = Date.now() - st.receivedAt;
    var mins = Math.floor(elapsed / 60000);
    if (mins < 0) mins = 0;
    var i, z, localMs;
    for (i = 0; i < st.zones.length && i < 2; i++) {
      z = st.zones[i];
      localMs = st.baseUtcMs + mins * 60000 + z.offsetMinutes * 60000;
      setText(byId('b-clock-' + i + '-time'), timeStr(localMs));
      setText(byId('b-clock-' + i + '-date'), dateStr(localMs));
    }
    if (st.nextDstUtc && st.baseUtcMs + elapsed >= st.nextDstUtc - 60000) {
      st.nextDstUtc = null;
      poll();
    }
  }

  window.onload = function () {
    poll();
    setInterval(tickClock, 1000);
    setInterval(poll, 300000);   // 每 5 分钟局部刷新，绝不 location.reload()
  };
})();
