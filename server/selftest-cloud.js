'use strict';

/**
 * 云余额签名离线自检：不联网、不读真实凭据。
 * 三家都用官方文档给出的示例向量做回归，防止以后改签名时悄悄把线上请求改坏。
 *
 *   node server/selftest-cloud.js
 */

var cloud = require('./fetchers/cloud-balance');
var I = cloud.__internals;

var pass = 0;
var fail = 0;
var pending = [];

function check(name, fn) {
  function ok(detail) {
    pass++;
    console.log('  [ok] ' + name + (detail ? '  → ' + detail : ''));
  }
  function bad(e) {
    fail++;
    console.log('  [FAIL] ' + name + '  → ' + (e && e.message ? e.message : e));
  }
  try {
    var r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(ok, bad));
    else ok(r);
  } catch (e) {
    bad(e);
  }
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || '值') + ' 不符\n    实际: ' + actual + '\n    期望: ' + expected);
  }
}
function truthy(v, label) { if (!v) throw new Error(label || '应为真'); }

console.log('云余额签名自检');

/* ---------------- 百度智能云 BCE v1（官方文档「生成认证字符串」示例） ---------------- */

var BCE = {
  ak: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sk: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  timestamp: '2015-04-27T08:23:49Z',
  expire: 1800,
  method: 'PUT',
  path: '/v1/test/myfolder/readme.txt',
  query: [
    { k: 'partNumber', v: '9' },
    { k: 'uploadId', v: 'a44cc9bab11cbd156984767aad637851' }
  ],
  // 官方最终示例的认证串是「.../1800//d74a...」，双斜杠表示 signedHeaders 留空、
  // 走默认签名集（host / content-length / content-type / content-md5 / x-bce-*），
  // 默认集不含 Date。文档中间的「编码示例1」把 date 也画进了 CanonicalHeaders，
  // 但那只是演示自定义签名集，照抄它算不出官方 Signature（实测差一个 date 行）。
  headers: [
    { name: 'Host', value: 'bj.bcebos.com' },
    { name: 'Content-Type', value: 'text/plain' },
    { name: 'Content-Length', value: '8' },
    { name: 'Content-Md5', value: 'NFzcPqhviddjRNnSOGo4rw==' },
    { name: 'x-bce-date', value: '2015-04-27T08:23:49Z' }
  ],
  signedHeaders: null
};

var bce = I.bceSign(BCE);

check('BCE: 派生密钥 SigningKey 等于官方向量', function () {
  eq(bce.signingKey, '1d5ce5f464064cbee060330d973218821825ac6952368a482a592e6615aef479', 'SigningKey');
  return bce.signingKey.slice(0, 16) + '…';
});

check('BCE: 签名摘要等于官方向量', function () {
  eq(bce.signature, 'd74a04362e6a848f5b39b15421cb449427f419c95a480fd6b8cf9fc783e2999e', 'Signature');
  return bce.signature.slice(0, 16) + '…';
});

check('BCE: CanonicalRequest 与官方示例一致（默认签名集，末尾无换行）', function () {
  var lines = bce.canonicalRequest.split('\n');
  eq(lines.length, 8, '行数');   // 3 行前缀 + 5 行默认签名集 headers
  eq(lines[0], 'PUT', 'method');
  eq(lines[1], '/v1/test/myfolder/readme.txt', 'CanonicalURI');
  eq(lines[2], 'partNumber=9&uploadId=a44cc9bab11cbd156984767aad637851', 'CanonicalQuery');
  eq(lines[3], 'content-length:8', 'header1');
  eq(lines[4], 'content-md5:NFzcPqhviddjRNnSOGo4rw%3D%3D', 'header2');
  eq(lines[5], 'content-type:text%2Fplain', 'header3');
  eq(lines[6], 'host:bj.bcebos.com', 'header4');
  eq(lines[7], 'x-bce-date:2015-04-27T08%3A23%3A49Z', 'header5');
  return '8 段全部吻合';
});

check('BCE: 默认签名集时 Authorization 里 signedHeaders 留空（双斜杠）', function () {
  eq(bce.authorization,
    'bce-auth-v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2015-04-27T08:23:49Z/1800//' +
    'd74a04362e6a848f5b39b15421cb449427f419c95a480fd6b8cf9fc783e2999e', 'Authorization');
  return '…/1800//d74a04…';
});

check('BCE: UriEncode 保留 / 、编码 !\'()* 与中文', function () {
  eq(I.uriEncode('/v1/a b', true), '/v1/a%20b', '空格与斜杠');
  eq(I.uriEncode("!'()*", false), '%21%27%28%29%2A', '特殊字符');
  eq(I.uriEncode('测试', false), '%E6%B5%8B%E8%AF%95', '中文');
  return 'RFC3986 规则一致';
});

check('BCE: 生产调用只签 host;x-bce-date 且顺序正确', function () {
  var s = I.bceSign({
    ak: 'AK', sk: 'SK', timestamp: '2026-11-10T12:00:00Z', expire: 1800,
    method: 'POST', path: '/v1/finance/cash/balance', query: [],
    headers: [{ name: 'host', value: 'billing.baidubce.com' },
      { name: 'x-bce-date', value: '2026-11-10T12:00:00Z' }],
    signedHeaders: ['host', 'x-bce-date']
  });
  truthy(/\/host;x-bce-date\/[0-9a-f]{64}$/.test(s.authorization), '认证串格式');
  eq(s.canonicalRequest.split('\n')[2], '', '空 CanonicalQueryString');
  return 'signedHeaders=host;x-bce-date';
});

/* ---------------- 腾讯云 TC3-HMAC-SHA256（官方签名方法 v3 示例） ---------------- */

var TC3_PAYLOAD = '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}';

check('TC3: 请求体哈希等于官方向量', function () {
  eq(I.sha256Hex(TC3_PAYLOAD),
    '35e9c5b0e3ae67532d3c9f17ead6c90222632e5b1ff7f6e89887f1398934f064', 'HashedRequestPayload');
  return '35e9c5b0…';
});

check('TC3: CanonicalRequest 哈希等于官方向量（含空行）', function () {
  var s = I.tc3Sign({
    secretId: 'AKID********************************',
    secretKey: '********************************',
    timestamp: 1551113065,
    service: 'cvm', host: 'cvm.tencentcloudapi.com',
    method: 'POST', uri: '/', query: '',
    contentType: 'application/json; charset=utf-8',
    payload: TC3_PAYLOAD,
    extraHeaders: { 'x-tc-action': 'describeinstances' }
  });
  eq(s.hashedCanonicalRequest,
    '7019a55be8395899b900fb5564e4200d984910f34794a27cb3fb7d10ff6a1e84', 'HashedCanonicalRequest');
  truthy(s.canonicalRequest.indexOf('host:cvm.tencentcloudapi.com\nx-tc-action:describeinstances\n\ncontent-type;host;x-tc-action') !== -1,
    'CanonicalHeaders 末尾换行 + 空行 + SignedHeaders');
  eq(s.signedHeaders, 'content-type;host;x-tc-action', 'SignedHeaders');
  return '7019a55b…';
});

check('TC3: 生产调用 service=billing、CredentialScope 日期取自 UTC 时间戳', function () {
  var s = I.tc3Sign({
    secretId: 'ID', secretKey: 'KEY', timestamp: 1551113065,
    service: 'billing', host: 'billing.tencentcloudapi.com',
    method: 'POST', uri: '/', query: '', payload: '{}'
  });
  truthy(s.authorization.indexOf('Credential=ID/2019-02-25/billing/tc3_request') !== -1, 'CredentialScope');
  truthy(s.authorization.indexOf('SignedHeaders=content-type;host') !== -1, 'SignedHeaders');
  truthy(/Signature=[0-9a-f]{64}$/.test(s.authorization), '签名格式');
  return '2019-02-25/billing/tc3_request';
});

/* ---------------- 阿里云 RPC V1（官方签名机制示例） ---------------- */

var ALI_PARAMS = {
  AccessKeyId: 'testid',
  Action: 'CreateTrail',
  Format: 'JSON',
  Name: 'test',
  RegionId: 'cn-hangzhou',
  RoleName: 'AliyunServiceRoleForActionTrail',
  SignatureMethod: 'HMAC-SHA1',
  SignatureNonce: 'd7730860-e66f-11ea-a3a5-d5f3b52e66a1',
  SignatureVersion: '1.0',
  Timestamp: '2020-08-25T01:11:01Z',
  Version: '2017-12-04'
};
var ali = I.rpcSign(ALI_PARAMS, 'testsecret', 'GET');

check('RPC: 规范化查询串逐字等于官方 URL 参数串', function () {
  eq(ali.canonicalQuery,
    'AccessKeyId=testid&Action=CreateTrail&Format=JSON&Name=test&' +
    'RegionId=cn-hangzhou&RoleName=AliyunServiceRoleForActionTrail&' +
    'SignatureMethod=HMAC-SHA1&SignatureNonce=d7730860-e66f-11ea-a3a5-d5f3b52e66a1&' +
    'SignatureVersion=1.0&Timestamp=2020-08-25T01%3A11%3A01Z&Version=2017-12-04',
    'canonicalQuery');
  return '字典序 + 单层编码均一致';
});

check('RPC: 生产用标准 StringToSign（GET + 整体再编码一次）', function () {
  var prod = I.rpcSign(ALI_PARAMS, 'testsecret', 'GET');
  truthy(prod.stringToSign.indexOf('GET&%2F&') === 0, '方法前缀');
  truthy(prod.stringToSign.indexOf('Timestamp%3D2020-08-25T01%253A11%253A01Z') !== -1,
    'Timestamp 的冒号应编码成 %253A');
  truthy(prod.stringToSign.indexOf('%25253A') === -1, '不应出现三层编码');
  eq(prod.signature, 'QKfeJY1UaD9hKWHgpxpdhdfLuyA=', '标准算法固定向量');
  return 'GET&%2F&…';
});

check('RPC: HMAC 原语能复现官方 Signature（文档示例的特殊构造）', function () {
  // 反推结论：官方页给出的 d15sJSZ0… 实际对应「POST + 参数值被编码两次」；
  // 同一页面 URL 却写 GET、StringToSign 又写 POST 且出现 %25253A（三层编码）。
  // 生产代码一律走标准算法，这里只验证 HMAC-SHA1 原语与官方一致、并锁定这个坑。
  var cq2 = Object.keys(ALI_PARAMS).sort().map(function (k) {
    return I.percentEncode(k) + '=' + I.percentEncode(I.percentEncode(ALI_PARAMS[k]));
  }).join('&');
  var sts2 = 'POST&%2F&' + I.percentEncode(cq2);
  var sig2 = require('crypto').createHmac('sha1', 'testsecret&').update(sts2, 'utf8').digest('base64');
  eq(sig2, 'd15sJSZ0cc+y6a6FHlWxGK/qcUA=', '官方向量');
  return '文档示例 = POST + 值二次编码，生产不照抄';
});

check('RPC: percentEncode 空格 %20 / 星号 %2A / 波浪号还原', function () {
  eq(I.percentEncode('a b'), 'a%20b', '空格');
  eq(I.percentEncode('*'), '%2A', '星号');
  eq(I.percentEncode('~'), '~', '波浪号');
  return '三条差异全部符合';
});

/* ---------------- 凭据隔离：无凭据时的 DTO 不能带任何密钥 ---------------- */

check('未配置凭据时三家各自失败隔离，且 DTO 不含密钥', function () {
  var ctx = {
    cfg: { blocks: { quota: { cloudProviders: ['baidu', 'tencent', 'aliyun'], timeoutMs: 1000 } } },
    secrets: {
      // 三家 ID 都缺 → 全部走 noCred 分支，自检绝不联网；
      // 同时故意让 SK 取到假值，验证即使进程里读到了密钥也不会进入 DTO
      get: function (name) {
        if (name === 'baiduAk' || name === 'tencentSecretId' || name === 'aliyunAk') return '';
        return 'FAKE_SECRET_SHOULD_NOT_LEAK';
      }
    }
  };
  return cloud(ctx).then(function (list) {
    eq(list.length, 3, 'provider 数量');
    var serialized = JSON.stringify(list);
    truthy(serialized.indexOf('FAKE_SECRET_SHOULD_NOT_LEAK') === -1, 'DTO 泄漏了凭据');
    truthy(serialized.indexOf('billing.baidubce.com') === -1, 'DTO 泄漏了上游 URL');
    list.forEach(function (p) {
      truthy(p.ok === false, p.id + ' 应为未配置失败');
      truthy(p.lines && p.lines.length === 0, p.id + ' 不应有余额文本');
      eq(Object.keys(p).sort().join(','), 'error,id,label,lines,ok', p.id + ' 字段白名单');
    });
    return '3 家均 {id,label,ok,lines,error}，零泄漏';
  });
});

Promise.all(pending).then(function () {
  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
});
