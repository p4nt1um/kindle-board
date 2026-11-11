'use strict';

/**
 * 日程板块：飞书 CalDAV（Basic Auth，凭据只在 PC 侧）。
 *
 * 要点：
 *  - 不设固定天数范围：REPORT 用一个很宽的 time-range（默认过去 2 天 ~ 未来 10 年），
 *    再在本地按「最近 5 条」截取；这样 3 个月后的会议也能进榜，只要它是最近的 5 条之一。
 *  - 进行中日程：排序键用 now 而不是 start，保证不会被未来事件挤掉。
 *  - 全天日程：VALUE=DATE 按配置时区解释，显示「全天」。
 *  - RRULE：支持 DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL/COUNT/UNTIL/BYDAY，
 *    单事件最多展开 200 个实例，避免恶意/异常规则拖死服务。
 *  - 凭据缺失时返回 configured:false + 提示，不占用网络失败通道。
 *  - 参考 ESP32《飞书日程CalDAV相关逻辑》§5 加固：HTTP 200 但响应不是 DAV multistatus、
 *    multiget 没给 calendar-data、ICS 解析不到 VEVENT 都判为失败（走 stale 保留旧数据），
 *    绝不把异常响应当成「空日历」静默清空；全天事件按配置时区换算当地午夜；跳过取消事件。
 *  - 可选 queryTimeRange：日历很大时让服务端按 UTC 窗口先过滤 href，避免 maxHrefs 截断漏掉最近日程；
 *    默认关闭，保持已跑通的请求体不变。
 */

var http = require('../http-util');
var urlLib = require('url');
var secrets = require('../secrets');
var clock = require('./clock');

var discoveredUrl = null;
var discoveredSig = '';
var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
var DAY_MS = 86400000;

function pad(n) { return (n < 10 ? '0' : '') + n; }

function safeHost(u) {
  try { return urlLib.parse(u).host || '(host)'; } catch (e) { return '(host)'; }
}

function unique(arr) {
  var seen = {}, out = [], i;
  for (i = 0; i < arr.length; i++) {
    if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
  }
  return out;
}

/** 用户从飞书桌面端复制的常是纯域名（如 caldav.feishu.cn），没有 scheme，必须补上 */
function normalizeUrl(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s.replace(/\/+$/, '') + '/';
}

function icalUtc(d) {
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}

function basicHeader(ctx) {
  return 'Basic ' + Buffer.from(
    ctx.secrets.get('caldavUser') + ':' + ctx.secrets.get('caldavPass')
  ).toString('base64');
}

function propfind(ctx, url, depth, body) {
  return http.request('PROPFIND', url, {
    headers: {
      Authorization: basicHeader(ctx),
      Depth: String(depth),
      'Content-Type': 'application/xml; charset=utf-8'
    },
    body: body,
    timeoutMs: 12000,
    maxBytes: 2 * 1024 * 1024
  }).then(function (r) {
    var xml = r.body.toString('utf8');
    if (ctx.trace) ctx.trace.push({
      step: 'PROPFIND depth=' + depth, host: safeHost(url), status: r.status,
      bytes: xml.length,
      responses: (xml.match(/<[^>]*response[ >]/gi) || []).length,
      hrefs: (xml.match(/<[^>]*href[ >]/gi) || []).length,
      hasPrincipal: /current-user-principal/i.test(xml),
      hasHomeSet: /calendar-home-set/i.test(xml),
      hasCalendarType: /<[^>]*calendar\s*\/?\s*>/i.test(xml)
    });
    return xml;
  }, function (e) {
    if (ctx.trace) ctx.trace.push({ step: 'PROPFIND depth=' + depth, host: safeHost(url), status: 'ERR ' + http.errText(e) });
    console.warn('[agenda] PROPFIND ' + safeHost(url) + ' 失败: ' + http.errText(e));
    throw e;
  });
}

function firstHref(xml, anchorRe) {
  var block;
  if (anchorRe) {
    var m = xml.match(anchorRe);
    block = m ? m[0] : '';
  } else {
    block = xml;
  }
  var h = block.match(/<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href[^>]*>/i);
  return h ? h[1].trim() : null;
}

function absolute(base, href) {
  if (!href) return null;
  return urlLib.resolve(base, href.replace(/&amp;/g, '&'));
}

/** CalDAV 发现链：principal -> calendar-home-set -> 第一个 calendar collection */
function discover(ctx) {
  // 凭据变过就重新发现（例如用户刚填完 CalDAV URL）
  var sig = ctx.secrets.signature ? ctx.secrets.signature() : '';
  if (discoveredUrl && sig === discoveredSig) return Promise.resolve(discoveredUrl);
  discoveredSig = sig;
  discoveredUrl = null;

  var base = normalizeUrl(ctx.secrets.get('caldavUrl') || ctx.cfg.blocks.agenda.endpoint);
  var u = urlLib.parse(base);
  var looksLikeCalendar = u.pathname && u.pathname !== '/' &&
    /\/calendars?\/[^\/]+|\/dav\/[^\/]+|\/calendar\/[^\/]+/i.test(u.pathname);
  console.log('[agenda] CalDAV base=' + safeHost(base) + ' 显式日历路径=' + !!looksLikeCalendar);
  if (looksLikeCalendar) {
    discoveredUrl = base;
    return Promise.resolve(base);
  }

  var principalProps = '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
  var homeProps = '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    '<d:prop><c:calendar-home-set/></d:prop></d:propfind>';
  var listProps = '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    '<d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>';

  return propfind(ctx, base, 0, principalProps).then(function (xml) {
    var p = absolute(base, firstHref(xml, /<[^>]*current-user-principal[^>]*>[\s\S]*?<\/[^>]*current-user-principal[^>]*>/i));
    return p || base;
  }).then(function (principalUrl) {
    return propfind(ctx, principalUrl, 0, homeProps).then(function (xml) {
      return absolute(principalUrl, firstHref(xml, /<[^>]*calendar-home-set[^>]*>[\s\S]*?<\/[^>]*calendar-home-set[^>]*>/i)) || principalUrl;
    });
  }).then(function (homeUrl) {
    return propfind(ctx, homeUrl, 1, listProps).then(function (xml) {
      var responses = xml.split(/<[^>]*response[^>]*>/i).slice(1);
      var i, href, cal;
      for (i = 0; i < responses.length; i++) {
        cal = /<[^>]*calendar\s*\/?\s*>/i.test(responses[i]) ||
          /urn:ietf:params:xml:ns:caldav[^>]*>[\s\S]{0,40}calendar/i.test(responses[i]);
        if (!cal) continue;
        href = absolute(homeUrl, firstHref(responses[i]));
        if (href && href !== homeUrl) return href;
      }
      return homeUrl;
    });
  }).then(function (url) {
    discoveredUrl = url;
    return url;
  }).catch(function (e) {
    // 发现链失败不致命：很多服务允许直接对根 URL 做 REPORT
    if (ctx.trace) ctx.trace.push({ step: 'discover fallback', reason: http.errText(e), fallback: safeHost(base) });
    discoveredUrl = base;
    return base;
  });
}

/**
 * 飞书 CalDAV 兼容关键（2026-11-09 真机实测）：
 *   calendar-query 请求 <calendar-data/> 会返回 404 propstat（只有 getetag 200），
 *   换 comp 子元素、嵌套 VEVENT、去掉 time-range 都无效；
 *   必须用标准 calendar-multiget 带 href 才返回 ICS 正文（实测 16 个 VEVENT，全 200）。
 * 因此统一走两步法：query 拿 href 列表 → multiget 拿 ICS → 本地按时间窗展开/排序。
 * 服务端不做 time-range 过滤，正好满足「不设固定天数范围」，只用 maxHrefs 防止拉爆。
 */
function caldavReport(ctx, calendarUrl, label, body) {
  return http.request('REPORT', calendarUrl, {
    headers: {
      Authorization: basicHeader(ctx),
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8'
    },
    body: body,
    timeoutMs: 15000,
    maxBytes: 8 * 1024 * 1024
  }).then(function (r) {
    var xml = r.body.toString('utf8');
    if (ctx.trace) ctx.trace.push({
      step: label, host: safeHost(calendarUrl), status: r.status,
      bytes: xml.length,
      responses: (xml.match(/<[^>]*response[ >]/gi) || []).length,
      calendarData: (xml.match(/<[^>]*calendar-data[^>]*>/gi) || []).length,
      vevents: (xml.match(/BEGIN:VEVENT/g) || []).length,
      statuses: unique((xml.match(/<[^>]*status[^>]*>\s*[^<]+/gi) || [])
        .map(function (s) { return s.replace(/^[^>]*>/, '').trim(); }))
    });
    return xml;
  }, function (e) {
    if (ctx.trace) ctx.trace.push({ step: label, host: safeHost(calendarUrl), status: 'ERR ' + http.errText(e) });
    console.warn('[agenda] ' + label + ' @ ' + safeHost(calendarUrl) + ' 失败: ' + http.errText(e));
    throw e;
  });
}

/**
 * 可选的 time-range（默认关闭）：参考 ESP32 项目实测，飞书支持按 UTC 窗口过滤 href。
 * 日历事件很多时能把 query 响应压到 maxHrefs 以下，避免截断漏掉「最近 5 条」。
 * 默认不加任何 filter 子元素，保持与已跑通的生产路径完全一致；
 * 开窗需把 config.blocks.agenda.queryTimeRange 置 true（该分支未在飞书生产路径验证）。
 */
function reportQuery(ctx, calendarUrl, fromUtc, toUtc) {
  var c = ctx.cfg.blocks.agenda;
  var range = c.queryTimeRange
    ? '<C:time-range start="' + fromUtc + '" end="' + toUtc + '"/>'
    : '';
  var body = '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    '<D:prop><D:getetag/></D:prop>' +
    '<C:filter><C:comp-filter name="VCALENDAR">' +
    '<C:comp-filter name="VEVENT">' + range + '</C:comp-filter></C:comp-filter></C:filter>' +
    '</C:calendar-query>';
  return caldavReport(ctx, calendarUrl, 'REPORT query(hrefs)', body);
}

/**
 * HTTP 200 ≠ 业务成功。飞书异常时可能返回 200 + HTML 错误页 / 非 multistatus 响应。
 * 若不判失败，fetch 会返回 items:[]，aggregator 把它当成功写进 data，
 * 于是「失败保留旧数据」被绕过，日程被静默清空（ESP32 参考文档 §5 点出的同类风险）。
 * 空 multistatus（0 个 response）是合法的空日历，不判失败。
 */
function assertDavResponse(xml, label) {
  if (!/<[^>]*multistatus[\s>]/i.test(xml)) {
    throw new Error(label + ': 响应不是 DAV multistatus（认证失效或服务端异常）');
  }
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function reportMultiget(ctx, calendarUrl, hrefs) {
  var body = '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    '<D:prop><D:getetag/><C:calendar-data/></D:prop>' +
    hrefs.map(function (h) { return '<D:href>' + escXml(h) + '</D:href>'; }).join('') +
    '</C:calendar-multiget>';
  return caldavReport(ctx, calendarUrl, 'REPORT multiget(ics)', body);
}

function extractHrefs(xml) {
  var out = [], seen = {}, m, h;
  var re = /<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href[^>]*>/gi;
  while ((m = re.exec(xml)) !== null) {
    h = m[1].trim().replace(/&amp;/g, '&');
    if (h && !seen[h]) { seen[h] = 1; out.push(h); }
  }
  return out;
}

/** 飞书把 ICS 换行编码成 &#13;&#10; / &#xA; 这类数字实体，必须还原成真实 CRLF，
 *  否则整份 ICS 是一行，parseEvents 永远找不到 BEGIN:VEVENT。&amp; 放最后解码。 */
function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractIcs(xml) {
  var out = [];
  var re = /<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data[^>]*>/gi;
  var m;
  while ((m = re.exec(xml)) !== null) out.push(decodeXml(m[1]));
  return out;
}

function parseEvents(icsText) {
  var unfolded = icsText.replace(/\r?\n[ \t]/g, '');
  var lines = unfolded.split(/\r?\n/);
  var events = [];
  var cur = null;
  var i, line, idx, left, nameAndParams, value, name, params, p, kv;

  for (i = 0; i < lines.length; i++) {
    line = lines[i];
    if (line === 'BEGIN:VEVENT') { cur = { props: {}, exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    idx = line.indexOf(':');
    if (idx < 0) continue;
    left = line.slice(0, idx);
    value = line.slice(idx + 1);
    nameAndParams = left.split(';');
    name = nameAndParams[0].toUpperCase();
    params = {};
    for (p = 1; p < nameAndParams.length; p++) {
      kv = nameAndParams[p].split('=');
      params[(kv[0] || '').toUpperCase()] = (kv[1] || '').replace(/^"|"$/g, '');
    }
    if (name === 'EXDATE') cur.exdates.push(value);
    else if (name === 'DTSTART' || name === 'DTEND' || name === 'DUE') {
      cur.props[name] = { value: value, params: params };
    } else if (!cur.props[name]) {
      cur.props[name] = value;
    }
  }
  return events;
}

/** 有 TZID 的墙钟时间 -> UTC 毫秒（迭代求偏移，不引入日期库） */
function wallToUtc(y, mo, d, h, mi, s, tz) {
  var guess = Date.UTC(y, mo - 1, d, h, mi, s);
  var off = clock.zoneOffsetMinutes(tz, new Date(guess));
  var k;
  for (k = 0; k < 3; k++) {
    guess = Date.UTC(y, mo - 1, d, h, mi, s) - off * 60000;
    off = clock.zoneOffsetMinutes(tz, new Date(guess));
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - off * 60000;
}

function parseDate(prop, defaultTz) {
  if (!prop) return null;
  var v = String(prop.value).trim();
  var allDay = (prop.params.VALUE || '').toUpperCase() === 'DATE' || /^\d{8}$/.test(v);
  var m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var h = Number(m[4] || 0), mi = Number(m[5] || 0), s = Number(m[6] || 0);
  var tz = prop.params.TZID || defaultTz || 'Asia/Shanghai';

  // 全天事件是「某个本地日」，不是 UTC 午夜。用 Date.UTC(y,mo,d) 会在 UTC− 时区
  // （如 America/New_York）经 fmtLocal 回加负偏移后显示成前一天；按配置时区换算当地午夜才正确。
  if (allDay) return { ms: wallToUtc(y, mo, d, 0, 0, 0, tz), allDay: true };
  if (m[7] === 'Z') return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  return { ms: wallToUtc(y, mo, d, h, mi, s, tz), allDay: false };
}

function addByFreq(ms, freq, interval, allDay) {
  var d = new Date(ms);
  var f = (freq || 'DAILY').toUpperCase();
  var n = interval || 1;
  if (f === 'DAILY') return ms + n * DAY_MS;
  if (f === 'WEEKLY') return ms + n * 7 * DAY_MS;
  if (f === 'MONTHLY') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  if (f === 'YEARLY') return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  if (f === 'HOURLY') return ms + n * 3600000;
  return null;
}

/** 把一条 VEVENT 展开成窗口内的具体实例（含进行中判定所需的窗口起点） */
function expand(evt, fromMs, toMs, defaultTz) {
  var pr = evt.props;
  // 取消的事件不占位（参考 ESP32 项目 §4「跳过标记为取消的事件」）；大小写不敏感更稳妥
  if (!pr.DTSTART || String(pr.STATUS || '').toUpperCase() === 'CANCELLED') return [];
  var s = parseDate(pr.DTSTART, defaultTz);
  if (!s) return [];
  var e = parseDate(pr.DTEND, defaultTz);
  var duration;
  if (e) duration = Math.max(0, e.ms - s.ms);
  else duration = s.allDay ? DAY_MS : 3600000;
  if (duration === 0 && s.allDay) duration = DAY_MS;

  var title = String(pr.SUMMARY || '(无标题)').replace(/\\n/g, ' ').replace(/\\,/g, ',');
  var location = String(pr.LOCATION || '').replace(/\\n/g, ' ').replace(/\\,/g, ',');
  var rule = String(pr.RRULE || '');
  var out = [];
  var ex = {};
  var i, t;

  for (i = 0; i < evt.exdates.length; i++) {
    var ed = parseDate({ value: evt.exdates[i], params: pr.DTSTART.params }, defaultTz);
    if (ed) ex[ed.ms] = 1;
  }

  function push(startMs) {
    if (ex[startMs]) return;
    var end = startMs + duration;
    if (end <= fromMs || startMs >= toMs) return;  // 进行中的 end > fromMs 会保留
    out.push({
      title: title, location: location,
      startMs: startMs, endMs: end, allDay: s.allDay,
      recurring: !!rule
    });
  }

  if (!rule) { push(s.ms); return out; }

  var opt = {};
  rule.split(';').forEach(function (kv) {
    var a = kv.split('=');
    opt[(a[0] || '').toUpperCase()] = a[1];
  });
  var freq = opt.FREQ || 'DAILY';
  var interval = Math.max(1, parseInt(opt.INTERVAL, 10) || 1);
  var count = parseInt(opt.COUNT, 10) || 0;
  var until = opt.UNTIL ? parseDate({ value: opt.UNTIL, params: {} }, defaultTz) : null;
  var untilMs = until ? until.ms : Infinity;
  var byDay = opt.BYDAY ? opt.BYDAY.split(',') : null;
  var cap = 200;
  var emitted = 0;
  var cursor = s.ms;
  var guard = 0;

  // 起点距窗口很远时先快进，避免从 1970 年开始逐条迭代
  if (cursor < fromMs - 400 * DAY_MS) {
    var approxStep = freq === 'YEARLY' ? 365 : freq === 'MONTHLY' ? 30 : freq === 'WEEKLY' ? 7 : 1;
    var skip = Math.floor((fromMs - cursor) / (approxStep * DAY_MS * interval)) - 2;
    if (skip > 0) {
      cursor = addByFreq(cursor, freq, interval * skip, s.allDay) || cursor;
      if (cursor < s.ms) cursor = s.ms;
    }
  }

  while (cursor < toMs && guard < 400 && emitted < cap) {
    guard++;
    if (cursor > untilMs) break;
    var include = true;
    if (byDay) {
      var wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(cursor).getUTCDay()];
      include = byDay.some(function (b) { return b.slice(-2) === wd; });
    }
    if (include && cursor >= s.ms) {
      if (cursor + duration > fromMs) {
        push(cursor);
        emitted++;
      }
    }
    if (count && emitted >= count) break;
    var next = addByFreq(cursor, freq, interval, s.allDay);
    if (next === null || next <= cursor) break;
    cursor = next;
  }
  return out;
}

function fmtLocal(ms, tz) {
  var off = clock.zoneOffsetMinutes(tz, new Date(ms));
  var d = new Date(ms + off * 60000);
  return {
    date: (d.getUTCMonth() + 1) + '/' + d.getUTCDate(),
    weekday: WEEKDAYS[d.getUTCDay()],
    time: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()),
    dayKey: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
  };
}

module.exports = function fetch(ctx) {
  var c = ctx.cfg.blocks.agenda;
  if (!c.enabled) return Promise.resolve({ disabled: true, items: [] });
  if (!ctx.secrets.has(['caldavUser', 'caldavPass'])) {
    return Promise.resolve({
      configured: false, items: [],
      hint: '未配置飞书 CalDAV 凭据，见 README 第 4 节（环境变量或 secrets.local.json）'
    });
  }

  var now = Date.now();
  var from = new Date(now - (c.rangePastDays || 2) * DAY_MS);
  var to = new Date(now + (c.rangeFutureDays || 3650) * DAY_MS);
  var tz = c.timeZone || 'Asia/Shanghai';

  var calendarUrl = null;
  var multigetHrefs = 0;
  return discover(ctx).then(function (url) {
    calendarUrl = url;
    return reportQuery(ctx, url, icalUtc(from), icalUtc(to));
  }).then(function (xml) {
    // 200 + HTML 错误页也必须判失败，否则会静默清空日程、绕过 stale 保留旧数据
    assertDavResponse(xml, 'REPORT calendar-query');
    var hrefs = extractHrefs(xml);
    var max = c.maxHrefs || 300;
    if (ctx.trace) ctx.trace.push({
      step: 'hrefs', found: hrefs.length, used: Math.min(hrefs.length, max),
      truncated: hrefs.length > max, queryTimeRange: !!c.queryTimeRange
    });
    if (hrefs.length > max) {
      console.warn('[agenda] query 返回 ' + hrefs.length + ' 个 href，超过 maxHrefs=' + max +
        '，仅取前 ' + max + ' 个；可能漏掉最近日程，建议调大 maxHrefs 或开启 blocks.agenda.queryTimeRange');
    }
    if (!hrefs.length) return '';    // 合法空日历
    multigetHrefs = Math.min(hrefs.length, max);
    return reportMultiget(ctx, calendarUrl, hrefs.slice(0, max));
  }).then(function (xml) {
    var icsList = multigetHrefs ? extractIcs(xml) : [];
    if (multigetHrefs) {
      assertDavResponse(xml, 'REPORT calendar-multiget');
      if (!icsList.length) {
        throw new Error('REPORT multiget: ' + multigetHrefs + ' 个 href 未返回任何 calendar-data');
      }
    }
    var all = [];
    var i, j, ev, occ, rawEvents = 0;
    for (i = 0; i < icsList.length; i++) {
      ev = parseEvents(icsList[i]);
      rawEvents += ev.length;
      for (j = 0; j < ev.length; j++) {
        occ = expand(ev[j], from.getTime(), to.getTime(), tz);
        all = all.concat(occ);
      }
    }
    // 有 calendar-data 却解析不出 VEVENT = 编码/格式异常，判失败而不是返回空列表
    if (multigetHrefs && rawEvents === 0) {
      throw new Error('ICS 已返回 ' + icsList.length + ' 份，但解析不到任何 VEVENT（格式或编码可能已变）');
    }
    if (ctx.trace) {
      var s0 = icsList.length ? icsList[0] : '';
      ctx.trace.push({
        step: 'parse', icsFiles: icsList.length, rawEvents: rawEvents, expanded: all.length,
        sample: {
          len: s0.length,
          startsVcal: /^\s*BEGIN:VCALENDAR/i.test(s0),
          hasVevent: /BEGIN:VEVENT/i.test(s0),
          crlf: (s0.match(/\r\n/g) || []).length,
          lf: (s0.match(/\n/g) || []).length,
          numericEntities: (s0.match(/&#\d+;|&#x[0-9a-f]+;/gi) || []).length,
          ampEntities: (s0.match(/&(lt|gt|amp|quot|apos);/gi) || []).length,
          cdata: /CDATA/i.test(s0)
        }
      });
    }

    // 已结束的不再占位；进行中和未来才属于「最近日程」
    // （rangePastDays 仍用于把「开始在过去、现在仍进行中」的长事件展开出来）
    all = all.filter(function (o) { return o.endMs > now; });

    // 进行中排最前（排序键用 now），其余按开始时间；最后截取 maxItems
    all.sort(function (a, b) {
      var ka = (a.startMs <= now && a.endMs > now) ? now : a.startMs;
      var kb = (b.startMs <= now && b.endMs > now) ? now : b.startMs;
      if (ka !== kb) return ka - kb;
      return a.endMs - b.endMs;
    });

    var todayKey = fmtLocal(now, tz).dayKey;   // YYYY-MM-DD，字典序即时间序
    var items = all.slice(0, c.maxItems || 5).map(function (o) {
      var f = fmtLocal(o.startMs, tz);
      var fe = fmtLocal(o.endMs - 1, tz);
      var ongoing = o.startMs <= now && o.endMs > now;
      // 与「今天」这一天有交集就强调：进行中、跨天全天、今天稍后开始的都算；
      // 纯未来事件不强调。前端据此给标题/日期时间换更大的字号。
      var today = f.dayKey <= todayKey && fe.dayKey >= todayKey;
      return {
        title: o.title,
        location: o.location,
        allDay: o.allDay,
        ongoing: ongoing,
        recurring: o.recurring,
        today: today,
        dayLabel: f.date + ' 周' + f.weekday,
        timeLabel: o.allDay
          ? ('全天' + (fe.dayKey !== f.dayKey ? '→' + fe.date : ''))
          : (f.time + (fe.dayKey !== f.dayKey ? '→次日' + fe.time : '→' + fe.time)),
        tag: ongoing ? '进行中' : (o.allDay ? '全天' : (o.recurring ? '重复' : ''))
      };
    });

    return {
      configured: true,
      provider: c.provider,
      total: all.length,
      items: items,
      hint: items.length ? '' : '最近没有日程'
    };
  });
};

/** 供诊断工具读取「发现链最终选中的日历 URL」，生产路径不用 */
module.exports.discovered = function () { return discoveredUrl; };

/** 仅供 server/selftest-agenda.js 做离线回归验证，不参与生产取数 */
module.exports.__internals = {
  parseDate: parseDate,
  parseEvents: parseEvents,
  expand: expand,
  fmtLocal: fmtLocal,
  decodeXml: decodeXml,
  assertDavResponse: assertDavResponse
};
