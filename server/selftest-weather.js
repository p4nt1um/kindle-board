'use strict';

/**
 * 天气 fetcher 回归：用 mock 的 ctx.http 真正执行 server/fetchers/weather.js，
 * 不发起任何网络请求、不需要任何凭据。
 *
 *   node server/selftest-weather.js
 *
 * 覆盖：WMO→线条图标类别归并、两地取数、每日字段形状、timezone 参数、
 *       单城失败隔离、全失败交给聚合器 stale、DTO 字段白名单（不含凭据）、
 *       主备 endpoint 自动回退、聚合器「从未成功」的重试间隔。
 */

var fs = require('fs');
var path = require('path');
var fetchWeather = require('./fetchers/weather');
/* 自检不读取本机 config.json：内置一份通用示例配置，
   既避免把真实地点 / 坐标带入仓库，也保证在任何机器上结果一致。 */
var cfg = {
  board: {
    zones: [
      { id: 'shanghai', label: '上海', timeZone: 'Asia/Shanghai' },
      { id: 'newyork', label: '美国东部', timeZone: 'America/New_York' }
    ]
  },
  blocks: {
    weather: {
      enabled: true,
      provider: 'open-meteo',
      endpoint: 'https://historical-forecast-api.open-meteo.com/v1/forecast',
      fallbackEndpoint: 'https://api.open-meteo.com/v1/forecast',
      defaultCity: 'shanghai',
      forecastDays: 5,
      cities: [
        { key: 'shanghai', name: '上海', latitude: 31.2304, longitude: 121.4737, timezone: 'Asia/Shanghai' },
        { key: 'newyork', name: '纽约', latitude: 40.7128, longitude: -74.0060, timezone: 'America/New_York' }
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

function sampleDaily() {
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

/** handler(url, index) 返回 daily 对象，或抛错模拟上游失败 */
function makeCtx(handler) {
  var urls = [];
  return {
    cfg: JSON.parse(JSON.stringify(cfg)),
    urls: urls,
    http: {
      getJson: function (url) {
        urls.push(url);
        return Promise.resolve().then(function () { return handler(url, urls.length); });
      }
    }
  };
}

function okCtx() {
  return makeCtx(function () { return sampleDaily(); });
}

console.log('天气 fetcher 自检');

check('WMO 数值码归并到线条图标类别（含未知码兜底 na）', function () {
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

check('两地取数：cities 长度 2、key 对齐 zones、defaultCity 默认上海', function () {
  var ctx = okCtx();
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities.length, 2, '城市数');
    eq(d.defaultCity, 'shanghai', '默认地区');
    eq(d.cities[0].key, cfg.board.zones[0].id, 'shanghai key');
    eq(d.cities[1].key, cfg.board.zones[1].id, 'newyork key');
    eq(d.cities[1].name, '纽约', '第二地区显示名');
    eq(d.cities[0].ok, true, '上海 ok');
    eq(d.cities[1].ok, true, '纽约 ok');
    return 'shanghai / newyork(纽约)';
  });
});

check('每地 5 天，且每天含 code / category / text / max / min / pop', function () {
  var ctx = okCtx();
  return fetchWeather(ctx).then(function (d) {
    var dayKeys = ['date', 'dateShort', 'label', 'text', 'code', 'category', 'max', 'min', 'pop'];
    d.cities.forEach(function (c) {
      eq(c.days.length, 5, c.key + ' 天数');
      eq(Object.keys(c.days[0]).length, dayKeys.length, c.key + ' 每日字段数');
      dayKeys.forEach(function (k) {
        truthy(Object.prototype.hasOwnProperty.call(c.days[0], k), c.key + ' 缺字段 ' + k);
      });
      eq(c.days[0].label, '今天', c.key + ' 第 1 天标签');
      eq(c.days[1].label, '明天', c.key + ' 第 2 天标签');
      eq(c.days[2].label, '后天', c.key + ' 第 3 天标签');
      eq(c.days[0].text, '晴', c.key + ' 中文天气');
      eq(c.days[0].code, 0, c.key + ' WMO code');
      eq(c.days[0].category, 'sun', c.key + ' 图标类别');
      eq(c.days[0].max, 18, c.key + ' 最高温');
      eq(c.days[0].min, 9, c.key + ' 最低温');
    });
    return '5 天 × 9 字段，类别可驱动 CSS 图标';
  });
});

check('两地的请求都带显式 timezone / 坐标 / forecast_days', function () {
  var ctx = okCtx();
  return fetchWeather(ctx).then(function () {
    eq(ctx.urls.length, 2, '请求数');
    var a = ctx.urls[0], b = ctx.urls[1];
    truthy(/timezone=Asia%2FShanghai/.test(a), '上海未带 IANA 时区');
    truthy(/timezone=America%2FNew_York/.test(b), '纽约 未带 Eastern 时区');
    truthy(/latitude=31\.2304/.test(a) && /longitude=121\.4737/.test(a), '上海坐标不对');
    truthy(/latitude=40\.7128/.test(b) && /longitude=-74\.006/.test(b), '纽约 坐标不对');
    truthy(/forecast_days=5/.test(a) && /forecast_days=5/.test(b), '预报天数不是 5');
    truthy(/daily=weather_code,temperature_2m_max/.test(b), 'daily 参数缺失');
    return '显式 timezone（美东跨 DST 必需）';
  });
});

check('单城失败隔离：一地返回空 days + ok=false，另一地照常下发', function () {
  var ctx = makeCtx(function (url) {
    if (url.indexOf('40.7128') >= 0) throw new Error('mock upstream timeout');
    return sampleDaily();
  });
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities.length, 2, '城市数');
    eq(d.cities[0].ok, true, '上海应成功');
    eq(d.cities[0].days.length, 5, '上海天数');
    eq(d.cities[1].ok, false, '纽约 应标记失败');
    eq(d.cities[1].days.length, 0, '失败城市应无预报');
    truthy(/timeout/.test(d.cities[1].error), '错误摘要未透出');
    return '失败不拖垮另一地';
  });
});

check('全城失败时 reject，交给聚合器 state.__stale 保留上次成功缓存', function () {
  var ctx = makeCtx(function () { throw new Error('all upstream down'); });
  var rejected = false;
  return fetchWeather(ctx).then(function () {
    throw new Error('全失败时不应 resolve');
  }, function (e) {
    rejected = true;
    truthy(/all weather cities failed/.test(e.message), '错误信息');
    return 'reject → stale 软分支';
  }).then(function () {
    eq(rejected, true, '未触发 reject');
    return 'reject → stale 软分支';
  });
});

check('DTO 字段白名单：只含展示所需字段，不含任何凭据键', function () {
  var ctx = okCtx();
  return fetchWeather(ctx).then(function (d) {
    var top = Object.keys(d).sort().join(',');
    eq(top, 'cities,defaultCity,provider', '顶层字段');
    var cityKeys = Object.keys(d.cities[0]).sort().join(',');
    eq(cityKeys, 'days,error,key,lat,lon,name,ok,timezone', 'city 字段');
    var forbidden = ['ak', 'sk', 'secret', 'token', 'password', 'authorization', 'apiKey'];
    var blob = JSON.stringify(d).toLowerCase();
    forbidden.forEach(function (k) {
      eq(blob.indexOf('"' + k + '"'), -1, 'DTO 含敏感键 ' + k);
    });
    return '白名单投影，凭据零改动';
  });
});

check('板块 disabled 或 cities 为空时安全返回空结构', function () {
  var ctx = okCtx();
  ctx.cfg.blocks.weather.enabled = false;
  return fetchWeather(ctx).then(function (d) {
    eq(d.disabled, true, 'disabled 标记');
    eq(d.cities.length, 0, 'cities 应为空');
    eq(ctx.urls.length, 0, '不应发起网络请求');
    return '不请求、不抛错';
  });
});

/* ---------------- 主备 endpoint 自动回退（2026-11-13 上游主域名不可达） ---------------- */

check('主 endpoint 失败时自动回退 fallbackEndpoint，两城仍拿到 5 天', function () {
  var primary = cfg.blocks.weather.endpoint;
  var fallback = cfg.blocks.weather.fallbackEndpoint;
  var ctx = makeCtx(function (url) {
    if (url.indexOf(primary) === 0) throw new Error('primary unreachable');
    return sampleDaily();
  });
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities[0].ok, true, '上海应经回退成功');
    eq(d.cities[1].ok, true, '纽约 应经回退成功');
    eq(d.cities[0].days.length, 5, '上海天数');
    eq(d.cities[1].days.length, 5, '纽约 天数');
    var prim = ctx.urls.filter(function (u) { return u.indexOf(primary) === 0; });
    var back = ctx.urls.filter(function (u) { return u.indexOf(fallback) === 0; });
    eq(prim.length, 2, '主 endpoint 请求数（每城一次）');
    eq(back.length, 2, '备用 endpoint 请求数（每城一次）');
    return '主 ' + primary.split('/')[2] + ' → 备 ' + fallback.split('/')[2];
  });
});

check('主 endpoint 返回坏结构时也回退，parseDays 异常不再击穿 Promise.all', function () {
  var primary = cfg.blocks.weather.endpoint;
  var ctx = makeCtx(function (url) {
    if (url.indexOf(primary) === 0) return { daily: { time: null } };
    return sampleDaily();
  });
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities[0].ok, true, '上海应回退成功');
    eq(d.cities[1].ok, true, '纽约 应回退成功');
    eq(d.cities[0].days.length, 5, '上海天数');
    eq(ctx.urls.length, 4, '每城应各试主/备两次');
    return '响应结构异常也按上游失败处理';
  });
});

check('主备都失败的一地仍单独降级，不拖垮另一地', function () {
  var primary = cfg.blocks.weather.endpoint;
  var ctx = makeCtx(function (url) {
    if (url.indexOf('40.7128') >= 0) throw new Error('mock both endpoints down');
    if (url.indexOf(primary) === 0) throw new Error('primary down');
    return sampleDaily();
  });
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities[0].ok, true, '上海应经备用成功');
    eq(d.cities[0].days.length, 5, '上海天数');
    eq(d.cities[1].ok, false, '纽约 主备全失败');
    eq(d.cities[1].days.length, 0, '失败城市无预报');
    truthy(/mock both endpoints down/.test(d.cities[1].error), '错误摘要应来自最后一次尝试');
    return '单城失败隔离在双 endpoint 下仍成立';
  });
});

check('未配置 fallbackEndpoint 时行为不变（每城只请求一次）', function () {
  var ctx = okCtx();
  delete ctx.cfg.blocks.weather.fallbackEndpoint;
  return fetchWeather(ctx).then(function (d) {
    eq(d.cities.length, 2, '城市数');
    eq(ctx.urls.length, 2, '旧配置不应多请求');
    eq(d.cities[0].ok, true, '上海');
    eq(d.cities[1].ok, true, '纽约');
    return '向后兼容旧 config.json';
  });
});

check('聚合器：从未成功过的板块也按 10 分钟重试（不再白等 3 小时）', function () {
  var src = fs.readFileSync(path.join(__dirname, 'aggregator.js'), 'utf8');
  truthy(/var wait = e\.stale \? Math\.min\(ttl, 10 \* 60 \* 1000\) : ttl;/.test(src),
    '重试间隔仍要求 updatedAt>0');
  truthy(!/\(e\.stale && e\.updatedAt > 0\)/.test(src), '旧的 3 小时盲区写法仍在');
  return '首次启动失败后最迟 10 分钟自愈';
});

Promise.all(pending).then(function () {
  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
});
