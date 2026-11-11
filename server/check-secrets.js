'use strict';

/**
 * 提交前凭据扫描器（只报文件名 / 命中类型 / 次数，绝不打印匹配到的值）。
 *
 *   node server/check-secrets.js            # 扫描所有「会被提交」的文件
 *   node server/check-secrets.js --cached   # 只扫描本次暂存区（pre-commit 用）
 *
 * 检查对象由 git 自己给出，因此 .gitignore 已排除的文件不会被误报：
 *   默认   : git ls-files --cached --others --exclude-standard
 *   cached : git diff --cached --name-only --diff-filter=ACM
 *
 * 退出码 0 = 干净；1 = 发现疑似凭据；2 = 脚本自身出错。
 * 这是一个保守的防呆检查，会有误报；确认误报后可用 --no-verify 绕过。
 */

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var CACHED = process.argv.indexOf('--cached') >= 0;

/** secrets.local.json / secrets.json 里的规范键名，以及常见的环境变量别名 */
var SECRET_KEYS = {
  deepseekKey: 1, kimiKey: 1, glmKey: 1, kimiEndpoint: 1, glmEndpoint: 1,
  caldavUser: 1, caldavPass: 1, caldavUrl: 1,
  baiduAk: 1, baiduSk: 1,
  tencentSecretId: 1, tencentSecretKey: 1,
  aliyunAk: 1, aliyunSk: 1,
  BAIDU_CLOUD_AK: 1, BAIDU_CLOUD_SK: 1,
  KIMI_API_KEY: 1, MOONSHOT_API_KEY: 1, DEEPSEEK_API_KEY: 1,
  GLM_API_KEY: 1, ZAI_API_KEY: 1, BIGMODEL_API_KEY: 1,
  TENCENTCLOUD_SECRET_ID: 1, TENCENTCLOUD_SECRET_KEY: 1,
  ALIYUN_ACCESS_KEY_ID: 1, ALIYUN_ACCESS_KEY_SECRET: 1,
  FEISHU_CALDAV_USERNAME: 1, FEISHU_CALDAV_PASSWORD: 1
};

/** 明显是示例 / 假值 / 变量名 / 正则代码片段的字符串，不算真实凭据 */
function looksSafe(s) {
  return /FAKE|EXAMPLE|DUMMY|TEST_|REDACTED|PLACEHOLDER|CHANGEME|your[-_ ]|xxx|^\s*<|\$\{|\*\*\*/i.test(s) ||
    /(.)\1{7,}/.test(s) ||                         // 重复字符占位 / 固定测试向量，如 32 个 a
    /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(s) ||      // 纯标识符，如 signed.authorization
    /[\\(){}<>|$\]\['"`]/.test(s);                // 代码 / 正则片段，不是完整凭据
}

var PATTERNS = [
  { name: 'api-key(sk-)', rx: /\bsk-[A-Za-z0-9_\-]{16,}/g },
  { name: 'bce-signature', rx: /\bbce-auth-v1\/[A-Za-z0-9+/]{8,}/g },
  { name: 'access-key-id', rx: /\bAKID[A-Za-z0-9]{16,}/g },
  { name: 'private-key', rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'basic-auth-url', rx: /https?:\/\/[^/\s:@]+:[^/\s@]+@/g },
  { name: 'authorization-literal', rx: /Authorization\s*[:=]\s*['"]?([^\s'"\n]{20,})/g }
];

/** 不在 git 仓库里（例如树莓派上只拷了代码）时，退化为本地工作区扫描 */
function fallbackFiles() {
  var out = [];
  var SKIP_DIR = /^(node_modules|data|\.git|\.githooks|coverage)$/;
  var SKIP_FILE = /(^|\/)(secrets\.local\.json|secrets\.json|[^/]*\.local\.json|\.env[^/]*|[^/]*\.log|[^/]*\.tmp)$/;
  (function walk(dir, rel) {
    fs.readdirSync(dir).forEach(function (name) {
      var r = rel ? rel + '/' + name : name;
      var full = path.join(dir, name);
      var st;
      try { st = fs.statSync(full); } catch (e) { return; }
      if (st.isDirectory()) { if (!SKIP_DIR.test(name)) walk(full, r); }
      else if (st.isFile() && !SKIP_FILE.test(r)) out.push(r);
    });
  })(ROOT, '');
  return out;
}

function gitFiles() {
  var args = CACHED
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  try {
    var out = cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(function (s) { return s && s.trim(); });
  } catch (e) {
    // 非 git 工作区：仍要能扫，只是没有 .gitignore 的精确语义，用内置排除表兜底
    console.log('[check-secrets] 非 git 工作区，改用本地文件扫描。');
    return fallbackFiles();
  }
}

/** 这些文件里的长串是 integrity hash / 1x1 GIF / 签名构造代码，不是凭据 */
var SKIP_FILES = {
  'package-lock.json': 1,
  'npm-shrinkwrap.json': 1
};

function scanFile(rel) {
  if (SKIP_FILES[rel]) return [];
  var abs = path.join(ROOT, rel);
  var stat;
  try { stat = fs.statSync(abs); } catch (e) { return []; }
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return [];
  var text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
  if (/\u0000/.test(text)) return [];                       // 二进制

  var found = [];

  PATTERNS.forEach(function (p) {
    var m, n = 0;
    p.rx.lastIndex = 0;
    while ((m = p.rx.exec(text)) !== null) {
      var val = m[1] || m[0];
      if (!looksSafe(val)) n++;
      if (m[0].length === 0) p.rx.lastIndex++;              // 防零长匹配死循环
    }
    if (n) found.push({ type: p.name, count: n });
  });

  // JSON：敏感键有非空值 → 疑似真实凭据文件
  if (/\.json$/i.test(rel)) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { obj = null; }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      var nKeys = 0;
      Object.keys(obj).forEach(function (k) {
        if (!SECRET_KEYS[k]) return;
        var v = obj[k] === undefined || obj[k] === null ? '' : String(obj[k]);
        if (v.trim() && !looksSafe(v)) nKeys++;
      });
      if (nKeys) found.push({ type: 'json-secret-values', count: nKeys });
    }
  }

  // env / service / conf：KEY=VALUE 里的真实密钥赋值（排除路径型变量）
  if (/\.(example|env|service|conf)$/i.test(rel) || /(^|\/)env$/i.test(rel)) {
    var nEnv = 0;
    text.split(/\r?\n/).forEach(function (line) {
      var s = line.trim();
      if (!s || s.charAt(0) === '#') return;
      var mm = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(s);
      if (!mm) return;
      var k = mm[1], v = mm[2].trim().replace(/^['"]|['"]$/g, '');
      if (/_FILE$|_PATH$|_DIR$/.test(k)) return;            // 指向凭据文件的路径
      if (!/(SECRET|KEY|PASS|TOKEN|_AK$|_SK$|CREDENTIAL)/i.test(k)) return;
      if (!v || looksSafe(v)) return;
      if (/^(NO|YES|TRUE|FALSE|OFF|ON|\d+)$/i.test(v)) return;
      nEnv++;
    });
    if (nEnv) found.push({ type: 'env-secret-assignment', count: nEnv });
  }

  return found;
}

function main() {
  var files;
  try { files = gitFiles(); }
  catch (e) {
    console.error('[check-secrets] 无法读取 git 文件清单：' + e.message);
    process.exitCode = 2;
    return;
  }

  var total = 0;
  files.forEach(function (rel) {
    var hits = scanFile(rel);
    if (!hits.length) return;
    hits.forEach(function (h) {
      console.error('  [BLOCK] ' + rel + '  →  ' + h.type + ' × ' + h.count);
      total += h.count;
    });
  });

  if (total) {
    console.error('\n[check-secrets] 发现 ' + total + ' 处疑似凭据，提交已阻止。');
    console.error('（上方只列文件与类型，未打印任何值；确认误报请人工复核后再决定。）');
    process.exitCode = 1;
    return;
  }
  console.log('[check-secrets] OK：' + files.length + ' 个文件，未发现疑似凭据。');
}

main();
