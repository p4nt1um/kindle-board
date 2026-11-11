'use strict';

/**
 * 农历计算（纯本地，零上游依赖）。
 * 不再是独立板块：2026-11-10 起农历板块已从 layout / registry 移除，
 * 本模块由 clock.js 复用，结果拼进时钟板块标题行的 titleText。
 * 用 Node 内置 ICU 的 chinese calendar（本机 ICU 78.2 实测支持闰月与干支年）：
 *   new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {...}).formatToParts(d)
 *   -> relatedYear=2026, month="闰六月", day="1"
 * 这样不必内置 1900-2100 lunarInfo 表，也不会在老 Kindle 上跑任何历法代码。
 */

var ZODIAC = {
  '子': '鼠', '丑': '牛', '寅': '虎', '卯': '兔', '辰': '龙', '巳': '蛇',
  '午': '马', '未': '羊', '申': '猴', '酉': '鸡', '戌': '狗', '亥': '猪'
};
var CN_NUM = ['', '正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
var CN_DAY = ['', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];

/* 键 = 数字月 + '-' + 日（monthKey 返回数字），闰月不重复过节 */
var LUNAR_FESTIVALS = {
  '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节',
  '7-7': '七夕', '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节',
  '12-8': '腊八节', '12-23': '北方小年', '12-24': '南方小年'
};
var SOLAR_FESTIVALS = {
  '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '3-12': '植树节',
  '4-1': '愚人节', '5-1': '劳动节', '5-4': '青年节', '6-1': '儿童节',
  '7-1': '建党节', '8-1': '建军节', '9-10': '教师节', '10-1': '国庆节',
  '11-11': '双十一', '12-24': '平安夜', '12-25': '圣诞节'
};
var WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

var fmtLunar = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric'
});
var fmtSolar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});

function shanghaiParts(d) {
  var a = fmtSolar.formatToParts(d);
  var p = {};
  var i;
  for (i = 0; i < a.length; i++) p[a[i].type] = a[i].value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    weekday: WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()],
    key: Number(p.month) + '-' + Number(p.day)
  };
}

function monthKey(s) {
  var m = s.replace('闰', '').replace('月', '');
  if (m === '十一') return '11';
  if (m === '十二') return '12';
  var n = CN_NUM.indexOf(m);
  return n > 0 ? String(n) : '?';
}

function sync(at) {
  var now = at ? new Date(at) : new Date();
  var solar = shanghaiParts(now);
  var raw = fmtLunar.format(now);
  var parts = fmtLunar.formatToParts(now);
  var m = '', dy = '', relatedYear = solar.year, i;

  for (i = 0; i < parts.length; i++) {
    if (parts[i].type === 'month') m = parts[i].value;
    else if (parts[i].type === 'day') dy = parts[i].value;
    else if (parts[i].type === 'relatedYear') relatedYear = Number(parts[i].value);
  }

  var leap = m.indexOf('闰') === 0;
  var mk = monthKey(m);
  var dayNum = Number(dy) || 0;
  var ganzhiMatch = raw.match(/([甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥])年/);
  var ganzhi = ganzhiMatch ? ganzhiMatch[1] : '';
  var branch = ganzhi.charAt(1);

  // 除夕：明天的农历是正月初一
  var tomorrow = new Date(now.getTime() + 86400000);
  var tm = '';
  var td = '';
  var tp = fmtLunar.formatToParts(tomorrow);
  for (i = 0; i < tp.length; i++) {
    if (tp[i].type === 'month') tm = tp[i].value;
    else if (tp[i].type === 'day') td = tp[i].value;
  }
  var isNewYearEve = tm === '正月' && td === '1';

  var lunarFestival = isNewYearEve ? '除夕' : (LUNAR_FESTIVALS[mk + '-' + dayNum] || '');
  // 闰月不重复过节日
  if (leap) lunarFestival = '';
  var solarFestival = SOLAR_FESTIVALS[solar.key] || '';
  var festival = [lunarFestival, solarFestival].filter(function (x) { return x; }).join(' · ');

  return {
    dateText: solar.year + '年' + solar.month + '月' + solar.day + '日 星期' + solar.weekday,
    lunarText: '农历' + (leap ? '闰' : '') + m.replace('闰', '') + (CN_DAY[dayNum] || ('初' + dy)),
    ganzhi: ganzhi,
    zodiac: ZODIAC[branch] || '',
    yearText: ganzhi ? ganzhi + '年 [' + (ZODIAC[branch] || '') + '年]' : String(relatedYear),
    leap: leap,
    festival: festival,
    note: '数据源：Node ICU chinese calendar（本地计算，无网络依赖）'
  };
}

function fetch() { return Promise.resolve(sync()); }
fetch.sync = sync;

module.exports = fetch;
