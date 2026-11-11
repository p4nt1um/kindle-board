'use strict';

/**
 * 日程解析离线回归自检（不联网、不读凭据）：
 *   node server/selftest-agenda.js
 *
 * 覆盖《飞书日程CalDAV相关逻辑》§5 点出的 ESP32 实现风险，在 Node 侧的对应行为：
 *   时区 / TZID / Z、全天事件、RRULE + EXDATE、取消事件、ICS 数字实体换行、
 *   以及「HTTP 200 但不是 DAV multistatus」必须判失败而不是静默清空日程。
 */

var a = require('./fetchers/agenda').__internals;
var passed = 0;
var failed = 0;

function check(name, fn) {
  try {
    var detail = fn();
    console.log('  PASS  ' + name + (detail ? '  → ' + detail : ''));
    passed++;
  } catch (e) {
    console.log('  FAIL  ' + name + '  → ' + e.message);
    failed++;
  }
}

function eq(actual, expected, what) {
  if (String(actual) !== String(expected)) {
    throw new Error((what || 'value') + ': 期望 ' + expected + '，实际 ' + actual);
  }
}

function truthy(v, what) {
  if (!v) throw new Error((what || 'condition') + ': 期望为真');
}

function ics(lines) { return lines.join('\r\n'); }

function oneEvent(lines, tz) {
  var body = ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT']
    .concat(lines)
    .concat(['END:VEVENT', 'END:VCALENDAR']));
  var evs = a.parseEvents(body);
  if (!evs.length) throw new Error('测试 ICS 没有解析出 VEVENT（构造有误）');
  return a.expand(evs[0], Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 31), tz || 'Asia/Shanghai');
}

console.log('=== 日程解析离线自检 ===');
console.log('');
console.log('[1] 时间与时区');

check('全天事件按 Asia/Shanghai 当地午夜解释，日期仍是 11/9', function () {
  var p = a.parseDate({ value: '20261109', params: { VALUE: 'DATE' } }, 'Asia/Shanghai');
  truthy(p && p.allDay, 'allDay');
  var f = a.fmtLocal(p.ms, 'Asia/Shanghai');
  eq(f.date, '11/9', '上海日期');
  eq(f.weekday, '一', '星期');
  return 'UTC=' + new Date(p.ms).toISOString() + ' → ' + f.date + ' 周' + f.weekday;
});

check('全天事件在 America/New_York 不会倒退成前一天', function () {
  var p = a.parseDate({ value: '20261109', params: { VALUE: 'DATE' } }, 'America/New_York');
  var f = a.fmtLocal(p.ms, 'America/New_York');
  eq(f.date, '11/9', '美东日期');
  // 旧实现用 Date.UTC(y,mo,d) 会得到 11/8，这里显式锁住回归
  var legacy = a.fmtLocal(Date.UTC(2026, 10, 9), 'America/New_York');
  eq(legacy.date, '11/8', '旧实现的错误结果');
  return '新实现 ' + f.date + '（旧实现会显示 ' + legacy.date + '）';
});

check('带 Z 的 UTC 时间正确换算到上海', function () {
  var p = a.parseDate({ value: '20261109T013000Z', params: {} }, 'Asia/Shanghai');
  var f = a.fmtLocal(p.ms, 'Asia/Shanghai');
  eq(f.time, '09:30', '上海时间');
  eq(f.date, '11/9', '日期');
  return '01:30Z → 上海 ' + f.time;
});

check('TZID=America/New_York 夏令时 -4 / 冬令时 -5 由 ICU 真实偏移给出', function () {
  var summer = a.parseDate({ value: '20260701T100000', params: { TZID: 'America/New_York' } }, 'Asia/Shanghai');
  var winter = a.parseDate({ value: '20260115T100000', params: { TZID: 'America/New_York' } }, 'Asia/Shanghai');
  eq(new Date(summer.ms).toISOString(), '2026-07-01T14:00:00.000Z', '夏令时 UTC');
  eq(new Date(winter.ms).toISOString(), '2026-01-15T15:00:00.000Z', '冬令时 UTC');
  eq(a.fmtLocal(summer.ms, 'Asia/Shanghai').time, '22:00', '夏令时上海时间');
  eq(a.fmtLocal(winter.ms, 'Asia/Shanghai').time, '23:00', '冬令时上海时间');
  return 'EDT 10:00→22:00 / EST 10:00→23:00（上海）';
});

console.log('');
console.log('[2] ICS 解码与解析');

check('飞书数字实体换行 &#13;&#10; / &#xA; 还原为真实换行', function () {
  var s = a.decodeXml('BEGIN:VCALENDAR&#13;&#10;BEGIN:VEVENT&#xA;SUMMARY:AT&amp;T&#13;&#10;END:VEVENT');
  eq((s.match(/\r\n/g) || []).length, 2, 'CRLF 数');
  truthy(s.indexOf('BEGIN:VEVENT\n') >= 0, 'LF 换行');
  truthy(s.indexOf('SUMMARY:AT&T') >= 0, '&amp; 最后解码');
  return 'CRLF=2 / LF=1 / 实体已解';
});

check('折叠行 unfolding 后能解析出 VEVENT', function () {
  var body = ics([
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT',
    'SUMMARY:这是一条很长的标题，', ' 被折叠到第二行',
    'DTSTART:20261109T020000Z', 'END:VEVENT', 'END:VCALENDAR'
  ]);
  var evs = a.parseEvents(body);
  eq(evs.length, 1, 'VEVENT 数');
  eq(evs[0].props.SUMMARY, '这是一条很长的标题，被折叠到第二行', '折叠后标题');
  return 'SUMMARY 已还原';
});

check('STATUS:CANCELLED（含小写）事件被跳过', function () {
  var upper = oneEvent(['SUMMARY:已取消', 'STATUS:CANCELLED', 'DTSTART:20261109T120000Z']);
  var lower = oneEvent(['SUMMARY:已取消', 'STATUS:cancelled', 'DTSTART:20261109T120000Z']);
  eq(upper.length, 0, '大写 CANCELLED');
  eq(lower.length, 0, '小写 cancelled');
  return '两种大小写均跳过';
});

check('RRULE WEEKLY + COUNT + BYDAY + EXDATE 正确展开', function () {
  var out = oneEvent([
    'SUMMARY:周会',
    'DTSTART;TZID=Asia/Shanghai:20261109T100000',
    'DTEND;TZID=Asia/Shanghai:20261109T110000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3',
    'EXDATE;TZID=Asia/Shanghai:20261116T100000'
  ]);
  eq(out.length, 2, '实例数');
  var days = out.map(function (o) { return a.fmtLocal(o.startMs, 'Asia/Shanghai').date; });
  eq(days.join(','), '11/9,11/23', '实例日期');
  truthy(out[0].recurring, 'recurring 标记');
  return '11/9 + 11/23（11/16 被 EXDATE 排除）';
});

check('全天事件默认按 1 天时长展开', function () {
  var out = oneEvent(['SUMMARY:全天', 'DTSTART;VALUE=DATE:20261109']);
  eq(out.length, 1, '实例数');
  truthy(out[0].allDay, 'allDay');
  eq(out[0].endMs - out[0].startMs, 86400000, '时长');
  return a.fmtLocal(out[0].startMs, 'Asia/Shanghai').date + ' 全天';
});

console.log('');
console.log('[3] 失败判定（防止 200 响应静默清空日程）');

check('HTML 错误页 / 非 multistatus 响应必须抛错', function () {
  var threw = false;
  try { a.assertDavResponse('<html><body>502 Bad Gateway</body></html>', 'REPORT query'); }
  catch (e) { threw = true; }
  truthy(threw, '应抛错');
  return '已抛错';
});

check('空 multistatus 是合法空日历，不抛错', function () {
  a.assertDavResponse('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>', 'REPORT query');
  return '放行';
});

check('带 response 的正常 multistatus 不抛错', function () {
  a.assertDavResponse('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x.ics</d:href></d:response></d:multistatus>', 'REPORT multiget');
  return '放行';
});

console.log('');
console.log('=== 结果: ' + passed + ' 通过 / ' + failed + ' 失败 ===');
if (failed) process.exit(1);
