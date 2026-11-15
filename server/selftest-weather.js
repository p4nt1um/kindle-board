'use strict';

/**
 * 天气 fetcher 回归：用 mock 的 ctx.http / ctx.secrets 真正执行
 * server/fetchers/weather.js，不发起任何网络请求、不需要任何真实凭据。
 *
 *   node server/selftest-weather.js
 *
 * 覆盖：两套码表（Open-Meteo WMO / 和风 v1 condition.code）、昼夜取更显著天气、
 *       和风 {value,unit} 温度与 0–1 降水概率归一化、两套解析器输出同形 day、
 *       UTC 日窗口 → 各城市当地日期（lang=zh / 中文文案兜底）、
 *       逐城「和风 → OM 主 → OM 备」回退链、请求头认证、缺凭据跳过、
 *       部分成功 __stale、DTO 字段白名单、gzip 解压、聚合器 10 分钟重试。
 *
 * 内置配置全为公开示例（虚构 Host / Key / 城市），不读取本机 config.json。
 */

var fs = require('fs');
var path = require('path');
var fetchWeather = require('./fetchers/weather');
var I = fetchWeather.__internals;

var QW_HOST = 'example.qweather.test';      // 虚构域名，绝不指向真实上游
var QW_KEY = 'FAKE_QW_KEY';                // 假值，check-secrets 的 looksSafe 会放行
var QW_PATH = '/weather/v1/daily/';

var cfg = {
  board: {
    zones: [
      { id: 'cityA', label: '甲城', timeZone: 'Asia/Shanghai' },
      { id: 'cityB', label: '乙城', timeZone: 'America/New_York' }
    ]
  },
  blocks: {
    weather: {
      enabled: true,
      provider: 'qweather',
      providerChain: ['qweather', 'open-meteo'],
      endpoint: 'https://historical-forecast-api.open-meteo.com/v1/forecast',
      fallbackEndpoint: 'https://api.open-meteo.com/v1/forecast',
      defaultCity: 'cityA',
      forecastDays: 5,
      cities: [
        { key: 'cityA', name: '甲城', latitude: 31.2304, longitude: 121.4737, timezone: 'Asia/Shanghai' },
        { key: 'cityB', name: '乙城', latitude: 40.7128, longitude: -74.0060, timezone: 'America/New_York' }
      ]
    }
  }
};

var pass = 0;
var fail = 0;
var pending = [];
/** 同时支持同步断言与返回 Promise 的异步断言（fetcher 是 Promise 风格） */
function check(name, fn) {
  var out;
  try { out = fn(); }
  catch (e) { fail++; console.log('  [FAIL] ' + name + '  → ' + e.message); return; }
  if (out && typeof out.then === 'function') {
    pending.push(out.then(function (d) {
      pass++; console.log('  [ok] ' + name + (d ? '  → ' + d : ''));
    }, function (e) {
      fail++; console.log('  [FAIL] ' + name + '  → ' + (e && e.message ? e.message : e));
    }));
    return;
  }
  pass++; console.log('  [ok] ' + name + (out ? '  → ' + out : ''));
}
function eq(a, b, label) {
  if (a !== b) throw new Error((label || '值') + ' 不符: 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b));
}
function truthy(v, label) { if (!v) throw new Error(label || '应为真'); }

/* ---------------- 两份上游样例（结构与实测一致） ---------------- */

var QW_CODES = ['100', '305', '401', '501', '302'];
var QW_TEXT = ['晴', '小雨', '小雪', '雾', '雷阵雨'];
var QW_MAX = [18, 15, 2, 9, 22];
var QW_MIN = [9, 7, -3, 3, 14];
var QW_POP = [0.1, 0.8, 0.6, 0.2, 0.9];

/** 和风 v1 /weather/v1/daily：顶层 days[]，温度是 {value,unit}，概率是 0–1 */
function sampleQwDaily() {
  var days = [], i;
  for (i = 0; i < 5; i++) {
    days.push({
      forecastStartTime: '2026-11-' + (12 + i) + 'T08:00+08:00',
      temperatureMax: { value: QW_MAX[i], unit: 'C' },
      temperatureMin: { value: QW_MIN[i], unit: 'C' },
      daytime: {
        condition: { text: QW_TEXT[i], code: QW_CODES[i] },
        precipitation: { probability: QW_POP[i] }
      },
      nighttime: {
        condition: { text: '晴', code: '150' },
        precipitation: { probability: 0 }
      }
    });
  }
  return { metadata: { lang: 'zh' }, days: days };
}

/** 和风实测的 UTC 日窗口：当地日 00:00 对应的 UTC 时刻，按天递增 5 天 */
function sampleQwUtcDaily(startDay, hourUtc) {
  var days = [], i, d;
  for (i = 0; i < 5; i++) {
    d = new Date(Date.UTC(2026, 10, startDay + i, hourUtc, 0, 0));
    days.push({
      forecastStartTime: d.toISOString().replace('.000Z', 'Z'),
      temperatureMax: { value: QW_MAX[i], unit: 'C' },
      temperatureMin: { value: QW_MIN[i], unit: 'C' },
      daytime: {
        condition: { text: QW_TEXT[i], code: QW_CODES[i] },
        precipitation: { probability: QW_POP[i] }
      },
      nighttime: {
        condition: { text: '晴', code: '150' },
        precipitation: { probability: 0 }
      }
    });
  }
  return { metadata: { lang: 'zh' }, days: days };
}

/** Open-Meteo 兜底：daily.* 并列数组，pop 本身已是百分数 */
function sampleOmDaily() {
  return {
    daily: {
      time: ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'],
      weather_code: [0, 61, 71, 45, 95],
      temperature_2m_max: [18, 15, 2, 9, 22],
      temperature_2m_min: [9, 7, -3, 3, 14],
      precipitation_probability_max: [10, 80, 60, 20, 90]
    }
  };
}

function isQw(url) { return url.indexOf(QW_PATH) >= 0; }

/** handler(url, index, opts) 返回上游 JSON，或抛错模拟该源失败 */
function makeCtx(handler, opts) {
  opts = opts || {};
  var calls = [];
  return {
    cfg: JSON.parse(JSON.stringify(cfg)),
    calls: calls,
    secrets: {
      get: function (name) {
        if (name === 'qweatherHost') return opts.noHost ? '' : QW_HOST;
        if (name === 'qweatherKey') return opts.noKey ? '' : QW_KEY;
        return '';
      }
    },
    http: {
      getJson: function (url, o) {
        calls.push({ url: url, opts: o || {} });
        return Promise.resolve().then(function () { return handler(url, calls.length, o || {}); });
      }
    }
  };
}
function okHandler(url) { return isQw(url) ? sampleQwDaily() : sampleOmDaily(); }
function okCtx(opts) { return makeCtx(okHandler, opts); }
function urls(ctx) { return ctx.calls.map(function (c) { return c.url; }); }
function count(ctx, pred) { return urls(ctx).filter(pred).length; }

console.log('天气 fetcher 自检（和风 v1 主 + Open-Meteo 备）');

/* ---------------- 两套码表 ---------------- */

check('Open-Meteo WMO 数值码归并到线条图标类别（含未知码兜底 na）', function () {
  var cases = [
    [0, 'sun'], [1, 'cloud'], [2, 'cloud'], [3, 'overcast'],
    [45, 'fog'], [48, 'fog'],
    [51, 'rain'], [61, 'rain'], [65, 'rain'], [80, 'rain'], [82, 'rain'],
    [71, 'snow'], [77, 'snow'], [85, 'snow'], [86, 'snow'],
    [95, 'storm'], [96, 'storm'], [99, 'storm'],
    [777, 'na'], [null, 'na']
  ];
  for (var i = 0; i < cases.length; i++) {
    eq(fetchWeather.categoryOf(cases[i][0]), cases[i][1], 'code=' + cases[i][0]);
  }
  return cases.length + ' 个码覆盖 7 类 + na';
});

check('和风 v1 condition.code 码表：4xx 雪 / 5xx 雾 / 900+ 未知 / 404–406 雨夹雪归雨', function () {
  var cases = [
    ['100', 'sun'], ['150', 'sun'],
    ['101', 'cloud'], ['153', 'cloud'], ['200', 'cloud'], ['213', 'cloud'],
    ['104', 'overcast'], ['154', 'overcast'],
    ['302', 'storm'], ['304', 'storm'],
    ['300', 'rain'], ['305', 'rain'], ['399', 'rain'],
    ['404', 'rain'], ['406', 'rain'],
    ['401', 'snow'], ['499', 'snow'],
    ['501', 'fog'], ['515', 'fog'],
    ['900', 'na'], ['901', 'na'], ['999', 'na'], [null, 'na'], ['abc', 'na']
  ];
  for (var i = 0; i < cases.length; i++) {
    eq(fetchWeather.qwCategoryOf(cases[i][0]), cases[i][1], 'code=' + cases[i][0]);
  }
  return cases.length + ' 个码覆盖 7 类 + na';
});

check('昼夜两个 condition 按权重取更显著者（雷 > 雪 > 雨 > 雾 > 阴 > 云 > 晴 > na）', function () {
  var a = {
    daytime: { condition: { text: '晴', code: '100' } },
    nighttime: { condition: { text: '雷', code: '302' } }
  };
  var b = {
    daytime: { condition: { text: '雪', code: '401' } },
    nighttime: { condition: { text: '晴', code: '150' } }
  };
  eq(I.qwPickCondition(a).code, '302', '夜间雷应压过白天晴');
  eq(I.qwPickCondition(b).code, '401', '白天雪应压过夜间晴');
  eq(I.qwPickCondition({ daytime: { condition: { code: '100' } } }).code, '100', '只有白天');
  eq(I.qwPickCondition({}), null, '两边都没有 condition 时返回 null');
  return 'storm=7 > sun=1，snow=6 > sun=1';
});

/* ---------------- 两套解析器 ---------------- */

check('和风逐日解析：{value,unit} 温度、0–1 概率→百分数、5 天 × 9 字段', function () {
  var days = I.parseQwDays(sampleQwDaily(), 5);
  eq(days.length, 5, '天数');
  eq(days[0].date, '2026-11-12', '未传时区时回退取前 10 位');
  eq(days[0].dateShort, '11/12', '短日期');
  eq(days[0].label, '今天', '第 1 天标签');
  eq(days[2].label, '后天', '第 3 天标签');
  eq(Object.keys(days[0]).length, 9, '每日字段数');
  eq(days[0].max, 18, 'temperatureMax.value');
  eq(days[0].min, 9, 'temperatureMin.value');
  eq(days[0].pop, 10, '0.1 → 10%');
  eq(days[1].pop, 80, '0.8 → 80%');
  eq(days[4].pop, 90, '0.9 → 90%');
  eq(days[0].text, '晴', 'condition.text');
  eq(days[0].code, 100, 'condition.code 转数字');
  eq(days[0].category, 'sun', '图标类别');
  eq(days[1].category, 'rain', '雨');
  eq(days[2].category, 'snow', '雪');
  eq(days[3].category, 'fog', '雾');
  eq(days[4].category, 'storm', '雷');
  return '和风对象结构按实测解析，不按文档假设的扁平字段';
});

check('两套解析器输出完全同形的 day 字段（前端零改动的前提）', function () {
  var a = I.parseQwDays(sampleQwDaily(), 5)[0];
  var b = I.parseOmDays(sampleOmDaily(), 5)[0];
  eq(Object.keys(a).sort().join(','), Object.keys(b).sort().join(','), '字段集合');
  eq(a.date, b.date, '日期');
  eq(a.label, b.label, '标签');
  eq(a.max, b.max, '最高温');
  eq(a.min, b.min, '最低温');
  eq(a.pop, b.pop, '降水概率');
  eq(a.category, b.category, '图标类别');
  return '两个 provider 只经 makeDay 出口';
});

check('forecastDays 可截断上游多给的天数', function () {
  eq(I.parseQwDays(sampleQwDaily(), 3).length, 3, '和风取前 3 天');
  eq(I.parseOmDays(sampleOmDaily(), 3).length, 3, 'OM 取前 3 天');
  return 'Math.min(上游长度, forecastDays)';
});

check('UTC 日窗口换算成各城市当地日期：东八区不再整体早一天', function () {
  var ctx = makeCtx(function (url) {
    if (!isQw(url)) return sampleOmDaily();
    return url.indexOf('121.4737') >= 0
      ? sampleQwUtcDaily(14, 16)   // 11/14T16:00Z = 北京 11/15 00:00
      : sampleQwUtcDaily(15, 5);   // 11/15T05:00Z = UTC-5 11/15 00:00
  });
  return fetchWeather(ctx).then(function (r) {
    eq(r.cities[0].days[0].date, '2026-11-15', '东八区首列日期');
    eq(r.cities[0].days[0].dateShort, '11/15', '东八区短日期');
    eq(r.cities[0].days[0].label, '今天', '首列标签');
    eq(r.cities[0].days[4].date, '2026-11-19', '东八区第 5 天');
    eq(r.cities[1].days[0].date, '2026-11-15', 'UTC-5 首列日期');
    eq(r.cities[1].days[0].dateShort, '11/15', 'UTC-5 短日期');
    return 'city.timezone 经 buildSteps → fetchOne → parseQwDays 全程透传';
  });
});

check('localDateOf：无时区 / 无效时区 / 坏日期安全回退', function () {
  eq(I.localDateOf('2026-11-14T16:00Z', null), '2026-11-14', '无时区回退前 10 位');
  eq(I.localDateOf('2026-11-14T16:00Z', 'Not/AZone'), '2026-11-14', '无效时区回退');
  eq(I.localDateOf('oops', 'Asia/Shanghai'), 'oops', '日期不可解析回退');
  eq(I.localDateOf('2026-11-14T16:00Z', 'Asia/Shanghai'), '2026-11-15', '有效时区换算');
  return 'Intl.RangeError 被 catch，不会击穿 Promise.all';
});

check('天气文案：中文保留 5 字上限，英文/空文案按 code 类别给中文短词', function () {
  eq(I.qwText('雨夹雪', 404), '雨夹雪', '中文原文');
  eq(I.qwText('很长的中文天气文案', 100), '很长的中文', '中文截 5 字');
  eq(I.qwText('Moderate rain', 404), '雨', '英文不再截成 Moder');
  eq(I.qwText('Sleet', 401), '雪', '英文按 4xx 归雪');
  eq(I.qwText('', 100), '晴', '空文案按 100 归晴');
  eq(I.qwText('', 999), '未知', '未知码');
  return 'lang=zh 主路径 + ASCII 兜底双保险';
});

/* ---------------- 请求链构造 ---------------- */

check('请求链顺序：和风 → OM 主 → OM 备，只有和风带认证头', function () {
  var ctx = okCtx();
  var w = ctx.cfg.blocks.weather;
  var steps = I.buildSteps(ctx, w, w.cities[0], 5, w.providerChain);
  eq(steps.length, 3, '链长');
  truthy(isQw(steps[0].url), '第 1 步应是和风');
  eq(steps[0].headers['X-QW-Api-Key'], QW_KEY, '和风带认证头');
  eq(steps[1].url.indexOf(w.endpoint), 0, '第 2 步应是 OM 主域名');
  eq(steps[2].url.indexOf(w.fallbackEndpoint), 0, '第 3 步应是 OM 备域名');
  eq(steps[1].headers, null, 'OM 不带和风认证头');
  return 'providerChain 逐项展开成逐城请求队列';
});

check('和风请求：路径纬度在前、days=5&lang=zh、X-QW-Api-Key 头，URL 不含 key', function () {
  var ctx = okCtx();
  return fetchWeather(ctx).then(function () {
    var c0 = ctx.calls[0], c1 = ctx.calls[1];
    truthy(/^https:\/\/example\.qweather\.test\/weather\/v1\/daily\/31\.2304\/121\.4737\?days=5&lang=zh$/.test(c0.url),
      '甲城 URL 不符: ' + c0.url);
    truthy(/\/weather\/v1\/daily\/40\.7128\/-74\.006\?days=5&lang=zh$/.test(c1.url),
      '乙城 URL 不符: ' + c1.url);
    truthy(c0.url.indexOf('lang=zh') >= 0 && c1.url.indexOf('lang=zh') >= 0,
      '两城都必须显式请求中文天气文案');
    eq(c0.opts.headers['X-QW-Api-Key'], QW_KEY, '认证头');
    eq(c0.url.indexOf(QW_KEY), -1, 'key 不应拼进 URL');
    eq(c0.opts.timeoutMs, 10000, '超时');
    return '纬度在前；凭据只走请求头';
  });
});

check('和风成功时逐城只请求 1 次，完全不打 Open-Meteo', function () {
  var ctx = okCtx();
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities.length, 2, '城市数');
    eq(d.defaultCity, 'cityA', '默认地区');
    eq(d.cities[0].key, cfg.board.zones[0].id, '甲城 key 对齐 zones');
    eq(d.cities[1].key, cfg.board.zones[1].id, '乙城 key 对齐 zones');
    eq(d.cities[0].ok, true, '甲城 ok');
    eq(d.cities[1].ok, true, '乙城 ok');
    eq(d.cities[0].days.length, 5, '甲城 5 天');
    eq(d.cities[1].days.length, 5, '乙城 5 天');
    eq(ctx.calls.length, 2, '总请求数');
    eq(count(ctx, isQw), 2, '和风请求数');
    eq(count(ctx, function (u) { return u.indexOf('open-meteo') >= 0; }), 0, '不应请求 OM');
    return '主源命中即停，省掉 4 次外网请求';
  });
});

check('未配置 providerChain 时默认 qweather → open-meteo', function () {
  eq(I.DEFAULT_CHAIN.join(','), 'qweather,open-meteo', '默认链');
  var ctx = okCtx();
  delete ctx.cfg.blocks.weather.providerChain;
  return fetchWeather(ctx).then(function (d) {
    eq(count(ctx, isQw), 2, '和风仍为主源');
    eq(d.cities[0].ok, true, '甲城');
    return '向后兼容旧 config.json';
  });
});

check('providerChain 里的未知项被忽略，仍能取到数', function () {
  var ctx = okCtx();
  ctx.cfg.blocks.weather.providerChain = ['mystery-source', 'qweather', 'open-meteo'];
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities[0].ok, true, '甲城');
    eq(count(ctx, isQw), 2, '和风仍被调用');
    return '未知 provider 不产生请求、不抛错';
  });
});

/* ---------------- 回退与失败隔离 ---------------- */

check('和风失败时逐城回退到 Open-Meteo 主域名，两城仍拿到 5 天', function () {
  var ctx = makeCtx(function (url) {
    if (isQw(url)) throw new Error('qweather 503');
    return sampleOmDaily();
  });
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities[0].ok, true, '甲城应经回退成功');
    eq(d.cities[1].ok, true, '乙城应经回退成功');
    eq(d.cities[0].days.length, 5, '甲城天数');
    eq(ctx.calls.length, 4, '每城 和风 1 次 + OM 主 1 次');
    eq(count(ctx, isQw), 2, '和风尝试数');
    eq(count(ctx, function (u) { return u.indexOf(cfg.blocks.weather.endpoint) === 0; }), 2, 'OM 主请求数');
    eq(d.cities[0].days[0].text, '晴', '应走 OM 解析器');
    eq(d.cities[0].days[0].pop, 10, 'OM 的 pop 已是百分数，不再 ×100');
    return '主源不可达 → 备源同形 DTO';
  });
});

check('和风与 OM 主都失败时继续回退 fallbackEndpoint', function () {
  var primary = cfg.blocks.weather.endpoint;
  var fallback = cfg.blocks.weather.fallbackEndpoint;
  var ctx = makeCtx(function (url) {
    if (isQw(url)) throw new Error('qweather down');
    if (url.indexOf(primary) === 0) throw new Error('primary down');
    return sampleOmDaily();
  });
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities[0].ok, true, '甲城');
    eq(d.cities[1].ok, true, '乙城');
    eq(ctx.calls.length, 6, '每城 3 次');
    eq(count(ctx, function (u) { return u.indexOf(fallback) === 0; }), 2, '备域名请求数');
    return '三级回退全链路';
  });
});

check('和风返回坏结构时按上游失败处理并回退，不再击穿 Promise.all', function () {
  var ctx = makeCtx(function (url) {
    if (isQw(url)) return { days: [] };
    return sampleOmDaily();
  });
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities[0].ok, true, '甲城应回退成功');
    eq(d.cities[0].days.length, 5, '甲城天数');
    eq(ctx.calls.length, 4, '每城应各试 和风 / OM 主');
    return '响应结构异常也继续回退';
  });
});

check('未配置 qweatherKey 或 qweatherHost 时跳过和风，直接走 Open-Meteo', function () {
  var cases = [{ noKey: true }, { noHost: true }];
  return Promise.all(cases.map(function (o) {
    var ctx = okCtx(o);
    return fetchWeather(ctx).then(function (d) {
      eq(d.cities[0].ok, true, '甲城');
      eq(count(ctx, isQw), 0, '不应请求和风');
      eq(ctx.calls.length, 2, '每城只打 OM 主 1 次');
      eq(urls(ctx)[0].indexOf(cfg.blocks.weather.endpoint), 0, '首请求应是 OM 主');
    });
  })).then(function () { return '缺任一凭据都安全降级，不抛 no weather source'; });
});

check('未配置 fallbackEndpoint 向后兼容（每城 和风 + OM 主各一次）', function () {
  var ctx = makeCtx(function (url) {
    if (isQw(url)) throw new Error('qweather down');
    return sampleOmDaily();
  });
  delete ctx.cfg.blocks.weather.fallbackEndpoint;
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities[0].ok, true, '甲城');
    eq(d.cities[1].ok, true, '乙城');
    eq(ctx.calls.length, 4, '每城 2 次');
    return '旧 config.json 不多请求';
  });
});

check('OM 请求仍带显式 timezone / 坐标 / forecast_days', function () {
  var ctx = makeCtx(function (url) {
    if (isQw(url)) throw new Error('qweather down');
    return sampleOmDaily();
  });
  return fetchWeather(ctx).then(function () {
    var om = urls(ctx).filter(function (u) { return !isQw(u); });
    var a = om[0], b = om[1];
    truthy(/timezone=Asia%2FShanghai/.test(a), '甲城未带 IANA 时区');
    truthy(/timezone=America%2FNew_York/.test(b), '乙城未带 IANA 时区');
    truthy(/latitude=31\.2304/.test(a) && /longitude=121\.4737/.test(a), '甲城坐标不对');
    truthy(/latitude=40\.7128/.test(b) && /longitude=-74\.006/.test(b), '乙城坐标不对');
    truthy(/forecast_days=5/.test(a) && /forecast_days=5/.test(b), '预报天数不是 5');
    truthy(/daily=weather_code,temperature_2m_max/.test(b), 'daily 参数缺失');
    return '显式 timezone（跨 DST 必需）';
  });
});

check('单城全链失败：另一城照常下发，且打 __stale 让聚合器保留旧数据', function () {
  var ctx = makeCtx(function (url) {
    if (url.indexOf('40.7128') >= 0) throw new Error('cityB all sources down');
    return okHandler(url);
  });
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities[0].ok, true, '甲城成功');
    eq(d.cities[0].days.length, 5, '甲城天数');
    eq(d.cities[1].ok, false, '乙城失败');
    eq(d.cities[1].days.length, 0, '失败城市无预报');
    truthy(/all sources down/.test(d.cities[1].error), '错误摘要来自最后一次尝试');
    eq(d.__stale, true, '部分成功应打 __stale');
    truthy(/partial weather: 1\/2/.test(d.__staleReason), '原因应写明 1/2');
    eq(ctx.calls.length, 4, '乙城试满 3 条链 + 甲城 1 次');
    return '修复「一城成功即 hard ok、失败城 3 小时不自愈」';
  });
});

check('全部城市成功时绝不带 __stale（不触发无谓的 10 分钟重刷）', function () {
  var ctx = okCtx();
  return fetchWeather(ctx).then(function (d) {
    eq(typeof d.__stale, 'undefined', '不应有 __stale');
    eq(typeof d.__staleReason, 'undefined', '不应有 __staleReason');
    return '硬成功 → 正常 3 小时 TTL';
  });
});

check('全城失败时 reject，交给聚合器 stale 软分支', function () {
  var ctx = makeCtx(function () { throw new Error('all upstream down'); });
  var rejected = false;
  return fetchWeather(ctx).then(function () {
    throw new Error('全失败时不应 resolve');
  }, function (e) {
    rejected = true;
    truthy(/all weather cities failed/.test(e.message), '错误信息');
  }).then(function () {
    eq(rejected, true, '未触发 reject');
    eq(ctx.calls.length, 6, '两城各试满 3 条链');
    return 'reject → stale 软分支';
  });
});

check('板块 disabled 或 cities 为空时安全返回空结构', function () {
  var ctx = okCtx();
  ctx.cfg.blocks.weather.enabled = false;
  return fetchWeather(ctx).then(function (d) {
    eq(d.disabled, true, 'disabled 标记');
    eq(d.cities.length, 0, 'cities 应为空');
    eq(ctx.calls.length, 0, '不应发起网络请求');
    return '不请求、不抛错';
  });
});

/* ---------------- DTO 与服务端契约 ---------------- */

check('DTO 字段白名单：不含 Host / Key / providerChain / 任何凭据', function () {
  var ctx = okCtx();
  return fetchWeather(ctx).then(function (d) {
    eq(Object.keys(d).sort().join(','), 'cities,defaultCity,provider', '顶层字段');
    eq(Object.keys(d.cities[0]).sort().join(','), 'days,error,key,lat,lon,name,ok,timezone', 'city 字段');
    eq(Object.keys(d.cities[0].days[0]).length, 9, 'day 字段数');
    var blob = JSON.stringify(d).toLowerCase();
    ['ak', 'sk', 'secret', 'token', 'password', 'authorization', 'apikey',
      'qweatherhost', 'qweatherkey', 'x-qw-api-key', 'providerchain'].forEach(function (k) {
      eq(blob.indexOf('"' + k + '"'), -1, 'DTO 含敏感键 ' + k);
    });
    eq(blob.indexOf(QW_HOST.toLowerCase()), -1, 'DTO 含上游 Host');
    eq(blob.indexOf(QW_KEY.toLowerCase()), -1, 'DTO 含 Key');
    return '白名单投影，前端 board.js 零改动';
  });
});

check('http-util.getJson 透明解压 gzip（和风忽略 identity 强制压缩）', function () {
  var src = fs.readFileSync(path.join(__dirname, 'http-util.js'), 'utf8');
  truthy(/gunzipSync\(body\)/.test(src), '缺少 gunzip 解压');
  truthy(/0x1f && body\[1\] === 0x8b/.test(src), '缺少 gzip 魔数兜底');
  truthy(/content-encoding/.test(src), '缺少响应头判断');
  return '其它 fetcher 无需感知压缩';
});

check('聚合器：__stale 经 cleanInternal 剥离，并走 10 分钟重试软分支', function () {
  var src = fs.readFileSync(path.join(__dirname, 'aggregator.js'), 'utf8');
  truthy(/var wait = e\.stale \? Math\.min\(ttl, 10 \* 60 \* 1000\) : ttl;/.test(src),
    '重试间隔仍是 10 分钟');
  truthy(!/\(e\.stale && e\.updatedAt > 0\)/.test(src), '旧的 3 小时盲区写法仍在');
  truthy(/k\.indexOf\('__'\) !== 0/.test(src), 'cleanInternal 应剥离 __ 内部字段');
  truthy(/var soft = !!\(raw && raw\.__stale\);/.test(src), '软失败判定');
  truthy(/if \(!e\.data\) e\.data = data;/.test(src), '软分支保留旧数据');
  truthy(/\['agenda', 'quota', 'weather'\]/.test(src), '凭据变化应重取 weather');
  return '失败城市最迟 10 分钟自愈';
});

Promise.all(pending).then(function () {
  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
});
