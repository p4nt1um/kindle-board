/* Kindle Board 哑终端前端 —— 严格 ES5，面向 Kindle 5.16.2.1.1 旧 WebKit。
 *
 * 禁用：fetch / Promise / let / const / 箭头函数 / 模板串 / CSS Grid / calc() / addEventListener。
 * 只用：XMLHttpRequest + JSON + DOM 文本节点 diff + setInterval + DOM0 onclick。
 *
 * 设计要点：
 *  1. 骨架只建一次，之后每次刷新只改文本节点（nodeValue）与 className，
 *     不重建 DOM。5 分钟轮询绝不整页 reload，把 e-ink 重绘面积压到最小。
 *     只有两种主动重载：① 点按右下角图片看大图后 5 秒；
 *     ② 服务端 server.reloadToken 变化（运维改代码后下发，Kindle 自动拿新版）。
 *  2. 双时钟不依赖设备本地时区/时间：服务端给 nowUtcMs + 每时区真实偏移，
 *     客户端按「收到数据后经过的分钟数」递增；到 DST 切换点强制重新拉数据。
 *  3. 天气两地数据一次性下发，点击时钟右侧天气热区纯本地切换，
 *     不发新请求、不用 localStorage（本机仅当前会话有效）、不用 touch（不触发）。
 *  4. 请求失败时什么都不动，只在标题栏与各板块状态行标记离线/过期，
 *     并保留上一次成功的内容。
 */

(function () {
  'use strict';

  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  var SHANGHAI_OFFSET = 480;

  /** 线条天气图标的全部笔画，骨架期一次性建好，靠父节点 className 显隐 */
  var WICO_STROKES = [
    ['wk-shape', 'wk-sun-circle'],
    ['wk-line', 'wk-ray-t'], ['wk-line', 'wk-ray-b'],
    ['wk-line', 'wk-ray-l'], ['wk-line', 'wk-ray-r'],
    ['wk-shape', 'wk-cloud-body'], ['wk-shape', 'wk-cloud-puff'],
    ['wk-shape', 'wk-cloud2'],
    ['wk-line', 'wk-drop1'], ['wk-line', 'wk-drop2'], ['wk-line', 'wk-drop3'],
    ['wk-line', 'wk-flake-h1'], ['wk-line', 'wk-flake-v1'],
    ['wk-line', 'wk-flake-h2'], ['wk-line', 'wk-flake-v2'],
    ['wk-line', 'wk-flake-h3'], ['wk-line', 'wk-flake-v3'],
    ['wk-shape', 'wk-fog-cloud'],
    ['wk-line', 'wk-fog1'], ['wk-line', 'wk-fog2'], ['wk-line', 'wk-fog3'],
    ['wk-line', 'wk-bolt1'], ['wk-line', 'wk-bolt2'],
    ['wk-line', 'wk-na']
  ];

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
    lastImgUrl: '',
    weatherCity: '',       // 当前选中的天气地区 key（= clock.data.zones[].id）
    weatherData: null,     // normalizeWeather() 后的 {defaultCity, cities, legacy}
    reloadToken: null,     // 服务端下发；null = 首次尚未记录，变化即整页重载
    reloadTimer: null      // 防止重复注册 5 秒刷新定时器
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

  /* ---------------- 天气：多地区数据、点击切换、线条图标 ---------------- */

  /** 把服务端 DTO 规范化；兼容旧的单城市 DTO（只有 days） */
  function normalizeWeather(data) {
    if (!data) return { defaultCity: '', cities: [], legacy: false };
    if (data.cities && data.cities.length) {
      return {
        defaultCity: data.defaultCity || (data.cities[0] && data.cities[0].key) || '',
        cities: data.cities,
        legacy: false
      };
    }
    if (data.days) {
      var key = (st.zones[0] && st.zones[0].id) || 'shanghai';
      return {
        defaultCity: key,
        cities: [{ key: key, name: data.city || '', days: data.days, ok: true }],
        legacy: true
      };
    }
    return { defaultCity: '', cities: [], legacy: false };
  }

  function cityByKey(d, key) {
    var i;
    if (!d || !d.cities) return null;
    for (i = 0; i < d.cities.length; i++) {
      if (d.cities[i].key === key) return d.cities[i];
    }
    return null;
  }

  /** 骨架期一次性预建全部图标笔画；之后只切父节点 className，不重建 DOM */
  function buildWico(parent) {
    var i;
    for (i = 0; i < WICO_STROKES.length; i++) {
      mk(parent, 'div', WICO_STROKES[i][0] + ' ' + WICO_STROKES[i][1], null);
    }
  }

  /** 闭包工厂：避免 var 循环索引陷阱；点击时按索引读当前 zones，zones 变化也能对上 */
  function makeWxClick(idx) {
    return function () {
      if (st.zones[idx]) selectCity(st.zones[idx].id);
    };
  }

  function selectCity(key) {
    if (!key || !st.weatherData || !st.weatherData.cities.length) return;
    if (!cityByKey(st.weatherData, key)) return;
    st.weatherCity = key;
    syncWeatherView();
  }

  /** 5 日预报列 + 天气板块标题；只改文本节点 */
  function renderWeather() {
    var d = st.weatherData || { cities: [] };
    var c = cityByKey(d, st.weatherCity) || d.cities[0] || null;
    var days = (c && c.days) || [];
    var i, x, n = st.weatherDays || 5;
    for (i = 0; i < n; i++) {
      x = days[i];
      setText(byId('b-weather-' + i + '-day'), x ? (x.label + ' ' + (x.dateShort || x.date)) : '');
      setText(byId('b-weather-' + i + '-text'), x ? x.text : '');
      setText(byId('b-weather-' + i + '-temp'),
        (x && x.max !== null && x.max !== undefined) ? (x.max + '°/' + x.min + '°') : '');
      setText(byId('b-weather-' + i + '-pop'),
        (x && x.pop !== null && x.pop !== undefined) ? ('降水 ' + x.pop + '%') : '');
    }
    setText(byId('b-weather-title'), (c && c.name) ? ('天 气 · ' + c.name) : '天 气');
  }

  /** 同步视图：校验选中地区、刷新两个时钟的图标/温度/天气文字、切选中框、重画 5 日列 */
  function syncWeatherView() {
    var d = st.weatherData || { defaultCity: '', cities: [], legacy: false };
    var i, z, c, hit, ico, day, hitCls, icoCls;

    // 每次 poll 都保留用户选择：只有当前 key 在新数据里不存在时才回落默认
    if (!cityByKey(d, st.weatherCity)) {
      st.weatherCity = d.defaultCity || ((st.zones[0] && st.zones[0].id) || '');
    }

    for (i = 0; i < 2; i++) {
      z = st.zones[i];
      hit = byId('b-clock-' + i + '-wx');
      ico = byId('b-clock-' + i + '-ico');
      if (!hit) continue;
      c = z ? cityByKey(d, z.id) : null;
      hit.style.display = (d.legacy || !c) ? 'none' : '';
      day = (c && c.days && c.days[0]) ? c.days[0] : null;

      if (ico) {
        icoCls = 'wico wico-' + (day ? (day.category || 'na') : 'na');
        if (ico.className !== icoCls) ico.className = icoCls;
      }
      setText(byId('b-clock-' + i + '-temp'),
        (!c || c.ok === false || !day || day.max === null || day.max === undefined) ?
          '—' : (day.max + '°/' + day.min + '°'));
      setText(byId('b-clock-' + i + '-text'),
        day ? empty(day.text || '', 5) : ((c && c.ok === false) ? '无数据' : ''));

      hitCls = (st.weatherCity && z && z.id === st.weatherCity) ? 'wx-hit wx-on' : 'wx-hit';
      if (hit.className !== hitCls) hit.className = hitCls;
    }
    renderWeather();
  }

  /* ---------------- 骨架构建：与服务端 registry 的 renderer 名一一对应 ---------------- */

  var BUILDERS = {
    clock: function (b) {
      var t = mk(b, 'table', 'fixed', null);
      var tbody = mk(t, 'tbody', null, null);
      var tr = mk(tbody, 'tr', null, null);
      var i, td, inner, innerBody, innerTr, left, right, hit, ico;
      var wxTable, wxBody, wxRow, wxIcoCell, wxTxtCell;
      for (i = 0; i < 2; i++) {
        td = mk(tr, 'td', 'zone', null);
        inner = mk(td, 'table', 'zone-grid', null);
        innerBody = mk(inner, 'tbody', null, null);
        innerTr = mk(innerBody, 'tr', null, null);
        left = mk(innerTr, 'td', 'zone-l', null);
        right = mk(innerTr, 'td', 'zone-r', null);
        mkText(left, 'div', 'zlabel', 'b-clock-' + i + '-label', '');
        mkText(left, 'div', 'big', 'b-clock-' + i + '-time', '--:--');
        mkText(left, 'div', 'zdate', 'b-clock-' + i + '-date', '');
        hit = mk(right, 'div', 'wx-hit', 'b-clock-' + i + '-wx');
        /* 天气热区内部再分两列：左=放大后的图标，右=温度 / 天气文字纵向两行。
           b-* id 全部不变，渲染器仍只改文本节点与 className。 */
        wxTable = mk(hit, 'table', 'wx-grid', null);
        wxBody = mk(wxTable, 'tbody', null, null);
        wxRow = mk(wxBody, 'tr', null, null);
        wxIcoCell = mk(wxRow, 'td', 'wx-ico-cell', null);
        wxTxtCell = mk(wxRow, 'td', 'wx-txt-cell', null);
        ico = mk(wxIcoCell, 'div', 'wico wico-na', 'b-clock-' + i + '-ico');
        buildWico(ico);
        mkText(wxTxtCell, 'div', 'wx-temp', 'b-clock-' + i + '-temp', '');
        mkText(wxTxtCell, 'div', 'wx-text', 'b-clock-' + i + '-text', '');
        hit.onclick = makeWxClick(i);
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
      mkText(left, 'div', 'd-line', 'b-daily-quote', '');
      mkText(left, 'div', 'row-s', 'b-daily-quote-src', '');
      mkText(left, 'div', 'd-line', 'b-daily-poem', '');
      mkText(left, 'div', 'row-s', 'b-daily-poem-src', '');
      mkText(left, 'div', 'row-s', 'b-daily-caption', '');
      var img = mk(right, 'img', '', 'b-daily-img');
      img.alt = '';
      img.style.display = 'none';
      img.onerror = function () { img.style.display = 'none'; };
      // 右下角图片 = 刷新点按区：先弹大图，5 秒后整页重载拿新代码。
      // 缩略图不带边框（用户要求），点按仍弹大图；下方不放任何操作提示文字。
      img.onclick = function () {
        if (img.style.display === 'none') return;
        showBigImage(img.src);
        scheduleReload(5000);
      };
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

  /** 提示行：没有真实提示时整行隐藏（连行高都不占），异常/空状态才显示 */
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
      syncWeatherView();   // zones 就绪后刷新两侧天气热区（weatherData 可能还是上一轮缓存）
    },
    weather: function (blk) {
      st.weatherData = normalizeWeather(blk && blk.data);
      syncWeatherView();   // 用最新的两地数据再同步一次
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

  /* ---------------- 主动刷新：右下角图片大图 + 服务端 reloadToken ----------------
     静态资源带 Cache-Control: no-store，WAF 的 config.xml 也关了缓存，
     整页 reload 一定会重新拉到新版 board.js / board.css。
     只用 DOM0 onclick + setTimeout，严格 ES5，旧 WebKit 可用。 */

  function doReload() {
    try { window.location.reload(); }
    catch (e) { window.location.href = window.location.href; }
  }

  /** delayMs=0 立即重载（服务端换 token）；>0 用于「先弹大图看 5 秒」 */
  function scheduleReload(delayMs) {
    // 服务端换 token 是硬指令，即使「看大图」的 5 秒定时器在跑也要立刻重载
    if (!delayMs) { doReload(); return; }
    if (st.reloadTimer !== null) return;
    st.reloadTimer = setTimeout(function () { doReload(); }, delayMs);
  }

  /** 弹窗骨架只建一次，挂在 #board 下用 absolute 盖住整屏 */
  function buildLightbox() {
    var host = byId('board');
    if (!host || byId('b-lightbox')) return;
    var box = mk(host, 'div', 'lb', 'b-lightbox');
    box.style.display = 'none';
    mkText(box, 'div', 'lb-tip', 'b-lightbox-tip', '查看大图 · 5 秒后自动刷新页面');
    var big = mk(box, 'img', 'lb-img', 'b-lightbox-img');
    big.alt = '';
    mkText(box, 'div', 'lb-hint', 'b-lightbox-hint', '点按任意处可立即刷新');
    box.onclick = function () { doReload(); };
  }

  function showBigImage(src) {
    var box = byId('b-lightbox');
    var big = byId('b-lightbox-img');
    if (!box || !big || !src) return;
    big.src = src;
    box.style.display = 'block';
  }

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
    var srv = b.server || {};
    var layout = srv.layout || [];
    var key = [];
    var i;
    var token = srv.reloadToken || '';
    // 首次加载只记录令牌，绝不刷新；此后服务端换令牌就整页重载，自动拿新版 CSS/JS
    if (st.reloadToken === null) {
      st.reloadToken = token;
    } else if (token && token !== st.reloadToken) {
      st.reloadToken = token;
      scheduleReload(0);
      return;
    }
    st.statusMode = srv.statusMode || 'auto';
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
      // 天气标题由 renderWeather() 写「天 气 · 地区」，weather DTO 不带 titleText
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
    buildLightbox();             // 弹窗骨架只建一次，默认隐藏
    poll();
    setInterval(tickClock, 1000);
    setInterval(poll, 300000);   // 每 5 分钟局部刷新；只有 reloadToken 变化才整页重载
  };
})();
