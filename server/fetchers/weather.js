'use strict';

/**
 * 天气板块：和风天气 QWeather 新版 v1（主） + Open-Meteo（备），支持多城市。
 *
 * 两个 provider 都归一化成同一份 DTO，前端 public/board.js 完全不用改：
 *   顶层 { provider, defaultCity, cities }
 *   city { key, name, lat, lon, timezone, days, ok, error }
 *   day  { date, dateShort, label, text, code, category, max, min, pop }
 *
 * 取数顺序由 config.blocks.weather.providerChain 决定（默认 qweather → open-meteo）：
 * 逐城依次尝试 和风 v1 → Open-Meteo 主域名 → Open-Meteo 备域名，任一成功即停；
 * 响应结构异常也当作该源失败继续回退。单城失败只影响自己，不拖垮其它城市。
 *
 * 和风的专属 API Host 与 Key 只从 secrets 读取（qweatherHost / qweatherKey），
 * 绝不写进 config.json、DTO 或日志；请求头用 X-QW-Api-Key。
 * 上游响应是 gzip 压缩的 JSON，由 server/http-util.js 的 getJson 透明解压。
 *
 * 日期只取 forecastStartTime 的前 10 位，不用 new Date() 换算，
 * 避免带时区的字符串在跨日时把当地预报日挪到前一天。
 *
 * 部分成功：只要不是全部城市成功就给结果打 __stale / __staleReason，
 * 聚合器 cleanInternal 会剥离内部字段，软分支保留旧数据、标 stale=true 并
 * 改为 10 分钟快速重试（否则会取满 3 小时 TTL，失败城市既不降级也不自愈）。
 *
 * 可通过 ctx.http 注入 getJson 便于自检；默认使用 http-util。
 */

var http = require('../http-util');

/* ---------------- Open-Meteo 兜底：WMO 码 ---------------- */

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

/* ---------------- 和风 v1：condition.code → 线条图标类别 ---------------- */

/** 昼夜两个码取「更值得显示」的那个：雷 > 雪 > 雨 > 雾 > 阴 > 云 > 晴 */
var QW_WEIGHT = { storm: 7, snow: 6, rain: 5, fog: 4, overcast: 3, cloud: 2, sun: 1, na: 0 };

/**
 * 和风新版 condition.code（字符串三位数）→ 7 类 + na。
 * 与老版图标码不同：4xx 是雪、5xx 是雾/霾，900/901/999 为未知。
 */
function qwCategoryOf(code) {
  var c = Number(code);
  if (!isFinite(c)) return 'na';
  if (c === 100 || c === 150) return 'sun';
  if ((c >= 101 && c <= 103) || (c >= 151 && c <= 153)) return 'cloud';
  if (c === 104 || c === 154) return 'overcast';
  if (c >= 500 && c <= 515) return 'fog';
  if (c >= 302 && c <= 304) return 'storm';
  if (c >= 300 && c <= 399) return 'rain';
  if (c >= 404 && c <= 406) return 'rain';           // 雨夹雪按雨显示
  if (c >= 400 && c <= 499) return 'snow';
  if (c >= 200 && c <= 213) return 'cloud';          // 风类归到就近的云
  return 'na';                                       // 900 / 901 / 999 / 未知
}

function qwPickCondition(d) {
  var a = (d.daytime && d.daytime.condition) || null;
  var b = (d.nighttime && d.nighttime.condition) || null;
  if (!a) return b;
  if (!b) return a;
  return (QW_WEIGHT[qwCategoryOf(b.code)] || 0) > (QW_WEIGHT[qwCategoryOf(a.code)] || 0) ? b : a;
}

var DAY_LABEL = ['今天', '明天', '后天'];
var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
var DEFAULT_CHAIN = ['qweather', 'open-meteo'];

/** 横向 5 天时每列很窄，标签要短：前三天用今天/明天/后天，之后用周X */
function dayLabel(iso, idx) {
  var p = String(iso).split('-');
  if (DAY_LABEL[idx]) return DAY_LABEL[idx];
  if (p.length < 3) return '';
  var wd = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))).getUTCDay();
  return '周' + WEEK[wd];
}

function shortDate(iso) {
  var p = String(iso).split('-');
  if (p.length < 3) return '';
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

/** 和风的 {value, unit} 结构，也兼容直接给数字 */
function tempOf(v) {
  if (typeof v === 'number' && isFinite(v)) return Math.round(v);
  if (v && typeof v.value === 'number' && isFinite(v.value)) return Math.round(v.value);
  return null;
}

/** 和风 probability 是 0–1 的小数，看板展示的是百分数 */
function popOf(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  var p = Math.round(v * 100);
  if (p < 0) p = 0;
  if (p > 100) p = 100;
  return p;
}

/** 两个 provider 唯一的出口，保证 day 的 9 个字段完全一致 */
function makeDay(date, idx, code, text, cat, max, min, pop) {
  var iso = String(date || '').slice(0, 10);
  return {
    date: iso,
    dateShort: shortDate(iso),
    label: dayLabel(iso, idx),
    text: text,
    code: code,
    category: cat,
    max: max,
    min: min,
    pop: pop
  };
}

/* ---------------- 两个 provider 的解析器 ---------------- */

/** 和风 v1 /weather/v1/daily：顶层 days[] */
function parseQwDays(j, forecastDays) {
  if (!j || !j.days || !j.days.length) throw new Error('unexpected qweather response');
  var arr = j.days;
  var n = Math.min(arr.length, forecastDays);
  var days = [];
  var i, d, cond, code, text, pop;
  for (i = 0; i < n; i++) {
    d = arr[i];
    cond = qwPickCondition(d) || {};
    code = cond.code === undefined || cond.code === null ? null : Number(cond.code);
    if (!isFinite(code)) code = null;
    text = String(cond.text || '').slice(0, 5) || ('代码 ' + code);
    pop = null;
    if (d.daytime && d.daytime.precipitation) pop = popOf(d.daytime.precipitation.probability);
    if (pop === null && d.nighttime && d.nighttime.precipitation) {
      pop = popOf(d.nighttime.precipitation.probability);
    }
    days.push(makeDay(
      d.forecastStartTime || (d.daytime && d.daytime.forecastStartTime),
      i, code, text, qwCategoryOf(code),
      tempOf(d.temperatureMax), tempOf(d.temperatureMin), pop
    ));
  }
  return days;
}

/** Open-Meteo 兜底：daily.* 并列数组 */
function parseOmDays(j, forecastDays) {
  if (!j || !j.daily || !j.daily.time) throw new Error('unexpected open-meteo response');
  var d = j.daily;
  var n = Math.min(d.time.length, forecastDays);
  var days = [];
  var i, code;
  for (i = 0; i < n; i++) {
    code = d.weather_code ? d.weather_code[i] : null;
    days.push(makeDay(
      d.time[i], i, code,
      WMO[code] || ('代码 ' + code),
      categoryOf(code),
      d.temperature_2m_max ? Math.round(d.temperature_2m_max[i]) : null,
      d.temperature_2m_min ? Math.round(d.temperature_2m_min[i]) : null,
      d.precipitation_probability_max ? d.precipitation_probability_max[i] : null
    ));
  }
  return days;
}

/* ---------------- 请求构造 ---------------- */

function qwUrl(ctx, city, forecastDays) {
  var host = ctx.secrets && ctx.secrets.get ? ctx.secrets.get('qweatherHost') : null;
  if (!host) return null;
  return 'https://' + String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '') +
    '/weather/v1/daily/' + encodeURIComponent(city.latitude) + '/' +
    encodeURIComponent(city.longitude) + '?days=' + encodeURIComponent(forecastDays);
}

function omUrl(city, forecastDays, endpoint) {
  var qs = [
    'latitude=' + encodeURIComponent(city.latitude),
    'longitude=' + encodeURIComponent(city.longitude),
    'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    'timezone=' + encodeURIComponent(city.timezone),
    'forecast_days=' + encodeURIComponent(forecastDays)
  ].join('&');
  return endpoint + '?' + qs;
}

function omEndpoints(c) {
  var out = [];
  if (c.endpoint) out.push(c.endpoint);
  if (c.fallbackEndpoint && c.fallbackEndpoint !== c.endpoint) out.push(c.fallbackEndpoint);
  return out;
}

/** 把 providerChain 展开成「逐城依次尝试」的具体请求列表 */
function buildSteps(ctx, cfg, city, forecastDays, chain) {
  var steps = [];
  var i, k, eps, key, u;
  for (i = 0; i < chain.length; i++) {
    if (chain[i] === 'qweather') {
      key = ctx.secrets && ctx.secrets.get ? ctx.secrets.get('qweatherKey') : null;
      u = qwUrl(ctx, city, forecastDays);
      if (key && u) {
        steps.push({ url: u, parser: parseQwDays, headers: { 'X-QW-Api-Key': key } });
      }
    } else if (chain[i] === 'open-meteo') {
      eps = omEndpoints(cfg);
      for (k = 0; k < eps.length; k++) {
        steps.push({ url: omUrl(city, forecastDays, eps[k]), parser: parseOmDays, headers: null });
      }
    }
  }
  return steps;
}

/** 单个城市：按请求链依次尝试；无论成功失败都 resolve 成同形状的对象 */
function fetchOne(ctx, cfg, city, forecastDays, chain) {
  var base = {
    key: city.key,
    name: city.name,
    lat: city.latitude,
    lon: city.longitude,
    timezone: city.timezone
  };
  var steps = buildSteps(ctx, cfg, city, forecastDays, chain);
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
    var s, opts;
    if (idx >= steps.length) {
      return Promise.resolve(result(false, [], lastErr || 'no weather source configured'));
    }
    s = steps[idx++];
    opts = { timeoutMs: 10000 };
    if (s.headers) opts.headers = s.headers;
    return Promise.resolve().then(function () {
      return httpOf(ctx).getJson(s.url, opts);
    }).then(function (j) {
      var days;
      try { days = s.parser(j, forecastDays); }
      catch (pe) { lastErr = errText(pe); return attempt(); }
      if (!days.length) { lastErr = 'empty forecast'; return attempt(); }
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
  var forecastDays = c.forecastDays || 5;
  var chain = (c.providerChain && c.providerChain.length) ? c.providerChain : DEFAULT_CHAIN;
  var tasks = [];
  var i, good, out;

  if (!c.enabled || !list.length) {
    return Promise.resolve({
      disabled: true,
      defaultCity: c.defaultCity || '',
      cities: []
    });
  }

  for (i = 0; i < list.length; i++) {
    tasks.push(fetchOne(ctx, c, list[i], forecastDays, chain));
  }

  return Promise.all(tasks).then(function (cities) {
    good = 0;
    for (i = 0; i < cities.length; i++) {
      if (cities[i].ok) good++;
    }
    if (!good) throw new Error('all weather cities failed');
    out = {
      provider: c.provider || chain[0],
      defaultCity: c.defaultCity || list[0].key,
      cities: cities
    };
    // 部分成功：让聚合器走 stale 软分支，保留旧数据并 10 分钟快速重试
    if (good < cities.length) {
      out.__stale = true;
      out.__staleReason = 'partial weather: ' + good + '/' + cities.length;
    }
    return out;
  });
};

/** 供离线自检使用：不发起网络请求即可验证两套码表与解析器 */
module.exports.categoryOf = categoryOf;
module.exports.CATEGORY = CATEGORY;
module.exports.qwCategoryOf = qwCategoryOf;
module.exports.QW_WEIGHT = QW_WEIGHT;
module.exports.__internals = {
  parseQwDays: parseQwDays,
  parseOmDays: parseOmDays,
  makeDay: makeDay,
  qwPickCondition: qwPickCondition,
  qwUrl: qwUrl,
  buildSteps: buildSteps,
  DEFAULT_CHAIN: DEFAULT_CHAIN
};
