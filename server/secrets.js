'use strict';

/**
 * 凭据层：只在 PC 服务端进程内可见，永远不会进入 /api/board.json。
 *
 * 优先级：环境变量 > secrets.local.json（需 ACL 保护） > 空。
 * config.json 里只放非敏感参数，不要写任何 key / 密码。
 */

var fs = require('fs');
var path = require('path');

var ENV_MAP = {
  deepseekKey: ['DEEPSEEK_API_KEY'],
  kimiKey: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  glmKey: ['GLM_API_KEY', 'ZAI_API_KEY', 'BIGMODEL_API_KEY'],
  kimiEndpoint: ['KIMI_USAGE_ENDPOINT'],
  glmEndpoint: ['GLM_QUOTA_ENDPOINT'],
  caldavUser: ['FEISHU_CALDAV_USERNAME', 'CALDAV_USERNAME'],
  caldavPass: ['FEISHU_CALDAV_PASSWORD', 'CALDAV_PASSWORD'],
  caldavUrl: ['FEISHU_CALDAV_URL', 'CALDAV_URL'],
  baiduAk: ['BAIDU_CLOUD_AK', 'BAIDU_ACCESS_KEY_ID'],
  baiduSk: ['BAIDU_CLOUD_SK', 'BAIDU_SECRET_ACCESS_KEY'],
  tencentSecretId: ['TENCENTCLOUD_SECRET_ID', 'TENCENT_SECRET_ID'],
  tencentSecretKey: ['TENCENTCLOUD_SECRET_KEY', 'TENCENT_SECRET_KEY'],
  aliyunAk: ['ALIYUN_ACCESS_KEY_ID', 'ALICLOUD_ACCESS_KEY_ID'],
  aliyunSk: ['ALIYUN_ACCESS_KEY_SECRET', 'ALICLOUD_ACCESS_KEY_SECRET']
};

var fileSecrets = {};
var fileMtime = 0;
var fileNote = '';
/**
 * 默认放在项目根；Linux / systemd 下可用 KINDLE_BOARD_SECRETS_FILE 指到
 * /etc/kindle-board/secrets.json（root:root 600），把凭据移出应用目录。
 * sync-secrets.js 复用同一个 filePath，两处永远指向同一份文件。
 */
var FILE = process.env.KINDLE_BOARD_SECRETS_FILE
  ? path.resolve(process.env.KINDLE_BOARD_SECRETS_FILE)
  : path.join(__dirname, '..', 'secrets.local.json');

/** 空值判定：缺键 / null / 空串都算「未配置」 */
function emptyValue(v) {
  return v === undefined || v === null || String(v) === '';
}

/**
 * 键名归一化：去掉所有非字母数字字符并转小写。
 * kimiKey / kimikey → "kimikey"；KIMI_API_KEY / KIMIAPIKEY → "kimiapikey"。
 * 只用于第三层兜底，不改变「规范键名 > 环境变量别名」的既有优先级。
 */
function normKey(s) {
  return String(s).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * 按 mtime 热加载，不再一次性缓存。
 * 原因：Windows 的「用户」环境变量只被设置后新启动的进程继承；
 * 常驻服务进程看不到后来加的变量，所以配套 sync-secrets.ps1（Windows）/
 * sync-secrets.js（跨平台）把它们落到本文件。Linux 用 systemd EnvironmentFile
 * 可直接注入进程环境变量，连文件都不必生成。
 * 每次 statSync 开销可忽略（取数/健康检查才调用），换来「改凭据不必重启服务」。
 */
function loadFile() {
  var stat, raw, next, k;
  try { stat = fs.statSync(FILE); }
  catch (e) {
    if (Object.keys(fileSecrets).length) console.log('[secrets] 凭据文件已移除，清空内存缓存');
    fileSecrets = {};
    fileMtime = 0;
    fileNote = path.basename(FILE) + ' 不存在（用环境变量，或 npm run sync-secrets / sync-secrets.ps1 生成）';
    return;
  }
  if (stat.mtimeMs === fileMtime) return;
  fileMtime = stat.mtimeMs;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    next = {};
    for (k in ENV_MAP) {
      var val = raw[k];
      var aliases = ENV_MAP[k];
      var ai, alt;
      /**
       * 兼容写法：文件里也可以直接写环境变量名（例如 "BAIDU_CLOUD_AK"），
       * 作为规范键名（baiduAk）的别名兜底。用户很容易照着环境变量表填 JSON，
       * 旧版会静默忽略这些键，导致 /api/health 一直报 false 却查不出原因。
       * 规范键名优先；两者都存在时以规范键名为准。
       */
      if (emptyValue(val)) {
        for (ai = 0; ai < aliases.length; ai++) {
          alt = raw[aliases[ai]];
          if (!emptyValue(alt)) { val = alt; break; }
        }
      }
      /**
       * 第三层兜底：键名大小写 / 下划线写错。实测踩过 "kimikey"（少驼峰）、
       * "KIMIAPIKEY"（少下划线）两种，JSON 键名大小写敏感，旧版会静默忽略，
       * 表现为「明明配了却 /api/health 仍是 false」。
       * 把文件里的键归一化后，与「规范键名 + 所有环境变量别名」的归一化形式比对；
       * 排在规范键名和精确别名之后，不改变既有优先级。
       */
      if (emptyValue(val)) {
        var targets = [normKey(k)], rk, ti;
        for (ai = 0; ai < aliases.length; ai++) targets.push(normKey(aliases[ai]));
        for (rk in raw) {
          if (emptyValue(raw[rk])) continue;
          for (ti = 0; ti < targets.length; ti++) {
            if (normKey(rk) === targets[ti]) { val = raw[rk]; break; }
          }
          if (!emptyValue(val)) break;
        }
      }
      if (!emptyValue(val)) next[k] = String(val);
    }
    fileSecrets = next;
    fileNote = '已从 ' + path.basename(FILE) + ' 读取 ' + Object.keys(next).length + ' 项（热加载）';
  } catch (e) {
    fileNote = path.basename(FILE) + ' 解析失败: ' + e.message;
    console.warn('[secrets] ' + fileNote);
  }
}

/** 取一个凭据；缺失返回 ''，调用方据此把板块标成「未配置」而不是报错崩溃 */
function get(name) {
  var keys = ENV_MAP[name] || [];
  var i;
  for (i = 0; i < keys.length; i++) {
    if (process.env[keys[i]]) return String(process.env[keys[i]]);
  }
  loadFile();
  return fileSecrets[name] || '';
}

function has(names) {
  var i;
  for (i = 0; i < names.length; i++) {
    if (!get(names[i])) return false;
  }
  return true;
}

/** 只报告「有没有」，绝不报告值 */
function status() {
  loadFile();
  return {
    deepseekKey: !!get('deepseekKey'),
    kimiKey: !!get('kimiKey'),
    glmKey: !!get('glmKey'),
    caldav: has(['caldavUser', 'caldavPass']),
    caldavUrl: !!get('caldavUrl'),
    baiduCloud: has(['baiduAk', 'baiduSk']),
    tencentCloud: has(['tencentSecretId', 'tencentSecretKey']),
    aliyunCloud: has(['aliyunAk', 'aliyunSk']),
    fileNote: fileNote
  };
}

/** 日志脱敏：URL 里的 key/token/password 查询参数和 Bearer 头一律打码 */
function redact(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/([?&](?:api[_-]?key|token|key|password|pwd|secret|access_token)=)[^&\s]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***')
    .replace(/(Authorization:\s*Basic\s+)[A-Za-z0-9+/=]+/gi, '$1***');
}

/** 凭据「有无」签名（绝不含值），供聚合器检测变化后自动重取依赖板块 */
function signature() {
  loadFile();
  return ['caldavUser', 'caldavPass', 'caldavUrl', 'deepseekKey', 'kimiKey', 'glmKey',
    'baiduAk', 'baiduSk', 'tencentSecretId', 'tencentSecretKey', 'aliyunAk', 'aliyunSk']
    .map(function (k) { return k + ':' + (get(k) ? '1' : '0'); }).join('|');
}

module.exports = {
  get: get,
  has: has,
  status: status,
  signature: signature,
  redact: redact,
  // 供跨平台 sync-secrets.js 复用同一份映射与路径，避免两处清单走偏
  ENV_MAP: ENV_MAP,
  filePath: FILE
};
