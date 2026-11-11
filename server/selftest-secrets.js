'use strict';

/**
 * 凭据层键名容错 —— 离线自检。
 *
 * 不联网、不读真实 secrets.local.json、不打印任何真实值；
 * 用临时文件 + 子进程注入 KINDLE_BOARD_SECRETS_FILE 来隔离模块加载，
 * 所有测试值都是 FAKE_* 假字符串。
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-secrets-'));
var file = path.join(dir, 'probe.json');
var pass = 0;
var fail = 0;

function check(name, fn) {
  try { fn(); console.log('  [ok] ' + name); pass++; }
  catch (e) { console.log('  [FAIL] ' + name + ' → ' + e.message); fail++; }
}

function eq(a, b, why) {
  if (a !== b) throw new Error((why || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
}

/** 在干净子进程里加载 secrets.js（FILE 在模块加载时确定，必须用子进程隔离） */
function probe(rawObj, extraEnv) {
  fs.writeFileSync(file, JSON.stringify(rawObj));
  var env = Object.assign({}, process.env);
  delete env.KIMI_API_KEY;
  delete env.MOONSHOT_API_KEY;
  env.KINDLE_BOARD_SECRETS_FILE = file;
  Object.keys(extraEnv || {}).forEach(function (k) { env[k] = extraEnv[k]; });

  var mod = JSON.stringify(path.join(__dirname, 'secrets.js'));
  var script = 'var s=require(' + mod + ');' +
    'process.stdout.write(JSON.stringify({v:s.get("kimiKey"),has:s.status().kimiKey,note:s.status().fileNote}))';
  var out = cp.execFileSync(process.execPath, ['-e', script], { env: env, encoding: 'utf8' });
  return JSON.parse(out);
}

console.log('\n  凭据层键名容错自检');

check('规范键名 kimiKey 正常读取', function () {
  var r = probe({ kimiKey: 'FAKE_CANON' });
  eq(r.v, 'FAKE_CANON'); eq(r.has, true);
});

check('文件里写环境变量别名 KIMI_API_KEY 可读', function () {
  eq(probe({ KIMI_API_KEY: 'FAKE_ALIAS1' }).v, 'FAKE_ALIAS1');
});

check('文件里写第二个别名 MOONSHOT_API_KEY 可读', function () {
  eq(probe({ MOONSHOT_API_KEY: 'FAKE_ALIAS2' }).v, 'FAKE_ALIAS2');
});

check('大小写写错 kimikey 仍可读（归一化兜底）', function () {
  eq(probe({ kimikey: 'FAKE_LOWER' }).v, 'FAKE_LOWER');
});

check('别名少下划线 KIMIAPIKEY 仍可读（归一化兜底）', function () {
  eq(probe({ KIMIAPIKEY: 'FAKE_NOUS' }).v, 'FAKE_NOUS');
});

check('规范键名与错误键并存时规范键优先', function () {
  eq(probe({ kimikey: 'FAKE_WRONG', kimiKey: 'FAKE_RIGHT' }).v, 'FAKE_RIGHT');
});

check('环境变量优先级高于凭据文件', function () {
  eq(probe({ kimiKey: 'FAKE_FILE' }, { KIMI_API_KEY: 'FAKE_ENV' }).v, 'FAKE_ENV');
});

check('空字符串不算已配置', function () {
  var r = probe({ kimiKey: '' });
  eq(r.v, ''); eq(r.has, false);
});

check('完全没有该键时返回「未配置」', function () {
  var r = probe({ deepseekKey: 'FAKE_OTHER' });
  eq(r.v, ''); eq(r.has, false);
});

check('status / fileNote 只报告有无，不含密钥值', function () {
  var r = probe({ kimiKey: 'FAKE_SECRET_SHOULD_NOT_LEAK' });
  // 只检查 status() 的投影与 fileNote；r.v 是 get() 的正常返回值，本来就含值
  eq(JSON.stringify({ has: r.has, note: r.note }).indexOf('FAKE_SECRET_SHOULD_NOT_LEAK') >= 0, false);
  eq(r.has, true);
});

check('归一化兜底不会误吃别的键（glmKey 不串到 kimiKey）', function () {
  eq(probe({ glmKey: 'FAKE_GLM' }).v, '');
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log('\n  ' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
