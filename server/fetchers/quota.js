'use strict';

/**
 * 额度板块（双栏右栏）：三家 AI 额度 + 三家云账户余额，共 6 行。
 *
 * AI 部分（DeepSeek / Kimi / GLM）端点多为社区逆向且经常改版，因此每家都有
 * 「主端点 → 回退端点 → 宽松解析」三层：
 *   - 结构认识时输出中文语义（剩余额度 / 用量 / 余额 / 下次重置）
 *   - 结构不认识时退回「字段名: 数值」的宽松抽取，至少不空白
 * 云账户余额（百度云 / 腾讯云 / 阿里云）需要 HMAC 签名，单独放在 cloud-balance.js，
 * 这里只负责把两组 provider 合并；任何一家失败都被自己隔离，不影响其他行。
 *
 * 所有 key / AK / SK / 签名串都只出现在 PC 侧请求头里，绝不进入返回 DTO。
 *
 * 展示规则放在服务端判定（和日程的 today 标记一个思路），前端只切 className：
 *  - 条件格式：主金额 < board.lowBalanceThreshold（默认 500）→ provider.low=true，整行加粗
 *  - 「下次重置」留在 provider.resetText，由前端把小字挂到该行下一行，不再汇总到板块底部
 */

var http = require('../http-util');

var UNIT = { 3: 'h', 5: '月', 6: '周' };   // GLM Coding Plan 常见窗口，语义以 nextResetTime 为准
var LOW_DEFAULT = 500;

function pad(n) { return (n < 10 ? '0' : '') + n; }
function num(v) { return typeof v === 'number' && isFinite(v); }
function r2(v) { return Math.round(v * 100) / 100; }
function money(v) { return '¥' + r2(v); }

function resetText(ms) {
  if (!num(ms) || ms <= 0) return '';
  var d = new Date(ms + 8 * 3600000);   // Asia/Shanghai 无 DST
  return pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + ' ' +
    pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

/** 结构不认识时的兜底：递归找 quota / remaining / usage / balance 之类的数值 */
function quotaLines(obj, out, depth, prefix) {
  if (!obj || typeof obj !== 'object' || depth > 4 || out.length >= 3) return out;
  Object.keys(obj).forEach(function (k) {
    var v = obj[k];
    var label = (prefix ? prefix + '.' : '') + k;
    if (num(v) && /remaining|left|quota|limit|usage|used|total|balance|tokens?|credits?|percent|rate/i.test(k)) {
      out.push(label.replace(/^data\./, '').replace(/[_-]/g, ' ') + ':' + r2(v));
    } else if (v && typeof v === 'object' && depth < 4) {
      quotaLines(v, out, depth + 1, label.replace(/^data\./, ''));
    }
  });
  return out;
}

/* ---------------- DeepSeek ---------------- */

function deepseek(ctx) {
  var key = ctx.secrets.get('deepseekKey');
  if (!key) return Promise.resolve({ id: 'deepseek', label: 'DeepSeek', ok: false, lines: [], error: '未配置 API Key' });
  return http.getJson('https://api.deepseek.com/user/balance', {
    headers: { Authorization: 'Bearer ' + key }, timeoutMs: ctx.cfg.blocks.quota.timeoutMs
  }).then(function (j) {
    var b = (j && j.balance_infos && j.balance_infos[0]) || {};
    var total = Number(b.total_balance);
    var topped = Number(b.topped_up_balance);
    var line = num(total) ? '余额 ' + money(total) : '已连接，无余额字段';
    // 充值额与余额相同就不重复显示；「可用」是冗余状态，只在不可用时提示
    if (num(total) && num(topped) && r2(topped) !== r2(total)) line += '（充值 ' + money(topped) + '）';
    if (j && j.is_available === false) line += ' · 不可用';
    return { id: 'deepseek', label: 'DeepSeek', ok: true, lines: [line] };
  }).catch(function (e) {
    return { id: 'deepseek', label: 'DeepSeek', ok: false, lines: [], error: http.errText(e) };
  });
}

/* ---------------- Kimi（先试 Coding 用量，再回退 Moonshot 余额） ---------------- */

function kimiLines(j) {
  var d = j && j.data;
  if (d && num(d.available_balance)) {
    var avail = d.available_balance;
    var s = '可用 ' + money(avail);
    // 现金与可用余额相同就不重复；代金券只在非零时显示
    if (num(d.cash_balance) && r2(d.cash_balance) !== r2(avail)) s += ' · 现金 ' + money(d.cash_balance);
    if (num(d.voucher_balance) && d.voucher_balance > 0) s += ' · 券 ' + money(d.voucher_balance);
    return [s];
  }
  // Coding 专用端点可能返回 5h / 周窗口用量
  var limits = (d && (d.limits || d.usages)) || (j && (j.limits || j.usages));
  if (limits && limits.length) {
    var parts = [];
    var i, L;
    for (i = 0; i < limits.length && i < 3; i++) {
      L = limits[i];
      if (num(L.percentage)) parts.push((L.name || L.window || ('窗口' + (i + 1))) + ' 剩' + Math.max(0, 100 - Math.round(L.percentage)) + '%');
      else if (num(L.remaining)) parts.push((L.name || '额度') + ' 余' + r2(L.remaining));
    }
    if (parts.length) return [parts.join(' · ')];
  }
  return null;
}

function kimi(ctx) {
  var key = ctx.secrets.get('kimiKey');
  if (!key) return Promise.resolve({ id: 'kimi', label: 'Kimi', ok: false, lines: [], error: '未配置 API Key' });
  var custom = ctx.secrets.get('kimiEndpoint');
  var urls = custom ? [custom] : [
    'https://api.kimi.com/coding/v1/usages',
    'https://api.moonshot.cn/v1/users/me/balance'
  ];
  var headers = { Authorization: 'Bearer ' + key };

  function attempt(i) {
    if (i >= urls.length) return Promise.reject(new Error('all Kimi endpoints failed'));
    return http.getJson(urls[i], { headers: headers, timeoutMs: ctx.cfg.blocks.quota.timeoutMs })
      .catch(function () { return attempt(i + 1); });
  }

  return attempt(0).then(function (j) {
    var lines = kimiLines(j) || quotaLines(j, [], 0);
    if (!lines.length) lines = ['已连接，响应结构未识别'];
    return { id: 'kimi', label: 'Kimi', ok: true, lines: [lines.join(' · ')] };
  }).catch(function (e) {
    return { id: 'kimi', label: 'Kimi', ok: false, lines: [], error: http.errText(e) };
  });
}

/* ---------------- GLM（z.ai 主 / bigmodel 回退） ---------------- */

function glmLines(j) {
  var limits = j && j.data && j.data.limits;
  if (!limits || !limits.length) return null;
  var parts = [];
  var soonest = null;
  var i, L, label, pct;
  for (i = 0; i < limits.length && i < 3; i++) {
    L = limits[i];
    label = (L.number || '') + (UNIT[L.unit] || '');
    pct = num(L.percentage) ? Math.round(L.percentage) : null;
    if (num(L.remaining)) {
      parts.push((label ? label + ' ' : '') + '余' + r2(L.remaining) + (num(L.usage) ? '/' + r2(L.usage) : ''));
    } else if (pct !== null) {
      parts.push((label ? label + ' ' : '') + '剩' + Math.max(0, 100 - pct) + '%');
    }
    if (num(L.nextResetTime) && (soonest === null || L.nextResetTime < soonest)) soonest = L.nextResetTime;
  }
  return { lines: parts.length ? [parts.join(' · ')] : null, resetAt: soonest };
}

function glm(ctx) {
  var key = ctx.secrets.get('glmKey');
  if (!key) return Promise.resolve({ id: 'glm', label: 'GLM', ok: false, lines: [], error: '未配置 API Key' });
  var custom = ctx.secrets.get('glmEndpoint');
  var urls = custom ? [custom] : [
    'https://api.z.ai/api/monitor/usage/quota/limit',
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
  ];
  var headers = { Authorization: 'Bearer ' + key };

  function attempt(i) {
    if (i >= urls.length) return Promise.reject(new Error('all GLM endpoints failed'));
    return http.getJson(urls[i], { headers: headers, timeoutMs: ctx.cfg.blocks.quota.timeoutMs })
      .catch(function () { return attempt(i + 1); });
  }

  return attempt(0).then(function (j) {
    var parsed = glmLines(j);
    var lines = parsed && parsed.lines ? parsed.lines : quotaLines(j, [], 0).slice(0, 1);
    if (!lines.length) lines = ['已连接，响应结构未识别'];
    return {
      id: 'glm', label: 'GLM', ok: true, lines: lines,
      resetText: parsed && parsed.resetAt ? resetText(parsed.resetAt) : ''
    };
  }).catch(function (e) {
    return { id: 'glm', label: 'GLM', ok: false, lines: [], error: http.errText(e) };
  });
}

/* ---------------- 条件格式：金额低于阈值的行加粗 ---------------- */

/**
 * 从 provider 的展示文本里取「主金额」= 第一个 ¥ 后面的数字。
 * 例：'余额 ¥1234.56' → 1234.56；'余额 ¥-1.23 · 不可用' → -1.23；
 *     '可用 ¥0 · 现金 ¥-9.87' → 0（取第一个，即主金额）；GLM 的百分比行没有 ¥ → null。
 * 这不是从上游 JSON 重新解析，而是基于已经格式化好的展示文本，保证「看到的数」和「判定用的数」一致。
 */
function primaryAmount(lines) {
  if (!lines || !lines.length) return null;
  var m = /¥\s*(-?\d+(?:\.\d+)?)/.exec(lines.join(' · '));
  if (!m) return null;
  var v = Number(m[1]);
  return isFinite(v) ? v : null;
}

/** 给每个 provider 打 low 标记；失败行 / 非金额行一律不打标 */
function markLow(list, threshold) {
  var t = (typeof threshold === 'number' && isFinite(threshold)) ? threshold : LOW_DEFAULT;
  list.forEach(function (p) {
    var v = (p && p.ok) ? primaryAmount(p.lines) : null;
    p.low = (v !== null && v < t);   // 严格「低于」，等于阈值不加粗；负数/0 也算
  });
  return list;
}

/** 汇总成板块 DTO。note 留空：重置时间已挂在 provider.resetText 上，由前端就近显示 */
function summarize(list, threshold) {
  markLow(list, threshold);
  return { providers: list, note: '' };
}

var HANDLERS = { deepseek: deepseek, kimi: kimi, glm: glm };
var cloudBalance = require('./cloud-balance');

module.exports = function fetch(ctx) {
  var c = ctx.cfg.blocks.quota;
  if (!c.enabled) return Promise.resolve({ disabled: true, providers: [] });

  var aiJobs = (c.providers || []).map(function (id) {
    return (HANDLERS[id] || function () {
      return Promise.resolve({ id: id, label: id, ok: false, lines: [], error: '未知 provider' });
    })(ctx);
  });

  // 云余额单独成模块：任何一家签名 / 权限 / 网络问题都已被它自己隔离，
  // 这里再加一层兜底，保证云侧整体异常也不会拖垮三家 AI 额度。
  var cloudJobs = Promise.resolve().then(function () { return cloudBalance(ctx); })
    .catch(function (e) {
      console.warn('[quota] 云余额模块异常: ' + http.errText(e));
      return [];
    });

  return Promise.all([Promise.all(aiJobs), cloudJobs]).then(function (pair) {
    var list = pair[0].concat(pair[1]);
    var threshold = (ctx.cfg.board && typeof ctx.cfg.board.lowBalanceThreshold === 'number')
      ? ctx.cfg.board.lowBalanceThreshold : LOW_DEFAULT;
    // 「下次重置」不再汇总到板块底部提示行：留在各自 provider.resetText 上，
    // 前端把它作为小字挂到该 provider 行的下一行（当前只有 GLM 有）。
    return summarize(list, threshold);
  });
};

/** 仅供离线自检，不参与生产取数 */
module.exports.__internals = {
  primaryAmount: primaryAmount,
  markLow: markLow,
  summarize: summarize,
  LOW_DEFAULT: LOW_DEFAULT
};
