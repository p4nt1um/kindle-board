'use strict';

/**
 * 天气板块：Open-Meteo（无需 API Key），支持多城市。
 *
 * 城市、经纬度、时区、endpoint、预报天数全部来自 config.json 的 blocks.weather.cities。
 * cities[].key 必须等于 board.zones[].id —— 前端点击时钟时用 clock.data.zones[i].id
 * 直接索引，不做城市名匹配。因此 key 是稳定内部键，不代表地名：
 * 示例第二时区为 America/New_York；实际城市与坐标一律由 config.json 的 cities[] 下发。
 *
 * 注意：
 *  - daily 参数必须显式带 timezone，否则 Open-Meteo 按 UTC 分日；
 *    且上游在请求区间内发生 DST 变化时会忽略 DST（上海无 DST，美东需留意）。
 *  - 单城失败隔离：该 city 返回 days:[] + ok:false + error，其它城市照常下发；
 *    全部失败才抛错，交给聚合器的 state.__stale 软分支保留上一次成功缓存。
 *  - 主备 endpoint：endpoint 失败（或响应结构异常）时自动回退 fallbackEndpoint，
 *    每个城市独立尝试。把当前可达的域名放在 endpoint 可避免每轮白等 10s 超时；
 *    两个域名互为兜底，任一恢复即可用，改配置即可调整优先级，不需要改代码。
 *  - 每天补 code（WMO weather_code）与 category（线条图标的归并类别）。
 *  - 可通过 ctx.http 注入 getJson 便于自检；默认使用 http-util。
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

/** WMO 数值码 → 线条图标类别。前端 public/board.css 的 .wico-<category> 与之对应。 */
var CATEGORY = {
  0: 'sun',
  1: 'cloud', 2: 'cloud',
  3: 'overcast',
  45: 'fog', 48: 'fog',
  51: 'rain', 53: 'rain', 55: 'rain', 56: 'rain', 57: 'rain',
  61: 'rain', 63: 'rain', 65: 'rain', 66: 'rain', 67: 'rain',
  80: 'rain', 81: 'rain', 82: 'rain',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow',
  85: 'snow', 86: 'snow',
  95: 'storm', 96: 'storm', 99: 'storm'
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

function categoryOf(code) {
  return CATEGORY[code] || 'na';
}

function httpOf(ctx) {
  return (ctx && ctx.http) ? ctx.http : http;
}

function errText(e) {
  var s = (e && e.message) ? String(e.message) : 'request failed';
  return s.slice(0, 80);
}

function parseDays(j, forecastDays) {
  if (!j || !j.daily || !j.daily.time) throw new Error('unexpected open-meteo response');
  var d = j.daily;
  var days = [];
  var n = Math.min(d.time.length, forecastDays);
  var i, code;
  for (i = 0; i < n; i++) {
    code = d.weather_code ? d.weather_code[i] : null;
    days.push({
      date: d.time[i],
      dateShort: shortDate(d.time[i]),
      label: dayLabel(d.time[i], i),
      text: WMO[code] || ('代码 ' + code),
      code: code,
      category: categoryOf(code),
      max: d.temperature_2m_max ? Math.round(d.temperature_2m_max[i]) : null,
      min: d.temperature_2m_min ? Math.round(d.temperature_2m_min[i]) : null,
      pop: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null
    });
  }
  return days;
}

/** 单个城市：依次尝试主备 endpoint；无论成功失败都 resolve 成同形状的对象，
 *  避免 Promise.all 被一地拖垮。响应结构异常也当作该 endpoint 失败继续回退。 */
function fetchOne(ctx, city, forecastDays, endpoints) {
  var qs = [
    'latitude=' + encodeURIComponent(city.latitude),
    'longitude=' + encodeURIComponent(city.longitude),
    'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    'timezone=' + encodeURIComponent(city.timezone),
    'forecast_days=' + encodeURIComponent(forecastDays)
  ].join('&');
  var base = {
    key: city.key,
    name: city.name,
    lat: city.latitude,
    lon: city.longitude,
    timezone: city.timezone
  };
  var idx = 0;
  var lastErr = '';

  function result(ok, days, err) {
    return {
      key: base.key, name: base.name, lat: base.lat, lon: base.lon,
      timezone: base.timezone,
      days: days, ok: ok, error: err
    };
  }

  function attempt() {
    var url;
    if (idx >= endpoints.length) {
      return Promise.resolve(result(false, [], lastErr || 'no endpoint configured'));
    }
    url = endpoints[idx] + '?' + qs;
    idx++;
    return Promise.resolve().then(function () {
      return httpOf(ctx).getJson(url, { timeoutMs: 10000 });
    }).then(function (j) {
      var days;
      try { days = parseDays(j, forecastDays); }
      catch (pe) { lastErr = errText(pe); return attempt(); }
      return result(true, days, '');
    }, function (e) {
      lastErr = errText(e);
      return attempt();
    });
  }
  return attempt();
}

module.exports = function fetch(ctx) {
  var c = ctx.cfg.blocks.weather;
  var list = c.cities || [];
  var forecastDays = c.forecastDays || 3;
  var endpoints = [];
  var tasks = [];
  var i, good;

  if (!c.enabled || !list.length) {
    return Promise.resolve({
      disabled: true,
      defaultCity: c.defaultCity || '',
      cities: []
    });
  }

  if (c.endpoint) endpoints.push(c.endpoint);
  if (c.fallbackEndpoint && c.fallbackEndpoint !== c.endpoint) {
    endpoints.push(c.fallbackEndpoint);
  }

  for (i = 0; i < list.length; i++) {
    tasks.push(fetchOne(ctx, list[i], forecastDays, endpoints));
  }

  return Promise.all(tasks).then(function (cities) {
    good = 0;
    for (i = 0; i < cities.length; i++) {
      if (cities[i].ok) good++;
    }
    if (!good) throw new Error('all weather cities failed');
    return {
      provider: c.provider,
      defaultCity: c.defaultCity || list[0].key,
      cities: cities
    };
  });
};

/** 供自检使用：不发起网络请求即可验证 WMO → 图标类别归并 */
module.exports.categoryOf = categoryOf;
module.exports.CATEGORY = CATEGORY;
