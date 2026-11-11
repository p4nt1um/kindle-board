'use strict';

/**
 * 百度智能云「账户余额查询」一键诊断：npm run diagnose:baidu
 *
 * 走的就是生产取数路径（server/fetchers/cloud-balance.js 的 baidu()），
 * 所以「这里能通」等价于「看板上能显示」。只读本机凭据，绝不打印
 * AK/SK、Authorization 或签名串；失败时打印脱敏后的错误与对应排查提示。
 *
 * 官方文档：https://cloud.baidu.com/doc/Finance/s/Skhtyytwu
 *   POST /v1/finance/cash/balance  Host: billing.baidubce.com
 *   Content-Type: application/json; charset=utf-8   Authorization: BCE v1
 *   响应 {"cashBalance": 850.0000}（元，BigDecimal），无需请求参数
 */

var cfg = require('../config.json');
var secrets = require('./secrets');
var http = require('./http-util');
var cloudBalance = require('./fetchers/cloud-balance');

var probeCfg = Object.assign({}, cfg, {
  blocks: Object.assign({}, cfg.blocks, {
    quota: Object.assign({}, cfg.blocks.quota, { cloudProviders: ['baidu'] })
  })
});
var ctx = { cfg: probeCfg, secrets: secrets, http: http, log: function () { /* quiet */ } };

var now = new Date();
console.log('');
console.log('  百度智能云账户余额诊断');
console.log('  ' + now.toString());
console.log('  本机 UTC : ' + now.toISOString());
console.log('  接口     : POST https://billing.baidubce.com/v1/finance/cash/balance');
console.log('  签名     : bce-auth-v1 / signedHeaders=host;x-bce-date / expire=1800s');
console.log('  凭据     : baiduAk=' + (secrets.get('baiduAk') ? '已配置' : '缺失') +
  '  baiduSk=' + (secrets.get('baiduSk') ? '已配置' : '缺失') +
  '  /api/health 的 baiduCloud=' + secrets.status().baiduCloud);
console.log('  凭据文件 : ' + secrets.status().fileNote);
console.log('  （只报告有无，不打印任何值）');
console.log('');

cloudBalance(ctx).then(function (list) {
  var p = list[0] || {};
  if (p.ok) {
    console.log('  [OK] ' + (p.lines || []).join('  /  '));
    console.log('');
    console.log('  生产路径已通。回到看板：本机访问 http://127.0.0.1:8787/api/refresh');
    console.log('  立即重取，再查 /api/board.json 里 id=baidu 的 provider。');
    console.log('  没重启服务也没关系：secrets.local.json 是按 mtime 热加载的。');
    return;
  }

  var err = p.error || '(无错误信息)';
  console.log('  [FAIL] ' + err);
  console.log('');
  console.log('  排查提示：');

  if (/未配置 AK\/SK/i.test(err)) {
    console.log('   · 键名是 baiduAk / baiduSk（文件）或 BAIDU_CLOUD_AK / BAIDU_CLOUD_SK（环境变量）');
    console.log('   · 跑 npm run sync-secrets 合并，或检查 secrets.local.json 有没有这两个键');
  }
  if (/Signature|InvalidHTTPAuth|AccessDenied|403|鉴权|签名|认证/i.test(err)) {
    console.log('   · SecretAccessKey 是否正确（2025-05-15 起百度只在创建时显示明文 SK，查不到就重建 AK/SK）');
    console.log('   · 本机时钟是否准：BCE 用 UTC 时间戳 + 1800s 有效期，偏差过大会直接判签名过期');
    console.log('     Windows: w32tm /resync   Linux/树莓派: sudo timedatectl set-ntp true');
    console.log('   · 若用的是 IAM 子用户 AK/SK，主账号需在 IAM 里给它授权财务读权限');
  }
  if (/QualifyNotPass|实名/i.test(err)) {
    console.log('   · 账号未完成实名认证，先到百度智能云控制台完成');
  }
  if (/cashBalance|不是 JSON|业务/i.test(err)) {
    console.log('   · HTTP 200 但响应体没有 cashBalance：多半是业务错误，已把 code/message 打在上面');
  }
  if (/timeout|ETIMEDOUT|ENOTFOUND|ECONN|socket|网络/i.test(err)) {
    console.log('   · 出网是否可达 billing.baidubce.com:443；公司网络/代理可能需要放行');
  }
  console.log('');
  console.log('  更多细节可读 README「百度云账户余额配置」。凭据值不会写进任何日志。');
  console.log('');
  process.exitCode = 1;
}).catch(function (e) {
  console.error('  [ERROR] 诊断脚本异常: ' + http.errText(e));
  process.exitCode = 1;
});
