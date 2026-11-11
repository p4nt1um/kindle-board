'use strict';

/**
 * 天气板块：Open-Meteo（无需 API Key）。
 * 城市、经纬度、数据源 endpoint、预报天数全部来自 config.json，可整块替换 provider。
 * 注意 daily 参数必须显式带 timezone，否则 Open-Meteo 按 UTC 分日；
 * 且上游在请求区间内发生 DST 变化时会忽略 DST（上海无 DST，美东场景需留意）。
 */

var http = require('../http-util');

var WMO = {
  0: '晴', 1: '晴间多云', 2: '少云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛雨', 53: '毛雨', 55: '大毛雨',
  56: '冻毛雨', 57: '强冻毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷雨', 96: '雷雨伴冰雹', 99: '强雷雨伴冰雹'
};

var DAY_LABEL = ['今天', '明天', '后天'];
var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** 横向 5 天时每列很窄，标签要短：前三天用今天/明天/后天，之后用周X */
function dayLabel(iso, idx) {
  var p = iso.split('-');
  if (DAY_LABEL[idx]) return DAY_LABEL[idx];
  var wd = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay();
  return '周' + WEEK[wd];
}

function shortDate(iso) {
  var p = iso.split('-');
  return Number(p[1]) + '/' + Number(p[2]);
}

module.exports = function fetch(ctx) {
  var c = ctx.cfg.blocks.weather;
  if (!c.enabled) return Promise.resolve({ disabled: true, days: [] });

  var qs = [
    'latitude=' + encodeURIComponent(c.latitude),
    'longitude=' + encodeURIComponent(c.longitude),
    'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    'timezone=' + encodeURIComponent(c.timezone),
    'forecast_days=' + encodeURIComponent(c.forecastDays || 3)
  ].join('&');
  var url = c.endpoint + '?' + qs;

  return http.getJson(url, { timeoutMs: 10000 }).then(function (j) {
    if (!j || !j.daily || !j.daily.time) throw new Error('unexpected open-meteo response');
    var d = j.daily;
    var days = [];
    var n = Math.min(d.time.length, c.forecastDays || 3);
    var i;
    for (i = 0; i < n; i++) {
      var code = d.weather_code ? d.weather_code[i] : null;
      days.push({
        date: d.time[i],
        dateShort: shortDate(d.time[i]),
        label: dayLabel(d.time[i], i),
        text: WMO[code] || ('代码 ' + code),
        max: d.temperature_2m_max ? Math.round(d.temperature_2m_max[i]) : null,
        min: d.temperature_2m_min ? Math.round(d.temperature_2m_min[i]) : null,
        pop: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null
      });
    }
    return {
      city: c.city,
      provider: c.provider,
      timezone: c.timezone,
      days: days
    };
  });
};
