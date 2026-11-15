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
  var a = p(['余额 ¥80.00']), b = p(['余额 ¥200.00']);
  I.markLow([a, b], 100);
  eq(a.low, true, '¥80 < 100');
  eq(b.low, false, '¥200 > 100');
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

check('GLM 多窗口：结构化产出前两个窗口及剩余比例', function () {
  var j = { data: { limits: [
    { number: 5, unit: 3, percentage: 0, nextResetTime: 1767225600000 },
    { number: 1, unit: 6, percentage: 12, nextResetTime: 1767312000000 },
    { number: 1, unit: 5, remaining: 4000, usage: 4000 }
  ] } };
  var r = I.glmLines(j);
  eq(r.windows.length, 2, '只下发前两个窗口');
  eq(r.windows[0].label, '5h', '第一窗口标签');
  eq(r.windows[1].label, '1周', '第二窗口标签');
  eq(r.windows[0].left, 100, '5 小时窗口剩余 100%');
  eq(r.windows[1].left, 88, '周窗口剩余 88%');
  eq(r.windows[0].text, '100%', '显示串');
  eq(r.lines.length, 1, 'lines 仍是单条，兼容旧前端');
  return 'windows 为增量字段，lines 原样保留';
});

check('任一窗口剩余 0 即标 low（周额度耗尽、5 小时仍充足）', function () {
  var a = p(['5h 剩100% · 1周 剩0%']);
  a.windows = [{ label: '5h', left: 100, text: '100%' }, { label: '1周', left: 0, text: '0%' }];
  I.markLow([a], 500);
  eq(a.low, true, '周窗口 0 应告警');
  return 'primaryAmount 为 null 也能识别不可用';
});

check('两个窗口都非 0 时不误报', function () {
  var a = p(['5h 剩99% · 1周 剩88%']);
  a.windows = [{ label: '5h', left: 99, text: '99%' }, { label: '1周', left: 88, text: '88%' }];
  I.markLow([a], 500);
  eq(a.low, false, '都还有额度');
  return '不影响普通多窗口显示';
});

check('失败行即使带零窗口也不打标', function () {
  var a = p([], false);
  a.windows = [{ label: '5h', left: 0, text: '0%' }];
  I.markLow([a], 500);
  eq(a.low, false, 'ok=false → low=false');
  return '网络失败不应误报额度耗尽';
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exitCode = 1;
