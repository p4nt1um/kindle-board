'use strict';

/**
 * 三家公有云账户余额：百度智能云 / 腾讯云 / 阿里云。
 *
 * 设计约束（与整个看板一致）：
 *  1. 所有 AK/SK 只存在于 PC 侧进程内，签名只在请求头里出现，
 *     返回的 provider DTO 只有 {id,label,ok,lines,error}，绝不含密钥或上游 URL。
 *  2. 三家各自独立请求、独立失败隔离：一家的 Key 没配或权限不足，
 *     不影响另外两家，也不影响 AI 额度（DeepSeek/Kimi/GLM）。
 *  3. 云 API 常见「HTTP 200 + 业务错误 JSON」，所以每家都必须检查响应体里的
 *     Error / Code / 余额字段，不能只看 HTTP 状态码，否则会显示一个假的 ¥0。
 *
 * 三套签名（均已对照官方文档的示例向量，见 server/selftest-cloud.js）：
 *  - 百度智能云：BCE v1，POST /v1/finance/cash/balance，cashBalance（元）
 *  - 腾讯云：TC3-HMAC-SHA256，DescribeAccountBalance 2018-07-09，RealBalance（分）
 *  - 阿里云：RPC HMAC-SHA1，QueryAccountBalance 2017-12-14，Data.AvailableAmount（元）
 */

var crypto = require('crypto');
var http = require('../http-util');

var LABELS = { baidu: '百度云', tencent: '腾讯云', aliyun: '阿里云' };

function hmacHex(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}
function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
function num(v) { return typeof v === 'number' && isFinite(v); }
function finite(v) { var n = Number(v); return isFinite(n) ? n : null; }
function r2(v) { return Math.round(v * 100) / 100; }
function money(v) { return '¥' + r2(v); }
function utcStamp(d) { return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); }

/** RFC 3986 百分号编码：只保留 A-Z a-z 0-9 - . _ ~，其余字节 %XY（大写） */
function uriEncode(s, keepSlash) {
  var out = encodeURIComponent(String(s))
    .replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
  if (keepSlash) out = out.replace(/%2F/g, '/');
  return out;
}

/** 阿里云 RPC 专用编码：与 encodeURIComponent 的差异是空格 %20、* %2A、~ 还原 */
function percentEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

function jsonBody(r) {
  var t = r.body.toString('utf8').replace(/^\uFEFF/, '');
  try { return JSON.parse(t); }
  catch (e) { throw new Error('上游响应不是 JSON'); }
}

function noCred(id) {
  return { id: id, label: LABELS[id] || id, ok: false, lines: [], error: '未配置 AK/SK' };
}

/* ---------------- 百度智能云：BCE v1 ---------------- */

/**
 * 生成 BCE 认证字符串。抽成通用函数是为了能用官方文档的完整示例向量做离线回归。
 * opts: { ak, sk, timestamp, expire, method, path, query:[{k,v}], headers:[{name,value}],
 *         signedHeaders: ['host', ...] 或 null（null = 留空使用默认签名集） }
 */
function bceSign(o) {
  var prefix = 'bce-auth-v1/' + o.ak + '/' + o.timestamp + '/' + (o.expire || 1800);
  var hdrs = (o.headers || []).map(function (h) {
    return { name: String(h.name).toLowerCase(), value: String(h.value).trim() };
  }).filter(function (h) { return h.value !== ''; });

  var canonicalHeaders = hdrs.map(function (h) {
    return uriEncode(h.name) + ':' + uriEncode(h.value);
  }).sort().join('\n');   // 注意：用 \n 连接，最后一行后面不加 \n

  var canonicalQuery = (o.query || []).map(function (p) {
    if (String(p.k).toLowerCase() === 'authorization') return null;
    return uriEncode(p.k) + '=' + uriEncode(p.v === undefined || p.v === null ? '' : p.v);
  }).filter(function (x) { return x !== null; }).sort().join('&');

  var canonicalRequest = o.method + '\n' + uriEncode(o.path, true) + '\n' +
    canonicalQuery + '\n' + canonicalHeaders;
  var signingKey = hmacHex(o.sk, prefix);
  var signature = hmacHex(signingKey, canonicalRequest);

  // 注意：数组直接参与字符串拼接会变成逗号分隔（Array.toString），
  // 而 BCE 要求分号分隔；必须显式 join(';')，否则线上必然 Signature 校验失败。
  var signed;
  if (o.signedHeaders === null) signed = '';                    // 留空 = 使用默认签名集
  else if (Array.isArray(o.signedHeaders)) signed = o.signedHeaders.slice().sort().join(';');
  else if (o.signedHeaders !== undefined) signed = String(o.signedHeaders);
  else signed = hdrs.map(function (h) { return h.name; }).sort().join(';');

  return {
    prefix: prefix,
    canonicalRequest: canonicalRequest,
    signingKey: signingKey,
    signature: signature,
    authorization: prefix + '/' + signed + '/' + signature
  };
}

function baidu(ctx) {
  var ak = ctx.secrets.get('baiduAk');
  var sk = ctx.secrets.get('baiduSk');
  if (!ak || !sk) return Promise.resolve(noCred('baidu'));

  var host = 'billing.baidubce.com';
  var path = '/v1/finance/cash/balance';
  var ts = utcStamp(new Date());
  // 只签 host 与 x-bce-date。Content-Type / Content-Length 属于 BCE 推荐签名集，
  // 没签它们就必须在认证字符串里显式写出 signedHeaders（官方文档 §任务二 第 3 条）。
  var signed = bceSign({
    ak: ak, sk: sk, timestamp: ts, expire: 1800,
    method: 'POST', path: path, query: [],
    headers: [{ name: 'host', value: host }, { name: 'x-bce-date', value: ts }],
    signedHeaders: ['host', 'x-bce-date']
  });

  return http.request('POST', 'https://' + host + path, {
    headers: {
      Host: host,
      'Content-Type': 'application/json; charset=utf-8',
      'x-bce-date': ts,
      Authorization: signed.authorization
    },
    body: '{}',
    timeoutMs: ctx.cfg.blocks.quota.timeoutMs
  }).then(function (r) {
    var j = jsonBody(r);
    if (j && (j.code || j.message) && j.cashBalance === undefined) {
      throw new Error('云 API 错误 ' + (j.code || '') + ' ' + (j.message || ''));
    }
    var v = finite(j && j.cashBalance);
    if (v === null) throw new Error('响应缺少 cashBalance');
    return { id: 'baidu', label: LABELS.baidu, ok: true, lines: ['余额 ' + money(v)] };
  });
}

/* ---------------- 腾讯云：API 3.0 / TC3-HMAC-SHA256 ---------------- */

/**
 * TC3 签名。CanonicalHeaders 每一行都以 \n 结尾（含最后一行），
 * 且公式里 CanonicalHeaders 之后还会再拼一个 \n，于是 headers 与 SignedHeaders
 * 之间存在一个空行 —— 这是最容易写错、导致 SignatureNotMatch 的地方。
 */
function tc3Sign(o) {
  var payload = o.payload || '';
  var contentType = o.contentType || 'application/json';
  var ts = o.timestamp;
  var date = new Date(ts * 1000).toISOString().slice(0, 10);
  var service = o.service;
  var host = o.host;

  var headerMap = { 'content-type': contentType, 'host': host };
  if (o.extraHeaders) {
    Object.keys(o.extraHeaders).forEach(function (k) {
      headerMap[String(k).toLowerCase()] = o.extraHeaders[k];
    });
  }
  var names = Object.keys(headerMap).sort();
  var canonicalHeaders = names.map(function (k) {
    return k + ':' + String(headerMap[k]).trim() + '\n';
  }).join('');
  var signedHeaders = names.join(';');

  var canonicalRequest = o.method + '\n' + (o.uri || '/') + '\n' +
    (o.query || '') + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' +
    sha256Hex(payload);

  var scope = date + '/' + service + '/tc3_request';
  var stringToSign = 'TC3-HMAC-SHA256\n' + ts + '\n' + scope + '\n' + sha256Hex(canonicalRequest);

  var secretDate = crypto.createHmac('sha256', 'TC3' + o.secretKey).update(date, 'utf8').digest();
  var secretService = crypto.createHmac('sha256', secretDate).update(service, 'utf8').digest();
  var secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request', 'utf8').digest();
  var signature = crypto.createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex');

  var authorization = 'TC3-HMAC-SHA256 ' +
    'Credential=' + o.secretId + '/' + scope + ', ' +
    'SignedHeaders=' + signedHeaders + ', ' +
    'Signature=' + signature;

  return {
    canonicalRequest: canonicalRequest,
    hashedCanonicalRequest: sha256Hex(canonicalRequest),
    stringToSign: stringToSign,
    signedHeaders: signedHeaders,
    authorization: authorization
  };
}

function tencent(ctx) {
  var id = ctx.secrets.get('tencentSecretId');
  var key = ctx.secrets.get('tencentSecretKey');
  if (!id || !key) return Promise.resolve(noCred('tencent'));

  var host = 'billing.tencentcloudapi.com';
  var payload = '{}';
  var ts = Math.floor(Date.now() / 1000);
  var signed = tc3Sign({
    secretId: id, secretKey: key, timestamp: ts,
    service: 'billing', host: host, method: 'POST', uri: '/', query: '',
    contentType: 'application/json', payload: payload
  });

  return http.request('POST', 'https://' + host + '/', {
    headers: {
      Host: host,
      'Content-Type': 'application/json',
      'X-TC-Action': 'DescribeAccountBalance',
      'X-TC-Version': '2018-07-09',
      'X-TC-Timestamp': String(ts),
      Authorization: signed.authorization
    },
    body: payload,
    timeoutMs: ctx.cfg.blocks.quota.timeoutMs
  }).then(function (r) {
    var j = jsonBody(r);
    var resp = j && j.Response;
    if (!resp) throw new Error('响应缺少 Response');
    if (resp.Error) {
      throw new Error('云 API 错误 ' + (resp.Error.Code || '') + ' ' + (resp.Error.Message || ''));
    }
    // 单位：分。RealBalance 为「当前真实可用余额」，Balance 为兼容老接口的同义字段
    var cents = finite(resp.RealBalance !== undefined ? resp.RealBalance : resp.Balance);
    if (cents === null) throw new Error('响应缺少余额字段');
    return {
      id: 'tencent', label: LABELS.tencent, ok: true,
      lines: ['余额 ' + money(cents / 100) +
        (num(finite(resp.OweAmount)) && Number(resp.OweAmount) > 0 ? ' · 欠费' : '')]
    };
  });
}

/* ---------------- 阿里云：RPC 风格 V1 签名 ---------------- */

function rpcSign(params, secret, method) {
  var keys = Object.keys(params).sort();
  var canonicalQuery = keys.map(function (k) {
    return percentEncode(k) + '=' + percentEncode(params[k]);
  }).join('&');
  var stringToSign = (method || 'GET') + '&%2F&' + percentEncode(canonicalQuery);
  var signature = crypto.createHmac('sha1', secret + '&').update(stringToSign, 'utf8').digest('base64');
  return {
    canonicalQuery: canonicalQuery,
    stringToSign: stringToSign,
    signature: signature
  };
}

function aliyun(ctx) {
  var ak = ctx.secrets.get('aliyunAk');
  var sk = ctx.secrets.get('aliyunSk');
  if (!ak || !sk) return Promise.resolve(noCred('aliyun'));

  var host = 'business.aliyuncs.com';
  var params = {
    AccessKeyId: ak,
    Action: 'QueryAccountBalance',
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomBytes(16).toString('hex'),
    SignatureVersion: '1.0',
    Timestamp: utcStamp(new Date()),
    Version: '2017-12-14'
  };
  var signed = rpcSign(params, sk, 'GET');
  var url = 'https://' + host + '/?' + signed.canonicalQuery +
    '&Signature=' + percentEncode(signed.signature);

  return http.getJson(url, { timeoutMs: ctx.cfg.blocks.quota.timeoutMs }).then(function (j) {
    if (!j || String(j.Code) !== '200' || j.Success === false) {
      throw new Error('云 API 错误 ' + (j && j.Code ? j.Code : '?') + ' ' + (j && j.Message ? j.Message : ''));
    }
    var d = j.Data || {};
    var v = finite(d.AvailableAmount);
    if (v === null) throw new Error('响应缺少 AvailableAmount');
    var cur = d.Currency && d.Currency !== 'CNY' ? ' ' + d.Currency : '';
    return { id: 'aliyun', label: LABELS.aliyun, ok: true, lines: ['余额 ' + money(v) + cur] };
  });
}

/* ---------------- 汇总 ---------------- */

var HANDLERS = { baidu: baidu, tencent: tencent, aliyun: aliyun };

function guard(id, job) {
  return Promise.resolve().then(job).catch(function (e) {
    // errText 会打码 Bearer / URL 里的 key 参数；这里再兜一层，只保留错误文本
    return { id: id, label: LABELS[id] || id, ok: false, lines: [], error: http.errText(e) };
  });
}

module.exports = function fetch(ctx) {
  var c = ctx.cfg.blocks.quota || {};
  var ids = c.cloudProviders || [];
  var jobs = ids.map(function (id) {
    var h = HANDLERS[id];
    if (!h) {
      return Promise.resolve({
        id: id, label: LABELS[id] || id, ok: false, lines: [], error: '未知云厂商'
      });
    }
    return guard(id, function () { return h(ctx); });
  });
  return Promise.all(jobs);
};

module.exports.LABELS = LABELS;
/** 仅供离线签名向量自检使用，不参与生产取数 */
module.exports.__internals = {
  uriEncode: uriEncode,
  percentEncode: percentEncode,
  bceSign: bceSign,
  tc3Sign: tc3Sign,
  rpcSign: rpcSign,
  sha256Hex: sha256Hex
};
