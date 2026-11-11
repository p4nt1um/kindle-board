'use strict';

/**
 * 每日谏言 / 一诗 / 一图：多源获取 + 本地池持久化 + 确定性回退。
 *
 * - 每个源独立超时、独立失败，任一成功即写入 data/pool.json（去重、上限 200 条）。
 * - 全网失败时用内置内容 + 已有本地池，并打 __stale 软失败标记：
 *   前端仍显示内容，但会显示「离线 / 最后成功更新时间」。
 * - 按 hash(dateKey) % pool.length 选内容，保证同一天多次刷新不换内容。
 * - 图片由 PC 下载并缓存到 data/media/daily.jpg，浏览器只访问同源 /media/，
 *   不让老 WebKit 直连公网 HTTPS（它的根证书和 TLS 版本都太旧）。
 */

var fs = require('fs');
var path = require('path');
var http = require('../http-util');

var DATA = path.join(__dirname, '..', '..', 'data');
var MEDIA = path.join(DATA, 'media');
var POOL_FILE = path.join(DATA, 'pool.json');
var IMAGE_FILE = path.join(MEDIA, 'daily.jpg');
var MAX_POOL = 200;

var BUILTIN = [
  { type: 'quote', text: '不驰于空想，不骛于虚声。', source: '李大钊' },
  { type: 'quote', text: '凡是过往，皆为序章。', source: '莎士比亚' },
  { type: 'quote', text: '行到水穷处，坐看云起时。', source: '王维《终南别业》' },
  { type: 'quote', text: 'Stay hungry, stay foolish.', source: 'Steve Jobs' },
  { type: 'quote', text: '日拱一卒，功不唐捐。', source: '《法华经》' },
  { type: 'poem', text: '明月松间照，清泉石上流。', source: '王维《山居秋暝》' },
  { type: 'poem', text: '不畏浮云遮望眼，自缘身在最高层。', source: '王安石《登飞来峰》' },
  { type: 'poem', text: '山重水复疑无路，柳暗花明又一村。', source: '陆游《游山西村》' },
  { type: 'poem', text: '落霞与孤鹜齐飞，秋水共长天一色。', source: '王勃《滕王阁序》' },
  { type: 'poem', text: '长风破浪会有时，直挂云帆济沧海。', source: '李白《行路难》' }
];

function ensureDirs() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  if (!fs.existsSync(MEDIA)) fs.mkdirSync(MEDIA, { recursive: true });
}

function loadPool() {
  try {
    var j = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    if (j && Object.prototype.toString.call(j.items) === '[object Array]') return j.items;
  } catch (e) { /* 首次运行或文件损坏，回退内置 */ }
  return BUILTIN.slice();
}

function savePool(items) {
  try {
    ensureDirs();
    var tmp = POOL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), items: items }, null, 2), 'utf8');
    fs.renameSync(tmp, POOL_FILE);
  } catch (e) {
    console.warn('[daily] 写本地池失败: ' + e.message);
  }
}

function mergePool(pool, fresh) {
  var seen = {};
  var i;
  for (i = 0; i < pool.length; i++) seen[pool[i].type + '|' + pool[i].text] = 1;
  for (i = 0; i < fresh.length; i++) {
    var k = fresh[i].type + '|' + fresh[i].text;
    if (!seen[k] && fresh[i].text) { seen[k] = 1; pool.push(fresh[i]); }
  }
  if (pool.length > MAX_POOL) pool = pool.slice(pool.length - MAX_POOL);
  return pool;
}

function hash(s) {
  var h = 2166136261, i;
  for (i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h >>> 0;
}

function pick(pool, type, dateKey, offset) {
  var list = pool.filter(function (x) { return x.type === type; });
  if (!list.length) return null;
  return list[(hash(dateKey + '|' + type) + (offset || 0)) % list.length];
}

function dateKey(d) {
  // 用上海日期，避免 PC 本地时区与用户预期不一致
  var off = 8 * 60;
  var x = new Date(d.getTime() + off * 60000);
  return x.getUTCFullYear() + '-' +
    ('0' + (x.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + x.getUTCDate()).slice(-2);
}

function safeText(s, max) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max || 80);
}

/** 每个源都返回 Promise<{type,text,source}|null>，绝不 reject */
function sourceJinrishici(ctx) {
  return http.getJson('https://v2.jinrishici.com/one.json', { timeoutMs: ctx.tmo })
    .then(function (j) {
      var d = j && j.data;
      if (!d || !d.content) return null;
      var o = d.origin || {};
      return {
        type: 'poem', text: safeText(d.content, 60),
        source: safeText((o.dynasty ? o.dynasty + '·' : '') + (o.author || '') +
          (o.title ? '《' + o.title + '》' : ''), 40),
        from: '今日诗词'
      };
    }).catch(function () { return null; });
}

function sourceHitokoto(ctx) {
  return http.getJson('https://v1.hitokoto.cn/?c=d&c=i&c=k&encode=json', { timeoutMs: ctx.tmo })
    .then(function (j) {
      if (!j || !j.hitokoto) return null;
      return { type: 'quote', text: safeText(j.hitokoto, 60), source: safeText(j.from || j.from_who || '一言', 40), from: 'Hitokoto' };
    }).catch(function () { return null; });
}

function sourceIciba(ctx) {
  return http.getJson('https://open.iciba.com/dsapi/', { timeoutMs: ctx.tmo })
    .then(function (j) {
      if (!j || !j.content) return null;
      return { type: 'quote', text: safeText(j.content, 60), source: safeText(j.note || '金山词霸每日一句', 40), from: 'Iciba' };
    }).catch(function () { return null; });
}

function sourceBing(ctx) {
  return http.getJson('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN', { timeoutMs: ctx.tmo })
    .then(function (j) {
      var im = j && j.images && j.images[0];
      if (!im) return null;
      return {
        caption: safeText(im.title || im.copyright || '', 50),
        copyright: safeText(im.copyright || '', 60),
        url: im.url ? 'https://www.bing.com' + im.url : null
      };
    }).catch(function () { return null; });
}

function writeImage(buf) {
  try {
    ensureDirs();
    var tmp = IMAGE_FILE + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, IMAGE_FILE);
    return true;
  } catch (e) {
    console.warn('[daily] 写图片失败: ' + e.message);
    return false;
  }
}

/** 优先 Bing 真图，失败降级 picsum 灰度小图（对 16 级灰阶最友好） */
function fetchImage(ctx, bing, dateKey) {
  if (!ctx.cfg.blocks.daily.showImage) return Promise.resolve(null);
  var limit = ctx.cfg.blocks.daily.imageMaxBytes || 400000;

  function fallback() {
    return http.getBinary('https://picsum.photos/seed/kb' + dateKey.replace(/-/g, '') + '/600/200?grayscale',
      { timeoutMs: ctx.tmo, maxBytes: limit, redirects: 4 })
      .then(function (r) {
        return writeImage(r.body) ? { url: '/media/daily.jpg?d=' + dateKey, source: 'Picsum (灰度)' } : null;
      }).catch(function () { return null; });
  }

  if (!bing || !bing.url) return fallback();
  return http.getBinary(bing.url, { timeoutMs: ctx.tmo, maxBytes: limit })
    .then(function (r) {
      if (!/^image\//i.test(r.contentType)) return fallback();
      if (r.body.length < 1000) return fallback();
      return writeImage(r.body) ? { url: '/media/daily.jpg?d=' + dateKey, source: 'Bing 每日一图' } : fallback();
    }).catch(function () { return fallback(); });
}

module.exports = function fetch(ctx) {
  var c = ctx.cfg.blocks.daily;
  if (!c.enabled) return Promise.resolve({ disabled: true });

  ensureDirs();
  var key = dateKey(new Date());
  var tmo = c.timeoutMs || 8000;
  var sub = { cfg: ctx.cfg, tmo: tmo };
  var sources = c.sources || [];
  var jobs = [];

  if (sources.indexOf('jinrishici') >= 0) jobs.push(sourceJinrishici(sub));
  if (sources.indexOf('hitokoto') >= 0) jobs.push(sourceHitokoto(sub));
  if (sources.indexOf('iciba') >= 0) jobs.push(sourceIciba(sub));
  var bingJob = sources.indexOf('bing') >= 0 ? sourceBing(sub) : Promise.resolve(null);

  return Promise.all(jobs.concat([bingJob])).then(function (results) {
    var fresh = results.filter(function (x) { return x && x.type; });
    var bing = results[results.length - 1] && results[results.length - 1].caption
      ? results[results.length - 1] : null;
    var pool = mergePool(loadPool(), fresh);
    if (fresh.length) savePool(pool);

    var quote = pick(pool, 'quote', key);
    var poem = pick(pool, 'poem', key);

    return fetchImage(sub, bing, key).then(function (image) {
      var data = {
        dateKey: key,
        quote: quote || { text: '（暂无谏言）', source: '' },
        poem: poem || { text: '（暂无诗句）', source: '' },
        image: image && bing ? { url: image.url, caption: bing.caption, copyright: bing.copyright, source: image.source } : image,
        poolSize: pool.length,
        onlineCount: fresh.length + (bing ? 1 : 0),
        note: '多源获取 + 本地池回退；按日期确定性选取'
      };
      // 软失败：内容仍可用，但要标记 stale / 保留最后成功时间
      if (!fresh.length && !bing) {
        data.__stale = true;
        data.__staleReason = '所有在线内容源均失败，正在使用内置/本地池';
      }
      return data;
    });
  });
};
