'use strict';

/**
 * 额度板块「条件格式」离线自检：金额提取、低于阈值判定、重置时间归属。
 * 不联网、不读凭据、不发请求。
 *
 *   node server/selftest-quota.js
 */

var quota = require('./fetchers/quota');
var I = quota.__internals || {};

var pass = 0;
var fail = 0;
function check(name, fn) {
  try { var d = fn(); pass++; console.log('  [ok] ' + name + (d ? '  → ' + d : '')); }
  catch (e) { fail++; console.log('  [FAIL] ' + name + '  → ' + e.message); }
}
function eq(a, b, label) {
  if (a !== b) throw new Error((label || '值') + ' 不符: 实际=' + JSON.stringify(a) + ' 期望=' + JSON.stringify(b));
}
function p(lines, ok) {
  return { id: 'x', label: 'X', ok: ok === undefined ? true : ok, lines: lines };
}

console.log('额度条件格式自检');

check('主金额：正数带小数', function () {
  eq(I.primaryAmount(['余额 ¥1234.56']), 1234.56);
  return '¥1234.56';
});

check('主金额：负数（欠费/不可用）', function () {
  eq(I.primaryAmount(['余额 ¥-1.23 · 不可用']), -1.23);
  return '¥-1.23';
});

check('主金额：一行多个金额时取第一个', function () {
  eq(I.primaryAmount(['可用 ¥0 · 现金 ¥-9.87']), 0);
  return '可用 ¥0 是主金额，现金 ¥-9.87 不参与判定';
});

check('主金额：GLM 百分比/次数行没有金额', function () {
  eq(I.primaryAmount(['5h 剩99% · 1周 剩90% · 1月 余4000/4000']), null);
  return '无 ¥ → null，不会被误判成低于 500';
});

check('主金额：空列表 / 非金额文本', function () {
  eq(I.primaryAmount([]), null);
  eq(I.primaryAmount(['已连接，响应结构未识别']), null);
  return '均返回 null';
});

check('条件格式：严格「低于」阈值', function () {
  var a = p(['余额 ¥499.99']), b = p(['余额 ¥500.00']), c = p(['余额 ¥500.01']);
  I.markLow([a, b, c], 500);
  eq(a.low, true, '499.99');
  eq(b.low, false, '500.00（等于阈值不加粗）');
  eq(c.low, false, '500.01');
  return '499.99 加粗；500.00 / 500.01 不加粗';
});

check('条件格式：负数与 0 也算低于阈值', function () {
  var a = p(['余额 ¥-1.23 · 不可用']), b = p(['可用 ¥0']);
  I.markLow([a, b], 500);
  eq(a.low, true, '负数');
  eq(b.low, true, '0');
  return '低余额/欠费最需要醒目';
});

check('条件格式：失败行即使文本里有金额也不加粗', function () {
  var a = p(['余额 ¥1.00'], false);
  I.markLow([a], 500);
  eq(a.low, false);
  return 'ok=false → low=false';
});

check('条件格式：阈值可配置', function () {
  var a = p(['余额 ¥88.00']), b = p(['余额 ¥120.50']);
  I.markLow([a, b], 100);
  eq(a.low, true, '¥88 < 100');
  eq(b.low, false, '¥120.50 > 100');
  return 'board.lowBalanceThreshold 生效';
});

check('默认阈值是 500', function () {
  eq(I.LOW_DEFAULT, 500);
  var a = p(['余额 ¥499']);
  I.markLow([a], undefined);
  eq(a.low, true, '未传阈值时走默认');
  return 'LOW_DEFAULT=500';
});

check('「下次重置」留在 provider 上，不再汇总到板块底部 note', function () {
  var glm = { id: 'glm', label: 'GLM', ok: true, lines: ['5h 剩99%'], resetText: '11/09 07:00' };
  var d = I.summarize([glm], 500);
  eq(d.note, '', 'note 应为空（前端挂到行下方）');
  eq(d.providers[0].resetText, '11/09 07:00', 'resetText 保留');
  return 'note="" + provider.resetText';
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exitCode = 1;
