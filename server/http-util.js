'use strict';

/**
 * 上游 HTTP 封装：统一超时、响应体上限、重定向、JSON 解析与脱敏。
 * 所有公网 HTTPS / 飞书 CalDAV 都只由服务端发起；Kindle 浏览器只访问局域网 HTTP。
 */

var http = require('http');
var https = require('https');
var urlLib = require('url');
var secrets = require('./secrets');

var DEFAULT_UA = 'kindle-board/0.3 (+local-aggregator)';

function request(method, url, opts) {
  opts = opts || {};
  var timeout = opts.timeoutMs || 10000;
  var maxBytes = opts.maxBytes || 1024 * 1024;
  var redirects = opts.redirects === undefined ? 3 : opts.redirects;

  return new Promise(function (resolve, reject) {
    var u;
    try { u = urlLib.parse(url); } catch (e) { reject(new Error('bad url')); return; }
    var mod = u.protocol === 'https:' ? https : http;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('unsupported protocol')); return;
    }

    var headers = {
      'User-Agent': DEFAULT_UA,
      'Accept': opts.accept || 'application/json, text/plain, */*',
      'Connection': 'close'
    };
    if (opts.headers) {
      Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    }
    if (opts.body !== undefined && opts.body !== null && headers['Content-Type'] === undefined) {
      headers['Content-Type'] = 'application/xml; charset=utf-8';
    }
    if (opts.body !== undefined && opts.body !== null) {
      headers['Content-Length'] = Buffer.byteLength(String(opts.body));
    }

    var req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.path,
      method: method,
      headers: headers,
      rejectUnauthorized: true
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        var next = urlLib.resolve(url, res.headers.location);
        request(method, next, Object.assign({}, opts, { redirects: redirects - 1, body: null }))
          .then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' @ ' + safeHost(url)));
        return;
      }
      var chunks = [];
      var size = 0;
      res.on('data', function (c) {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error('response too large (' + size + ' bytes)'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    });

    req.setTimeout(timeout, function () {
      req.destroy(new Error('timeout after ' + timeout + 'ms @ ' + safeHost(url)));
    });
    req.on('error', function (e) { reject(e); });
    if (opts.body !== undefined && opts.body !== null) req.write(String(opts.body));
    req.end();
  });
}

function safeHost(url) {
  try { return urlLib.parse(url).host || '(host)'; } catch (e) { return '(host)'; }
}

function getJson(url, opts) {
  opts = opts || {};
  return request('GET', url, opts).then(function (r) {
    var text = r.body.toString('utf8').replace(/^\uFEFF/, '');
    try { return JSON.parse(text); }
    catch (e) { throw new Error('invalid JSON @ ' + safeHost(url)); }
  });
}

function getText(url, opts) {
  return request('GET', url, opts).then(function (r) { return r.body.toString('utf8'); });
}

function getBinary(url, opts) {
  return request('GET', url, opts).then(function (r) {
    return { body: r.body, contentType: r.headers['content-type'] || 'application/octet-stream' };
  });
}

/** 统一错误文本：去掉任何可能的凭据，避免打进日志 */
function errText(e) {
  return secrets.redact(e && e.message ? e.message : String(e)).slice(0, 180);
}

module.exports = {
  request: request,
  getJson: getJson,
  getText: getText,
  getBinary: getBinary,
  errText: errText
};
