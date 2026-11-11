'use strict';

/**
 * CalDAV 诊断工具：跑一遍与生产完全相同的取数路径，只打印「结构摘要」。
 * 绝不输出凭据、URL 路径中的账号标识、日程标题或参与者。
 *
 *   node server/diagnose-caldav.js
 *
 * 用来回答「日程区为什么是空的」：是凭据没读到、发现链没找到日历、
 * REPORT 没返回 calendar-data、ICS 解析不出 VEVENT，还是日历真的没有事件。
 */

var cfg = require('../config.json');
var secrets = require('./secrets');
var http = require('./http-util');
var agenda = require('./fetchers/agenda');

var trace = [];
var ctx = { cfg: cfg, secrets: secrets, http: http, trace: trace };

function p(s) { console.log(s); }

function uniq(a) {
  var seen = {}, out = [], i;
  for (i = 0; i < a.length; i++) if (!seen[a[i]]) { seen[a[i]] = 1; out.push(a[i]); }
  return out;
}

/** 当 REPORT 只给 calendar-data 404 时，逐个试标准兼容写法，找出服务器接受的那一种 */
function compatProbe(report) {
  // 只有「multiget 也没拿到 VEVENT」时才逐个试兼容写法
  if (!report || (report.vevents || 0) > 0) return Promise.resolve();
  var url = agenda.discovered && agenda.discovered();
  if (!url) { p('（无 discoveredUrl，跳过兼容探测）'); return Promise.resolve(); }

  var basic = 'Basic ' + Buffer.from(
    secrets.get('caldavUser') + ':' + secrets.get('caldavPass')
  ).toString('base64');
  var open = '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">';
  var filter = '<C:filter><C:comp-filter name="VCALENDAR">' +
    '<C:comp-filter name="VEVENT"/></C:comp-filter></C:filter>';

  function go(label, propXml) {
    var body = open + '<D:prop>' + propXml + '</D:prop>' + filter + '</C:calendar-query>';
    return http.request('REPORT', url, {
      headers: { Authorization: basic, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: body, timeoutMs: 15000, maxBytes: 8 * 1024 * 1024
    }).then(function (r) {
      var x = r.body.toString('utf8');
      p('  ' + label + ' → status=' + r.status + ' bytes=' + x.length +
        ' calendarData=' + ((x.match(/<[^>]*calendar-data[^>]*>/gi) || []).length) +
        ' VEVENT=' + ((x.match(/BEGIN:VEVENT/g) || []).length) +
        ' statuses=' + JSON.stringify(uniq((x.match(/<[^>]*status[^>]*>\s*[^<]+/gi) || [])
          .map(function (s) { return s.replace(/^[^>]*>/, '').trim(); }))));
      return x;
    }, function (e) {
      p('  ' + label + ' → ERR ' + http.errText(e));
      return '';
    });
  }

  p('');
  p('=== 兼容探测（哪种写法能拿到 ICS 正文）===');
  return go('A. calendar-data + comp VCALENDAR',
    '<C:calendar-data><C:comp name="VCALENDAR"/></C:calendar-data>')
    .then(function () {
      return go('B. + 嵌套 comp VEVENT',
        '<C:calendar-data><C:comp name="VCALENDAR"><C:comp name="VEVENT"/></C:comp></C:calendar-data>');
    })
    .then(function () {
      return go('C. 裸 calendar-data（无 comp）', '<C:calendar-data/>');
    })
    .then(function () {
      return go('D. getetag + comp VCALENDAR',
        '<D:getetag/><C:calendar-data><C:comp name="VCALENDAR"/></C:calendar-data>');
    })
    .then(function () { return multigetProbe(url, basic); });
}

/** E: calendar-multiget；F: 直接 GET 单个 .ics 资源。href 只在内部使用，不打印 */
function multigetProbe(url, basic) {
  var qs = '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    '<D:prop><D:getetag/></D:prop>' +
    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter>' +
    '</C:calendar-query>';

  function req(method, u, body) {
    return http.request(method, u, {
      headers: {
        Authorization: basic, Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8'
      },
      body: body, timeoutMs: 15000, maxBytes: 8 * 1024 * 1024
    });
  }

  return req('REPORT', url, qs).then(function (r) {
    var xml = r.body.toString('utf8');
    var hrefs = [], re = /<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href[^>]*>/gi, m;
    while ((m = re.exec(xml)) !== null) {
      if (m[1].trim()) hrefs.push(m[1].trim().replace(/&amp;/g, '&'));
    }
    p('  E. query(只 getetag) → status=' + r.status + ' href 数=' + hrefs.length);
    if (!hrefs.length) return '';

    var body = '<?xml version="1.0" encoding="utf-8"?>' +
      '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
      '<D:prop><D:getetag/><C:calendar-data/></D:prop>' +
      hrefs.map(function (h) {
        return '<D:href>' + h.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</D:href>';
      }).join('') + '</C:calendar-multiget>';

    return req('REPORT', url, body).then(function (r2) {
      var x = r2.body.toString('utf8');
      p('     multiget → status=' + r2.status + ' bytes=' + x.length +
        ' VEVENT=' + ((x.match(/BEGIN:VEVENT/g) || []).length) +
        ' statuses=' + JSON.stringify(uniq((x.match(/<[^>]*status[^>]*>\s*[^<]+/gi) || [])
          .map(function (s) { return s.replace(/^[^>]*>/, '').trim(); }))));
      if ((x.match(/BEGIN:VEVENT/g) || []).length) return x;

      // F: 直接 GET 第一个 href
      var target = require('url').resolve(url, hrefs[0]);
      return http.request('GET', target, {
        headers: { Authorization: basic }, timeoutMs: 10000, maxBytes: 1024 * 1024
      }).then(function (r3) {
        var t = r3.body.toString('utf8');
        p('     GET 单个资源 → status=' + r3.status + ' bytes=' + t.length +
          ' VEVENT=' + ((t.match(/BEGIN:VEVENT/g) || []).length) +
          ' 以BEGIN开头=' + (/^\s*BEGIN:VCALENDAR/i.test(t)));
        return t;
      }, function (e) {
        p('     GET 单个资源 → ERR ' + http.errText(e));
        return '';
      });
    }, function (e) {
      p('     multiget → ERR ' + http.errText(e));
      return '';
    });
  }, function (e) {
    p('  E. query → ERR ' + http.errText(e));
    return '';
  });
}

p('=== CalDAV 诊断（不输出凭据 / 日程内容）===');
p('凭据状态: ' + JSON.stringify(secrets.status()));
var raw = secrets.get('caldavUrl');
p('caldavUrl: ' + (raw ? '已配置, 长度 ' + raw.length + ', 带 scheme=' + /^https?:\/\//i.test(raw) : '未配置'));
p('');

agenda(ctx).then(function (data) {
  var i;
  for (i = 0; i < trace.length; i++) p('[' + (i + 1) + '] ' + JSON.stringify(trace[i]));
  p('');
  p('=== 结果 ===');
  p('configured = ' + data.configured);
  p('total      = ' + (data.total === undefined ? '-' : data.total));
  p('items      = ' + ((data.items && data.items.length) || 0));
  p('hint       = ' + (data.hint || '-'));
  p('');
  if (data.total === 0) {
    p('=== 判读 ===');
    var last = trace[trace.length - 1] || {};
    var q = null, mg = null, k;
    for (k = 0; k < trace.length; k++) {
      if (trace[k].step === 'REPORT query(hrefs)') q = trace[k];
      if (trace[k].step === 'REPORT multiget(ics)') mg = trace[k];
    }
    if (!q) p('query 未发出：发现链失败，检查凭据与 caldavUrl。');
    else if (!q.responses) p('query 成功但没有 href：日历集合选错或日历为空。');
    else if (!mg) p('有 href 但 multiget 未发出/失败：看上面的 ERR 行。');
    else if (!mg.vevents) p('multiget 成功但无 VEVENT：服务器又不给 calendar-data，看下面兼容探测。');
    else if (last.rawEvents === 0) p('XML 有 VEVENT 但 ICS 解析为 0：检查 calendar-data 是否被 CDATA / 实体转义包裹。');
    else if (last.expanded === 0) p('解析出 ' + last.rawEvents + ' 个 VEVENT，但全部落在时间窗外或被 RRULE 展开丢弃。');
    else p('解析出事件但被过滤：检查 STATUS / DTSTART 解析。');
  }
  var rep = null, m;
  for (m = 0; m < trace.length; m++) if (trace[m].step === 'REPORT multiget(ics)') rep = trace[m];
  return compatProbe(rep);
}).then(function () {
  process.exit(0);
}).catch(function (e) {
  var i;
  for (i = 0; i < trace.length; i++) p('[' + (i + 1) + '] ' + JSON.stringify(trace[i]));
  p('取数失败: ' + http.errText(e));
  process.exit(1);
});
