'use strict';

/**
 * 时钟板块（realtime）。
 * 关键：所有时区/夏令时计算都在 PC 侧用 Node Intl + IANA 时区完成，
 * 只把「当前 UTC 毫秒 + 每个时区的真实偏移分钟 + 下一次 DST 切换点」交给浏览器。
 * 旧 WebKit 不需要理解 DST，只要按偏移做分钟级加法即可。
 */

var cfg = require('../../config.json');
var lunar = require('./lunar');   // 农历板块已移除，历法计算并入时钟标题行

var fWall = {};
var fParts = {};

function partsFormatter(tz) {
  if (!fParts[tz]) {
    fParts[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
  return fParts[tz];
}

function wallFormatter(tz) {
  if (!fWall[tz]) {
    fWall[tz] = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short'
    });
  }
  return fWall[tz];
}

/** 某个 IANA 时区在给定时刻的真实 UTC 偏移（分钟）。不能用 PC 本地 getTimezoneOffset 代替。 */
function zoneOffsetMinutes(tz, d) {
  var arr = partsFormatter(tz).formatToParts(d);
  var parts = {};
  var i;
  for (i = 0; i < arr.length; i++) parts[arr[i].type] = arr[i].value;
  var asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** 找下一次 DST 切换时刻：粗扫 + 二分，返回 UTC 毫秒；无 DST 的时区返回 null */
function nextDstTransition(tz, from) {
  var start = from.getTime();
  var o0 = zoneOffsetMinutes(tz, from);
  var step = 6 * 3600 * 1000;
  var limit = start + 200 * 86400 * 1000;
  var t, lo, hi, mid, k;

  for (t = start; t < limit; t += step) {
    if (zoneOffsetMinutes(tz, new Date(t)) !== o0) {
      lo = t - step;
      hi = t;
      for (k = 0; k < 24; k++) {
        mid = Math.floor((lo + hi) / 2);
        if (zoneOffsetMinutes(tz, new Date(mid)) === o0) lo = mid; else hi = mid;
      }
      return hi;
    }
  }
  return null;
}

function isDst(tz, d, off) {
  var y = d.getUTCFullYear();
  var jan = zoneOffsetMinutes(tz, new Date(Date.UTC(y, 0, 15)));
  var jul = zoneOffsetMinutes(tz, new Date(Date.UTC(y, 6, 15)));
  return Math.max(jan, jul) > Math.min(jan, jul) && off === Math.max(jan, jul);
}

function sync(at) {
  var now = at ? new Date(at) : new Date();
  var zones = [];
  var nextTransition = null;
  var i, z, nt, off;

  for (i = 0; i < cfg.board.zones.length; i++) {
    z = cfg.board.zones[i];
    off = zoneOffsetMinutes(z.timeZone, now);
    nt = nextDstTransition(z.timeZone, now);
    if (nt !== null && (nextTransition === null || nt < nextTransition)) nextTransition = nt;
    zones.push({
      id: z.id,
      label: z.label,
      timeZone: z.timeZone,
      offsetMinutes: off,
      isDst: isDst(z.timeZone, now, off),
      text: wallFormatter(z.timeZone).format(now)
    });
  }
  // 板块标题行直接显示「公历日期 星期X  农历X月Xx 干支年 [生肖年]」，有节日再追加
  var l = lunar.sync(now);
  var titleText = l.dateText + '  ' + l.lunarText + ' ' + l.yearText +
    (l.festival ? '  ' + l.festival : '');

  return {
    nowUtcMs: now.getTime(),
    nextDstTransitionUtc: nextTransition,
    zones: zones,
    titleText: titleText
  };
}

function fetch() { return Promise.resolve(sync()); }
fetch.sync = sync;

module.exports = fetch;
module.exports.zoneOffsetMinutes = zoneOffsetMinutes;
module.exports.nextDstTransition = nextDstTransition;
