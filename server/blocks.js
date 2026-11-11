'use strict';

/**
 * 板块注册表：数据获取（fetcher，PC 侧）与展示（renderer，浏览器侧）完全分离。
 *
 * 新增/调整板块的步骤：
 *   1. 在 server/fetchers/ 写一个返回纯数据的模块；
 *   2. 在下面 REGISTRY 注册 id / rows / ttl / renderer；
 *   3. 在 public/board.js 的 RENDERERS 里加一个纯展示函数；
 *   4. 把 id 加进 config.json 的 board.layout（顺序即屏上顺序）。
 * 第 2 步的 rows 参与名义预算校验：Σrows 必须 ≤ board.rowBudget，作为单屏可读性护栏。
 * 注意：板块高度已改为由内容自然撑开，rows 不再写进 DOM height；超预算时页面会变长、需要滚动。
 */

var cfg = require('../config.json');

var REGISTRY = [
  { id: 'clock',   title: '时 钟',   rows: 9,  ttl: 0,        realtime: true, renderer: 'clock',   fetcher: require('./fetchers/clock') },
  { id: 'weather', title: '天 气',   rows: 9,  ttl: 10800000,                 renderer: 'weather', fetcher: require('./fetchers/weather') },
  { id: 'agenda',  title: '日 程',   rows: 15, ttl: 10800000,                 renderer: 'agenda',  fetcher: require('./fetchers/agenda') },
  { id: 'quota',   title: 'AI 额度', rows: 10, ttl: 10800000,                 renderer: 'quota',   fetcher: require('./fetchers/quota') },
  { id: 'daily',   title: '每 日',   rows: 10, ttl: 10800000,                 renderer: 'daily',   fetcher: require('./fetchers/daily') }
];

var byId = {};
REGISTRY.forEach(function (b) { byId[b.id] = b; });

function validateBudget() {
  var used = 0;
  var i, b;
  var layout = cfg.board.layout || [];
  for (i = 0; i < layout.length; i++) {
    b = byId[layout[i]];
    if (!b) throw new Error('board.layout 里有未注册板块: ' + layout[i]);
    used += b.rows;
  }
  if (used > cfg.board.rowBudget) {
    throw new Error('名义空间预算超出: Σrows=' + used + ' > budget=' + cfg.board.rowBudget +
      '（板块已改为自然流式排版，rows 不再写死 DOM 高度；此项仅作单屏可读性护栏，' +
      '可调大 board.rowBudget 或精简板块）');
  }
  return { used: used, budget: cfg.board.rowBudget, rowPx: cfg.board.rowPx };
}

/** 按 layout 顺序返回启用的板块；blocks.<id>.enabled === false 可临时关掉 */
function list() {
  var out = [];
  var ids = cfg.board.layout || [];
  var i, b, c;
  for (i = 0; i < ids.length; i++) {
    b = byId[ids[i]];
    if (!b) continue;
    c = cfg.blocks ? cfg.blocks[ids[i]] : null;
    if (c && c.enabled === false) continue;
    out.push(b);
  }
  return out;
}

function meta() {
  return list().map(function (b) {
    return { id: b.id, title: b.title, rows: b.rows, renderer: b.renderer };
  });
}

module.exports = {
  REGISTRY: REGISTRY,
  byId: byId,
  list: list,
  meta: meta,
  validateBudget: validateBudget
};
