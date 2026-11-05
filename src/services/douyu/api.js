// 斗鱼 API 客户端（笔端直连 www.douyu.com）。
//
// 契约来源：docs/douyu-integration.md §1（Lead 本机 node 实测通过，参数**一个字节都不能改**）。
// 本文件在 doc 基础上补充的实测结论（2026-11-04，本机 node fetch，同 UA/Referer）：
//
//   A. 取流 URL 长度：enc_data 实测 696 字符，encodeURIComponent 后整条 getH5PlayV1
//      URL 约 **900 字符**（远低于 2000）→ 不需要为长度操心。
//      **但 HTTP 方法必须是 POST**（2026-11 实测，240 间房）：
//        GET  成功 42/240（17.5%），POST 成功 240/240（100%）；
//        再用 POST-first 顺序复测 30 间排除时序/限流混淆 → POST 30/30、GET 12/30。
//      GET 失败时服务端返回的仍是 HTTP 200 + error:-15「非法请求」，与「房间不存在」
//      长得一模一样 → 改 POST 之前，那 83% 的「未开播」全是我方误判。
//      参数仍旧全放 URL query、body 留空即可（实测 20/20 成功），
//      所以不需要走 native 的 form POST（那个能给 body，但没必要）。
//   B. getEncryption 的 expire_at 实测 = now + 601s，enc_time 实测恒为 1（循环 1 次）。
//      f（派生密钥）只在 key/rand_str 变化时失效 → 按 expire_at 缓存，多码率切换复用，
//      **每次仍单独签名请求**（doc 要求，改 URL 后缀会 403）。
//   C. 错误语义实测（与 net.js 的两段式不同，必须分开判定）：
//        HTTP 403（net.js 报 error:3 / resCode:403） → auth 或 did 不一致（签名被拒）
//        HTTP 200 + error:-3                         → 房间不存在
//        HTTP 200 + error:-4                         → 房间被封禁
//        HTTP 200 + error:-5                         → 房间未开播（**真正的「未开播」**）
//        HTTP 200 + error:-15                        → GET 时代的万能错误码，POST 后基本见不到
//        HTTP 200 + error:-9  + msg「时间戳错误」    → 设备时钟偏差（ts 秒级必须准）
//        HTTP 200 + error:1000                       → did 为空
//        HTTP 200 + error:0                          → data.rtmp_url + '/' + data.rtmp_live
//      注：-3/-4/-5 这一层精细区分是**改 POST 之后才得到的**。GET 时代服务端把所有
//      失败统一糊成 -15「非法请求」，所以那时「未开播」在客户端根本无从判断。
//   D. rate 请求**不保证被遵守**：同一房间不同时刻实测出现过
//        rate=0 → 返回 4 / rate=4 → 返回 0（原画）/ rate=4 → 返回 4
//      即服务端按房间实际可用档位就近取，同一请求参数结果可能不同。
//      → 所以返回值必须带服务端实际 rate，UI 不能拿请求参数当结果；
//        想稳定要某档应校验返回的 rate 并在不匹配时重取。
//
// 约束（doc §2）：所有函数 catch，绝不 throw；日志走 storage.js 的 logWarn。
import { httpGet, httpPost, tryParseJson } from '../net.js';
import { logWarn, getString, setString, memoryPeek } from '../storage.js';
import { md5Hex } from '../md5.js';

export const DOUYU_HOST = 'https://www.douyu.com';
// 斗鱼风控只认浏览器 UA（按 docs §1 实测可用的 Chrome/120 串写死，勿改）
export const DOUYU_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const DOUYU_REFERER = 'https://www.douyu.com/';

// 取流参数（docs §1，实测通过，禁止改动）
export const PLAY_VER = 'Douyu_224011102'; // 'Douyu_new' 会返回纯文本「鉴权失败」
export const DEFAULT_RATE = 2; // 高清 900kbps，笔端最稳（doc §3）
// GET 取流的 URL 长度软上限：实测约 900 字符；超过只告警不改变行为
export const PLAY_URL_SOFT_LIMIT = 2000;

export const DID_KEY = 'douyu_did'; // 独立 storage key，与其它模块互不干扰

export const ENCRYPTION_PATH = '/wgapi/livenc/liveweb/websec/getEncryption';

// 斗鱼请求头（net.js 会转成运行时需要的 header 单数对象）
export function douyuHeaders(extra) {
  const h = {
    'User-Agent': DOUYU_UA,
    Referer: DOUYU_REFERER,
    Origin: 'https://www.douyu.com',
    Accept: 'application/json, text/plain, */*'
  };
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) h[k] = extra[k];
  }
  return h;
}

/**
 * 斗鱼 JSON 请求。返回 { ok, data, error, errorText, statusCode }，**不 throw**。
 *
 * 注意 net.js 的语义：非 2xx 时 body 不可得，只能拿到 'curl ... resCode:N' 文本，
 * 所以这里把 statusCode 非 2xx 单独归一成 NET 错误，交给调用方按码分支。
 *
 * `opts.method` 默认 'GET'；只有取流（getH5PlayV1）需要传 'POST'，原因见 fetchPlayInfo。
 * POST 也不发请求体 —— 参数依旧全部在 URL query 上（net.js 的 httpRequest 刻意不带 data）。
 *
 * @param {string} url 绝对 URL（调用方负责拼 query）
 * @param {{timeout?: number, tag?: string, method?: string}} [opts]
 */
export async function douyuGetJson(url, opts) {
  const o = opts || {};
  const tag = o.tag || 'douyu';
  const method = typeof o.method === 'string' ? o.method.toUpperCase() : 'GET';
  let res;
  try {
    const send = method === 'POST' ? httpPost : httpGet;
    res = await send(url, { headers: douyuHeaders(), timeout: o.timeout || 15000 });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    logWarn('[douyu] ' + tag + ' 传输失败: ' + msg);
    return { ok: false, data: null, error: 'NETWORK', errorText: msg, statusCode: 0 };
  }
  const status = (res && res.statusCode) || 0;
  if (status && (status < 200 || status >= 300)) {
    const txt = (res && res.errorMessage) || ('HTTP ' + status);
    logWarn('[douyu] ' + tag + ' HTTP ' + status);
    return { ok: false, data: null, error: 'HTTP_' + status, errorText: txt, statusCode: status };
  }
  const json = tryParseJson(res && res.body);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    // 字符串 body 说明既不是 JSON 也不是空 → 多半是被风控/鉴权拦下来的纯文本
    const raw = typeof json === 'string' ? json : '';
    logWarn('[douyu] ' + tag + ' 响应非 JSON: ' + raw.slice(0, 80));
    return {
      ok: false,
      data: null,
      error: 'BAD_RESPONSE',
      errorText: raw.slice(0, 120) || '响应不是 JSON',
      statusCode: status
    };
  }
  return { ok: true, data: json, error: 0, errorText: '', statusCode: status, json: json };
}

// 斗鱼业务码 → 人话（探针实测到的都收了；未收录的码原样带出）
//
// ⚠️ 取流从 GET 改成 POST 之后，错误码**变精细了**（实测于 2026-11）：
//    GET 时代所有失败都被糊成 -15「非法请求」，与「房间不存在」无法区分；
//    POST 之后服务端给出真正的成因：
//      -3 房间不存在（rid=1/3/12345/999999999 实测）
//      -4 房间被封禁（rid=2 实测）
//      -5 房间未开播（rid=99 实测，这才是真正的「未开播」）
//      -9 时间戳错误（设备时钟偏差）
//    -15 仍保留识别（老版本/异常路径还可能吐它），但已不再是主力。
export function describeDouyuError(code, msg) {
  const m = typeof msg === 'string' ? msg : '';
  switch (code) {
    case -3:
      return '房间不存在(-3)';
    case -4:
      return '房间被封禁(-4)';
    case -5:
      return '主播未开播(-5)';
    case -15:
      // GET 时代的「万能错误码」：取流用 GET 时有 83% 的正常房间被它拒掉。
      // 现在走 POST 基本见不到，保留识别只为兜底（语义按「房间不存在/不可播」）。
      return '房间不存在(-15)';
    case -9:
      return '时间戳错误(-9)：设备时钟不准，请校对时间';
    case -1:
      return '斗鱼拒绝请求(-1)';
    case 1000:
      return 'did 参数无效(1000)';
    case 1003:
      return '签名失效(1003)：请重试';
    case 1005:
      return '请求过频(1005)：稍后再试';
    default:
      if (m) return m + '(' + code + ')';
      return typeof code === 'number' ? '斗鱼错误(' + code + ')' : '斗鱼请求失败';
  }
}

// ---- did（设备匿名标识）----
// 32 位小写 hex。实测服务端只要求「非空」，格式不校验（probe: did=abc 也返回 200 + key），
// 但 web 侧实现是 32 位 hex，跟齐以免日后风控收紧。
// 关键约束：取流热路径不能等 storage（getStorage 是异步且最坏 5s 超时）
//   → getCachedDid() 同步读内存；ensureDid() 异步加载/生成（页面启动时预热）。

let cachedDid = ''; // 内存缓存：有值后 getCachedDid() 同步可用
let loadingDid = null; // 并发去重

/**
 * 同步取 did。未预热时返回 ''（调用方必须能容忍空 → 用 ensureDid 预热）。
 * @returns {string}
 */
export function getCachedDid() {
  if (cachedDid) return cachedDid;
  // storage.js 有内存镜像，App 启动后通常已经读到（跨模块共享）
  const peek = memoryPeek(DID_KEY);
  if (peek && /^[0-9a-f]{32}$/.test(peek)) {
    cachedDid = peek;
    return cachedDid;
  }
  return '';
}

// 16 字节 → 32 位小写 hex（QuickJS 有 Math.random；did 只是匿名标识，不需要密码学强度）
function randomDid() {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex.charAt(Math.floor(Math.random() * 16));
  return s;
}

/**
 * 确保 did 可用：优先内存 → storage → 生成并写回。**不 throw**，最坏也返回一个内存 did。
 * 页面启动时调用一次即可；调用后 getCachedDid() 同步可用。
 * @returns {Promise<string>}
 */
export async function ensureDid() {
  if (cachedDid) return cachedDid;
  if (loadingDid) return loadingDid;
  loadingDid = (async () => {
    let v = '';
    try {
      v = await getString(DID_KEY, '');
    } catch (e) {
      v = '';
    }
    if (v && /^[0-9a-f]{32}$/.test(v)) {
      cachedDid = v;
      return cachedDid;
    }
    // 没有 / 格式不对 → 生成新的并持久化（写失败也照用内存值，取流不能被 storage 阻塞）
    const gen = randomDid();
    cachedDid = gen;
    try {
      // setString 内部串行 + 3s 超时 + 回读校验，这里不 await 校验结果
      setString(DID_KEY, gen);
    } catch (e) {
      logWarn('[douyu] did 写入失败: ' + ((e && e.message) || e));
    }
    return cachedDid;
  })();
  try {
    return await loadingDid;
  } finally {
    loadingDid = null;
  }
}

// ---- 取流签名 ----

/**
 * 派生签名密钥：f = rand_str；循环 enc_time 次 f = md5(f + key)。
 * 单独导出便于单测用 node crypto 对拍（doc §1 明确要求这个循环形式）。
 * @param {string} randStr
 * @param {string} key
 * @param {number} encTime
 * @returns {string}
 */
export function deriveSigningKey(randStr, key, encTime) {
  let f = typeof randStr === 'string' ? randStr : '';
  const k = typeof key === 'string' ? key : '';
  const times = Number(encTime) || 0;
  for (let i = 0; i < times; i++) f = md5Hex(f + k);
  return f;
}

/**
 * 取流签名（doc §1）：auth = md5(f + key + String(rid) + String(ts))，ts 为秒级。
 * 单独导出便于单测对拍 node crypto。
 * @param {string} f
 * @param {string} key
 * @param {number|string} rid
 * @param {number} ts 秒
 * @returns {string}
 */
export function buildAuth(f, key, rid, ts) {
  return md5Hex(String(f) + String(key) + String(rid) + String(ts));
}

// getEncryption → {did, key, rand_str, enc_time, enc_data, expire_at, f}
// 缓存复用：f 由 key/rand_str/enc_time 决定，同 did 下每次结果一样，没必要重复算 md5 链
let encCache = null; // {did, at, value}

function isEncFresh(c) {
  if (!c || !c.value) return false;
  // expire_at 是服务端给的密钥到期时间（秒）；留 30s 余量，避免边界上刚好失效
  const exp = Number(c.value.expire_at) || 0;
  if (!exp) return Date.now() - c.at < 120000; // 没给到期时间就保守 2 分钟
  return Date.now() / 1000 < exp - 30;
}

/**
 * 拉一次加密参数并派生出 f。失败返回 null（已记日志）。
 * @param {string} did
 * @returns {Promise<object|null>}
 */
async function getEncryption(did) {
  if (encCache && encCache.did === did && isEncFresh(encCache)) return encCache.value;

  const url = DOUYU_HOST + ENCRYPTION_PATH + '?did=' + encodeURIComponent(did);
  const r = await douyuGetJson(url, { tag: 'getEncryption' });
  if (!r.ok) return null;
  if (Number(r.json.error) !== 0) {
    logWarn('[douyu] getEncryption 业务错误: ' + r.json.error);
    return null;
  }
  const d = r.json.data;
  if (!d || typeof d.key !== 'string' || !d.key || typeof d.enc_data !== 'string' || !d.enc_data) {
    logWarn('[douyu] getEncryption 字段缺失');
    return null;
  }
  const f = deriveSigningKey(typeof d.rand_str === 'string' ? d.rand_str : '', d.key, d.enc_time);

  const value = {
    key: d.key,
    enc_data: d.enc_data,
    expire_at: Number(d.expire_at) || 0,
    f: f
  };
  encCache = { did: did, at: Date.now(), value: value };
  return value;
}

/**
 * 拼 getH5PlayV1 URL（纯函数，便于单测对拍）。
 * @param {number|string} rid
 * @param {number} rate
 * @param {{did: string, enc_data: string, key: string, f: string}} enc
 * @param {number} ts 秒级
 * @returns {string}
 */
export function buildPlayUrl(rid, rate, enc, ts) {
  const auth = buildAuth(enc.f, enc.key, rid, ts);
  // 参数顺序按 docs §1 原样（服务端不校验顺序，但保持可对拍）
  const q = [
    'enc_data=' + encodeURIComponent(enc.enc_data),
    'tt=' + ts,
    'did=' + encodeURIComponent(enc.did),
    'auth=' + auth,
    'cdn=',
    'rate=' + rate,
    'ver=' + PLAY_VER,
    'iar=0', // iar=0 才遵守 rate；iar=1 恒给最高档（实测 rate=2 → 返回 rate=4）
    'ive=0',
    'prev=1',
    'bs=2'
  ].join('&');
  return DOUYU_HOST + '/lapi/live/getH5PlayV1/' + rid + '?' + q;
}

// multirates → [{name, rate, bit}]（丢掉斗鱼私有字段 diamondFan/highBit）
export function normalizeRates(mr) {
  if (!Array.isArray(mr)) return [];
  const out = [];
  for (let i = 0; i < mr.length; i++) {
    const x = mr[i];
    if (!x || typeof x !== 'object') continue;
    const rate = Number(x.rate);
    if (!isFinite(rate)) continue;
    out.push({
      name: typeof x.name === 'string' ? x.name : ('rate' + rate),
      rate: rate,
      bit: Number(x.bit) || 0
    });
  }
  return out;
}

/**
 * 取某房间某码率的 FLV 直链。
 *
 * 直链 expire=300s（doc §1）→ 播放时拿到后**立刻**开播；重连必须重新调用本函数，
 * **不要**复用上次的 url（会被 403）。
 *
 * @param {number} rid 房间号
 * @param {number} [rate] 码率档位；默认 2（高清 900kbps）
 * @returns {Promise<{ok:boolean, url?:string, rate?:number, rates?:Array, rid:number, error?:*, errorText?:string}>}
 */
export async function fetchPlayInfo(rid, rate) {
  const id = Number(rid);
  // 用全局 isFinite（QuickJS 与项目内其它文件一致，不依赖 Number.isFinite）
  const wantRate = isFinite(Number(rate)) && Number(rate) >= 0 ? Number(rate) : DEFAULT_RATE;
  if (!isFinite(id) || id <= 0) {
    return { ok: false, rid: 0, error: 'BAD_RID', errorText: '房间号不合法' };
  }

  const did = await ensureDid();
  if (!did) {
    return { ok: false, rid: id, error: 'NO_DID', errorText: '无法生成设备标识' };
  }
  const enc = await getEncryption(did);
  if (!enc) {
    return { ok: false, rid: id, error: 'NO_ENCRYPTION', errorText: '获取鉴权参数失败' };
  }

  // ts 秒级（-9 时间戳错误 说明服务端校验时间窗）
  const ts = Math.floor(Date.now() / 1000);
  const url = buildPlayUrl(id, wantRate, { did: did, enc_data: enc.enc_data, key: enc.key, f: enc.f }, ts);
  if (url.length > PLAY_URL_SOFT_LIMIT) {
    // 实测 900 字符；超限说明 enc_data 变长，值得看一眼（POST 不改 URL 长度上限问题）
    logWarn('[douyu] 取流 URL 过长(' + url.length + ')，可能超出设备 http 上限');
  }

  let r;
  try {
    // **必须 POST**：GET 只有 17.5% 成功率，其余会被服务端当成 -15「非法请求」，
    // 看起来就像房间不存在 —— 这是「主页大量房间未开播」的真正根因。
    // POST 同样把参数全放 query、body 留空（net.js 的 httpRequest 不发 body）。
    r = await douyuGetJson(url, { tag: 'getH5PlayV1/' + id, method: 'POST' });
  } catch (e) {
    // douyuGetJson 本身不 throw，这里是双保险
    return { ok: false, rid: id, error: 'NETWORK', errorText: (e && e.message) || '网络错误' };
  }

  if (!r.ok) {
    // 403 = auth/did 不匹配：把缓存的密钥标脏，下次重签（did 可能刚换代）
    if (r.statusCode === 403) encCache = null;
    const code = r.statusCode === 403 ? 'AUTH_REJECTED' : r.error;
    return {
      ok: false,
      rid: id,
      error: code,
      errorText: r.statusCode === 403 ? '签名被拒(403)：已清缓存，请重试' : r.errorText
    };
  }

  const j = r.json || {};
  const code = Number(j.error);
  if (code !== 0) {
    // -9 时间戳错误：密钥本身没问题，清掉后下次重算 ts
    if (code === -9) encCache = null;
    return {
      ok: false,
      rid: id,
      error: code,
      errorText: describeDouyuError(code, j.msg),
      rates: normalizeRates((j.data && j.data.multirates) || null)
    };
  }

  const d = j.data || {};
  const rtmpUrl = typeof d.rtmp_url === 'string' ? d.rtmp_url : '';
  const rtmpLive = typeof d.rtmp_live === 'string' ? d.rtmp_live : '';
  if (!rtmpUrl || !rtmpLive) {
    // 房间下线时服务端也可能 error=0 但无流（保留兜底，实测未遇到）
    return { ok: false, rid: id, error: 'NO_STREAM', errorText: '该房间暂无直播流' };
  }
  // 直链 = rtmp_url + '/' + rtmp_live（rtmp_live 已自带 ?wsAuth=..&token=.. 查询串）
  const full = rtmpUrl.replace(/\/+$/, '') + '/' + rtmpLive.replace(/^\/+/, '');
  const rates = normalizeRates(d.multirates);
  return {
    ok: true,
    rid: id,
    url: full,
    // 服务端**实际**给的档位（rate=4 可能被降成 0），UI 以这个为准
    rate: Number(d.rate) >= 0 ? Number(d.rate) : wantRate,
    rates: rates
  };
}

// 测试/调试用：丢弃密钥缓存（不影响 did）
export function clearEncryptionCache() {
  encCache = null;
}
