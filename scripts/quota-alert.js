'use strict';

/**
 * AI 额度每日提醒：读本机 /api/board.json → 任一 provider.low 就发一封汇总邮件。
 *
 *   node scripts/quota-alert.js --dry-run    # 只检查/生成，不发送、不写去重标记
 *   node scripts/quota-alert.js --self-test  # 离线自检，不联网、不读凭据、不发信
 *   node scripts/quota-alert.js              # 正常发送（由 systemd user timer 调用）
 *
 * 约束：
 *   - 每天最多一封：用 data/quota-alert-sent 记录本地日期，当天已发就直接退出。
 *   - 无警示不发；额度板块整体不可用时也不发，避免误报。
 *   - 所有邮箱 / 主机 / 凭据都从环境变量读，脚本与仓库里不含任何真实值。
 *   - 密码经 --netrc-file 传给 curl，不出现在进程命令行或日志里。
 *   - 邮件走 UTF-8 + Base64（RFC 2047 标题），避免中文乱码。
 */

var fs = require('fs');
var path = require('path');
var http = require('http');
var cp = require('child_process');
var logger = require('../server/logger');

var DRY = process.argv.indexOf('--dry-run') >= 0;
var SELFTEST = process.argv.indexOf('--self-test') >= 0;
var ROOT = path.join(__dirname, '..');
var MARK = process.env.KB_ALERT_MARK || path.join(ROOT, 'data', 'quota-alert-sent');
var BOARD_URL = process.env.KB_BOARD_URL || 'http://127.0.0.1:8787/api/board.json';
var RECHARGE = Number(process.env.KB_ALERT_RECHARGE || 2000);

/* ---------------- 小工具 ---------------- */

function localDay() {
  var d = new Date();
  function p(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fail(msg) {
  logger.warn('[alert] ' + msg);   // 异常落到 data/board.log，便于回看
  console.error('[quota-alert] ' + msg);
  process.exit(1);
}

function required(name) {
  var v = process.env[name];
  if (!v) fail('缺少环境变量 ' + name);
  return String(v);
}

/** 与服务端 primaryAmount 同规则：展示文本里第一个 ¥ 金额 */
function amountOf(p) {
  var lines = (p && p.lines) || [];
  var m = /¥\s*(-?\d+(?:\.\d+)?)/.exec(lines.join(' · '));
  if (!m) return null;
  var v = Number(m[1]);
  return isFinite(v) ? v : null;
}

function nameOf(p) { return (p && (p.label || p.id)) || '未知账号'; }

function brief(p) {
  var lines = (p && p.lines) || [];
  var main = lines.length ? String(lines[0]).replace(/\s+/g, ' ').trim() : '无数据';
  var state = !p.ok ? '取数失败' : (p.low ? '告警' : '正常');
  return nameOf(p) + '：' + main + '（' + state + '）';
}

function windowBrief(p) {
  var ws = (p && p.windows) || [];
  if (!ws.length) return '';
  return ws.map(function (w) { return w.label + ' 剩' + w.left + '%'; }).join(' / ');
}

/* ---------------- 邮件内容 ---------------- */

/** 正文先讲不足，再概要其它账号；标题按「余额最低的告警账号」生成 */
function buildMail(alerts, all) {
  var withAmount = alerts.filter(function (p) { return amountOf(p) !== null; });
  var lead;
  if (withAmount.length) {
    withAmount.sort(function (a, b) { return amountOf(a) - amountOf(b); });
    lead = withAmount[0];
  } else {
    lead = alerts[0];
  }

  var amount = amountOf(lead);
  var subject = amount === null
    ? nameOf(lead) + '额度已用尽，申请充值 ' + RECHARGE + '元'
    : nameOf(lead) + '余额' + Math.round(amount) + '元，申请充值 ' + RECHARGE + '元';

  var body = [];
  body.push('【余额不足】');
  alerts.forEach(function (p) {
    var a = amountOf(p);
    var desc = a === null ? (windowBrief(p) || brief(p)) : ('当前余额 ' + a.toFixed(2) + ' 元');
    body.push('- ' + nameOf(p) + '：' + desc + '，已低于警示阈值，需要充值。');
  });
  body.push('');
  body.push('申请充值 ' + RECHARGE + ' 元，请协助处理。');
  body.push('');
  body.push('【其它账号余额概览】');
  var others = all.filter(function (p) { return alerts.indexOf(p) < 0; });
  if (!others.length) body.push('（无其它账号）');
  others.forEach(function (p) { body.push('- ' + brief(p)); });
  body.push('');
  body.push('本邮件由 Kindle 看板自动发出，每天最多一封；无警示则不发送。');
  return { subject: subject, body: body.join('\n') };
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

/**
 * RFC 2047：单个 encoded-word 不得超过 75 字符，且不能把 UTF-8 多字节字符切开。
 * 每片最多 45 字节 ⇒ base64 ≤60 字符 ⇒ 整词 ≤72 字符；多片用 CRLF + 空格折叠，
 * 解码时相邻 encoded-word 之间的空白会被忽略。
 */
function utf8Chunks(s, maxBytes) {
  var out = [], cur = '', used = 0, i, ch, code, size;
  for (i = 0; i < s.length; i++) {
    ch = s.charAt(i);
    code = s.charCodeAt(i);
    // 合并代理对，避免把 BMP 外字符拆成两半
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
      ch += s.charAt(i + 1);
      i++;
    }
    size = Buffer.byteLength(ch, 'utf8');
    if (cur && used + size > maxBytes) { out.push(cur); cur = ''; used = 0; }
    cur += ch;
    used += size;
  }
  if (cur) out.push(cur);
  return out;
}

function encodeSubject(s) {
  return utf8Chunks(String(s), 45).map(function (part) {
    return '=?UTF-8?B?' + b64(part) + '?=';
  }).join('\r\n ');
}

/** RFC 822 + RFC 2047：中文标题编码、正文 Base64，补 Date 头提高投递率 */
function mime(subject, body, from, to) {
  var wrapped = b64(body).replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
  return [
    'From: ' + from,
    'To: ' + to,
    'Date: ' + new Date().toUTCString(),
    'Subject: ' + encodeSubject(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped,
    ''
  ].join('\r\n');
}

/* ---------------- 去重与发送 ---------------- */

function alreadySent(day) {
  try { return fs.readFileSync(MARK, 'utf8').trim() === day; } catch (e) { return false; }
}

function markSent(day) {
  var dir = path.dirname(MARK);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(MARK, day + '\n', { mode: 0o600 });
}

function send(mailText) {
  var host = required('KB_SMTP_HOST');
  var port = required('KB_SMTP_PORT');
  var from = required('KB_SMTP_FROM');
  var to = required('KB_MAIL_TO');
  var args = [
    '--silent', '--show-error', '--fail',
    '--url', 'smtps://' + host + ':' + port,
    '--ssl-reqd',
    '--mail-from', from,
    '--mail-rcpt', to,
    '--upload-file', '-',
    '--max-time', '30'
  ];
  // 凭据走 netrc，绝不拼进 argv
  if (process.env.KB_SMTP_NETRC) args.push('--netrc-file', process.env.KB_SMTP_NETRC);
  cp.execFileSync('curl', args, {
    input: mailText,
    encoding: 'utf8',
    timeout: 40000,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

/* ---------------- 主流程 ---------------- */

function handle(payload) {
  var q = payload && payload.blocks && payload.blocks.quota;
  if (!q || !q.ok) fail('额度板块不可用，本次不发信');
  var ps = (q.data && q.data.providers) || [];
  var alerts = ps.filter(function (p) { return p && p.low === true; });
  if (!alerts.length) { console.log('[quota-alert] 无警示，跳过'); return; }

  var day = localDay();
  if (alreadySent(day)) { console.log('[quota-alert] 当日已发送，跳过'); return; }

  var mail = buildMail(alerts, ps);
  if (DRY) {
    // 只输出结构摘要：不打印余额、邮箱或任何凭据
    console.log('[quota-alert] dryRun=true alerts=' + alerts.length +
      ' others=' + (ps.length - alerts.length) +
      ' subjectBytes=' + Buffer.byteLength(mail.subject, 'utf8') +
      ' bodyBytes=' + Buffer.byteLength(mail.body, 'utf8') +
      ' recipientConfigured=' + Boolean(process.env.KB_MAIL_TO) +
      ' wouldSend=true');
    return;
  }

  try {
    send(mime(mail.subject, mail.body, required('KB_SMTP_FROM'), required('KB_MAIL_TO')));
    markSent(day);
    logger.info('[alert] 已发送额度提醒邮件（当日不再重发）');
    console.log('[quota-alert] 已发送并记录当日标记');
  } catch (e) {
    // curl 的错误输出可能含主机，但绝不含 netrc 里的密码；截断避免日志膨胀
    fail('发送失败: ' + String((e && e.stderr) || (e && e.message) || e).slice(0, 160));
  }
}

function main() {
  http.get(BOARD_URL, function (res) {
    var b = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { b += c; });
    res.on('end', function () {
      var j;
      try { j = JSON.parse(b); } catch (e) { fail('board.json 解析失败'); }
      handle(j);
    });
  }).on('error', function (e) { fail('读取 board.json 失败: ' + e.message); });
}

/* ---------------- 离线自检 ---------------- */

function runSelfTest() {
  var os = require('os');
  process.env.KINDLE_BOARD_LOG = '0';   // 自检不污染真实 data/board.log
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-alert-selftest-'));
  var pass = 0;
  function ok(cond, label) {
    if (!cond) { fs.rmSync(tmp, { recursive: true, force: true }); fail('自检失败: ' + label); }
    pass++;
  }

  var providers = [
    { id: 'a', label: '甲账号', ok: true, low: true, lines: ['余额 ¥326.50'] },
    { id: 'b', label: '乙账号', ok: true, low: true, lines: ['余额 ¥128.00'] },
    { id: 'c', label: '丙账号', ok: true, low: true, lines: ['5h 剩99% · 1周 剩0%'],
      windows: [{ label: '5h', left: 99 }, { label: '1周', left: 0 }] },
    { id: 'd', label: '丁账号', ok: true, low: false, lines: ['余额 ¥800.00'] },
    { id: 'e', label: '戊账号', ok: false, low: false, lines: [], error: '未配置' }
  ];
  var alerts = providers.filter(function (p) { return p.low; });

  ok(amountOf(providers[0]) === 326.5, '提取 ¥ 金额');
  ok(amountOf(providers[2]) === null, '百分比账号无金额');
  var mail = buildMail(alerts, providers);
  ok(/乙账号余额128元，申请充值 2000元$/.test(mail.subject), '标题取余额最低者并带充值额');
  ok(mail.body.indexOf('【余额不足】') === 0, '正文先讲不足');
  ok(mail.body.indexOf('【其它账号余额概览】') > 0, '正文再讲其它账号');
  ok(mail.body.indexOf('丁账号') > mail.body.indexOf('【其它账号余额概览】'), '正常账号归入概览');
  ok(mail.body.indexOf('1周 剩0%') > 0, '零窗口告警有说明');
  ok(mail.body.indexOf('申请充值 2000 元') > 0, '正文含充值金额');

  var enc = mime(mail.subject, mail.body, 'from@example.test', 'to@example.test');
  ok(enc.indexOf('Subject: =?UTF-8?B?') > 0, '标题 RFC 2047 编码');
  ok(enc.indexOf('Content-Transfer-Encoding: base64') > 0, '正文 Base64');
  ok(enc.indexOf('Content-Type: text/plain; charset=UTF-8') > 0, '正文声明 UTF-8');
  ok(/^Date: .+ GMT$/m.test(enc), '邮件带 RFC 822 Date 头');

  var longSubject = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥余额326元，申请充值 2000元';
  var words = encodeSubject(longSubject).split('\r\n ');
  ok(words.length > 1, '长中文标题拆成多个 encoded-word');
  ok(words.every(function (w) {
    return w.length <= 75 && /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w);
  }), '每个 encoded-word ≤75 字符');
  var restored = words.map(function (w) {
    return Buffer.from(w.slice(10, -2), 'base64').toString('utf8');
  }).join('');
  ok(restored === longSubject, '长中文标题可无损还原');
  ok(mime(longSubject, mail.body, 'a@example.test', 'b@example.test')
    .indexOf('Subject: =?UTF-8?B?') > 0, '长标题仍走 RFC 2047');

  MARK = path.join(tmp, 'sent');
  var day = localDay();
  ok(!alreadySent(day), '初始未发送');
  markSent(day);
  ok(alreadySent(day), '写入后当日已发送');
  ok(fs.readFileSync(MARK, 'utf8').trim().length === 10, '标记是本地日期');
  markSent(day);
  ok(fs.readdirSync(tmp).length === 1, '重复写不产生多余文件');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('  [ok] 邮件提醒自检：标题 / 正文结构 / 编码 / 当日去重  → ' + pass + ' 项');
  console.log('\n  1 通过 / 0 失败');
}

if (SELFTEST) runSelfTest();
else main();
