'use strict';

/**
 * 聚合器：每板块独立的 TTL 刷新、失败隔离、stale 标记、最后成功时间。
 *
 * 契约（/api/board.json）：
 *   blocks[id] = { ok, stale, updatedAt, lastAttemptAt, data, error }
 *   - 成功：ok=true, stale=false, updatedAt=本次成功时刻
 *   - 硬失败（网络/解析异常）：保留上一次成功的 data，stale=true，error=脱敏后的原因，
 *     updatedAt 保持不变（即「最后成功更新时间」）
 *   - 软失败（fetcher 返回 __stale，如每日内容全网不可达但有内置回退）：
 *     内容可用但 stale=true，updatedAt 不推进
 *   - realtime 板块（clock/lunar）每次请求时同步重算，不进缓存队列
 *
 * 浏览器只需 XHR 拉这份 JSON，不整页 reload；服务端也绝不把上游 URL / key / 凭据写进来。
 */

var cfg = require('../config.json');
var blocks = require('./blocks');
var secrets = require('./secrets');
var http = require('./http-util');

var ALLOWED = ['ok', 'stale', 'updatedAt', 'lastAttemptAt', 'data', 'error'];
var state = {};
var startedAt = Date.now();
var lastFullRefresh = 0;
var lastCredSig = '';
var tickTimer = null;

var ctx = {
  cfg: cfg,
  secrets: secrets,
  http: http,
  log: function (s) { console.log(s); }
};

function blank() {
  return {
    ok: false, stale: true, updatedAt: 0, lastAttemptAt: 0,
    data: null, error: '尚未取数', inflight: false
  };
}

function init() {
  blocks.list().forEach(function (b) { state[b.id] = blank(); });
}

function cleanInternal(data) {
  if (!data || typeof data !== 'object') return data;
  var copy = {};
  Object.keys(data).forEach(function (k) {
    if (k.indexOf('__') !== 0) copy[k] = data[k];
  });
  return copy;
}

function refreshOne(id, quiet) {
  var b = blocks.byId[id];
  var e = state[id];
  if (!b || !e || e.inflight || b.realtime) return Promise.resolve(null);

  e.inflight = true;
  e.lastAttemptAt = Date.now();
  var t0 = Date.now();

  return Promise.resolve()
    .then(function () { return b.fetcher(ctx); })
    .then(function (raw) {
      var soft = !!(raw && raw.__stale);
      var reason = raw && raw.__staleReason ? String(raw.__staleReason) : '上游降级';
      var data = cleanInternal(raw);

      e.inflight = false;
      if (soft) {
        // 软失败：内容可用，但不推进「最后成功时间」，并标记过期
        if (!e.data) e.data = data;
        e.ok = true;
        e.stale = true;
        e.error = reason;
        if (!quiet) console.log('[board] ' + id + ' degraded (' + (Date.now() - t0) + 'ms): ' + reason);
      } else {
        e.data = data;
        e.ok = true;
        e.stale = false;
        e.error = '';
        e.updatedAt = Date.now();
        if (!quiet) console.log('[board] ' + id + ' ok (' + (Date.now() - t0) + 'ms)');
      }
      return e;
    })
    .catch(function (err) {
      e.inflight = false;
      e.ok = e.data !== null;      // 有旧内容就仍然可展示
      e.stale = true;
      e.error = http.errText(err);
      if (!quiet) console.warn('[board] ' + id + ' stale (' + (Date.now() - t0) + 'ms): ' + e.error);
      return e;
    });
}

function refreshAll(quiet) {
  var jobs = blocks.list().filter(function (b) { return !b.realtime; })
    .map(function (b) { return refreshOne(b.id, quiet); });
  lastFullRefresh = Date.now();
  return Promise.all(jobs);
}

/** 凭据从无到有（或改动）后最多 30 秒自动重取，不必等满 3 小时、也不必手动重启 */
function checkCredentials() {
  var sig = secrets.signature();
  if (lastCredSig && sig !== lastCredSig) {
    console.log('[board] 凭据状态变化 → 立即重取 agenda / quota');
    ['agenda', 'quota'].forEach(function (id) { if (state[id]) refreshOne(id, false); });
  }
  lastCredSig = sig;
}

/** 每 30 秒检查一次：正常按 ttl，失败后缩短重试（但不超过 ttl，避免打爆上游） */
function tick() {
  var now = Date.now();
  var staleRatio = cfg.board.staleAfterRatio || 1.5;

  checkCredentials();
  blocks.list().forEach(function (b) {
    if (b.realtime) return;
    var e = state[b.id];
    if (!e) return;
    var ttl = b.ttl || cfg.board.refreshMs;

    // 长时间没成功（例如定时器被挂起）：即使没有显式失败也要标过期
    if (e.updatedAt > 0 && !e.stale && (now - e.updatedAt) > ttl * staleRatio) {
      e.stale = true;
      e.error = '已超过 ' + Math.round(ttl * staleRatio / 3600000) + ' 小时未成功更新';
    }
    if (e.inflight) return;
    var wait = (e.stale && e.updatedAt > 0) ? Math.min(ttl, 10 * 60 * 1000) : ttl;
    var base = e.lastAttemptAt || 0;
    if (now - base >= wait) refreshOne(b.id, true);
  });
}

function start() {
  var budget = blocks.validateBudget();   // 超预算直接抛错，服务不启动
  init();
  console.log('[board] 单屏预算: ' + budget.used + '/' + budget.budget + ' rows @ ' + budget.rowPx + 'px');
  console.log('[board] 板块: ' + blocks.list().map(function (b) { return b.id + '(' + b.rows + ')'; }).join(' + '));
  lastCredSig = secrets.signature();
  refreshAll(false);
  tickTimer = setInterval(tick, 30000);
  tick();
  return budget;
}

/** 优雅退出：systemd 发 SIGTERM，别让定时器挡住进程退出 */
function stop() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

function realtime(id) {
  var b = blocks.byId[id];
  var e = state[id];
  if (!b || !b.realtime || typeof b.fetcher.sync !== 'function') return e;
  try {
    e.data = b.fetcher.sync();
    e.ok = true;
    e.stale = false;
    e.error = '';
    e.updatedAt = Date.now();
  } catch (err) {
    e.ok = e.data !== null;
    e.stale = true;
    e.error = secrets.redact(err.message);
  }
  return e;
}

/** 字段白名单：state 里的 inflight 等内部字段一律不下发 */
function project(e) {
  var out = {};
  ALLOWED.forEach(function (k) { out[k] = null; });
  out.ok = !!e.ok;
  out.stale = !!e.stale;
  out.updatedAt = e.updatedAt || 0;
  out.lastAttemptAt = e.lastAttemptAt || 0;
  out.data = e.data === undefined ? null : e.data;
  out.error = e.error || '';
  return out;
}

function payload() {
  var out = {};
  var list = blocks.list();
  var clockData = null;
  var i, b;
  // 前端额度板块的列表行数由配置推导，增删 provider 不必改前端骨架
  var q = cfg.blocks.quota || {};
  var quotaRows = (q.providers || []).length + (q.cloudProviders || []).length;
  // 条件格式阈值随 DTO 下发，便于诊断「为什么这一行加粗」；判定在服务端已完成
  var lowThreshold = (typeof cfg.board.lowBalanceThreshold === 'number' &&
    isFinite(cfg.board.lowBalanceThreshold)) ? cfg.board.lowBalanceThreshold : 500;

  for (i = 0; i < list.length; i++) {
    b = list[i];
    if (b.realtime) realtime(b.id);
    out[b.id] = project(state[b.id]);
    if (b.id === 'clock' && state.clock.data) clockData = state.clock.data;
  }

  return {
    generatedAt: Date.now(),
    nowUtcMs: clockData ? clockData.nowUtcMs : Date.now(),
    nextDstTransitionUtc: clockData ? clockData.nextDstTransitionUtc : null,
    refreshMs: cfg.board.refreshMs,
    browserPollMs: cfg.board.browserPollMs,
    server: {
      title: cfg.board.title,
      layout: blocks.meta(),
      budget: blocks.validateBudget(),
      statusMode: cfg.board.statusMode || 'auto',
      weatherDays: (cfg.blocks.weather && cfg.blocks.weather.forecastDays) || 5,
      quotaRows: quotaRows,
      lowBalanceThreshold: lowThreshold,
      startedAt: startedAt,
      lastFullRefresh: lastFullRefresh,
      credentials: secrets.status()
    },
    blocks: out
  };
}

function status() {
  var s = {};
  // realtime 板块不进定时刷新队列，健康检查时也实时算一次，别显示「尚未取数」
  blocks.list().forEach(function (b) { if (b.realtime) realtime(b.id); });
  Object.keys(state).forEach(function (id) {
    var e = state[id];
    s[id] = {
      ok: !!e.ok, stale: !!e.stale,
      updatedAt: e.updatedAt || 0,
      lastAttemptAt: e.lastAttemptAt || 0,
      error: e.error || ''
    };
  });
  return {
    ok: true,
    at: Date.now(),
    uptimeMs: Date.now() - startedAt,
    budget: blocks.validateBudget(),
    credentials: secrets.status(),
    blocks: s
  };
}

/** 手动刷新：是否允许「局域网远端」触发由 HTTP 层按来源 IP 判断，这里只管干活 */
function forceRefresh() {
  return refreshAll(false).then(function () {
    return { ok: true, at: Date.now(), blocks: status().blocks };
  });
}

module.exports = {
  start: start,
  stop: stop,
  payload: payload,
  status: status,
  refreshOne: refreshOne,
  forceRefresh: forceRefresh
};
