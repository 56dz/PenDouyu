// 网络 adapter（以下均为 X6 Pro 真机实测结论）：
//   - jsapi 只有 http（无 net 命名空间）：http.request / downloadFile / ...
//   - 自定义请求头字段是 header（单数，对象）；query 走 urlParams
//   - 成功 {result:<body>}（无 statusCode）；非 2xx {error:3,result:{errorMessage:'curl ... resCode:N'}}
//     → 非 2xx 时 body 不可得，错误文本就是全部信息
//   - 响应头永远不可见
// 本项目只需要带自定义头的 GET JSON（斗鱼接口必须自带浏览器 UA 过风控，见 douyu/api.js）。
//
// 纯斗鱼版本只保留这 5 个导出：httpGet / unwrapResponse / tryParseJson /
// toRuntimeHeader / normalizeError。v1.x 的 native form POST（startPost/takeResult）、
// 二进制 GET（弹幕 protobuf）与 native 文本 GET 全部随 B 站功能一起删除 —— 斗鱼所有接口
// 都是普通 GET，jsapi.http 足够。

function httpApi() {
  const f = typeof $falcon !== 'undefined' ? $falcon : null;
  const jsapi = f && f.jsapi;
  if (!jsapi) return null;
  if (jsapi.http && typeof jsapi.http.request === 'function') return jsapi.http;
  if (jsapi.net && typeof jsapi.net.request === 'function') return jsapi.net;
  return null;
}

export function normalizeError(e) {
  if (e instanceof Error) return e;
  let msg = '';
  if (e && typeof e === 'object') msg = e.message || e.msg || e.error || '';
  else if (typeof e === 'string') msg = e;
  const err = new Error(msg || 'NET_UNKNOWN: 未知网络错误');
  if (e && typeof e === 'object') err.raw = e;
  return err;
}

// 把运行时返回包装归一化成 { statusCode, body, errorMessage }
export function unwrapResponse(res) {
  if (res == null || typeof res !== 'object') return { statusCode: 0, body: null, raw: res };
  const hasError = res.error !== undefined && res.error !== 0 && res.error !== null;
  if (hasError) {
    const info = res.result !== undefined ? res.result : res.error;
    let msg = '';
    let statusCode = 0;
    if (info && typeof info === 'object') {
      msg = info.errorMessage || info.message || '';
      if (typeof info.statusCode === 'number') statusCode = info.statusCode;
    } else if (typeof info === 'string') {
      msg = info;
    }
    const m = typeof msg === 'string' ? msg.match(/resCode:(\d+)/) : null;
    if (m) statusCode = parseInt(m[1], 10);
    const body = info && info.data !== undefined ? info.data : null;
    return { statusCode: statusCode, body: body, raw: res, errorMessage: msg };
  }
  let body = null;
  if (res.result !== undefined) body = res.result;
  else if (res.data !== undefined) body = res.data;
  else if (res.body !== undefined) body = res.body;
  else if (res.text !== undefined) body = res.text;
  const statusCode =
    typeof res.statusCode === 'number' ? res.statusCode : typeof res.status === 'number' ? res.status : 200;
  return { statusCode: statusCode, body: body, raw: res };
}

export function tryParseJson(body) {
  if (typeof body !== 'string') return body;
  const t = body.replace(/^\uFEFF/, '').trim();
  if (!t) return null;
  if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return body;
  try {
    return JSON.parse(t);
  } catch (e) {
    return body;
  }
}

// 把 {headers:{...}} 归一化成运行时需要的 header（单数）对象；
// 只保留字符串值，键大小写保持服务器契约要求的写法。
export function toRuntimeHeader(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return null;
  let n = 0;
  for (const k of Object.keys(headers)) {
    const v = headers[k];
    if (typeof v === 'string' && v.length > 0) {
      out[k] = v;
      n++;
    }
  }
  return n > 0 ? out : null;
}

// GET 文本；返回 { statusCode, body(string), errorMessage }
// opts: { headers?: Object, timeout?: number }
export function httpGet(url, opts) {
  return new Promise((resolve, reject) => {
    const api = httpApi();
    if (!api) {
      reject(new Error('NET_UNAVAILABLE: http.jsapi 不可用'));
      return;
    }
    const o = opts || {};
    let settled = false;
    let guard = 0;
    const limit = o.timeout || 15000;
    const done = (isErr, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (isErr) reject(arg);
      else resolve(arg);
    };
    try {
      const options = { url: url, method: 'GET', timeout: limit };
      const header = toRuntimeHeader(o.headers);
      if (header) options.header = header;
      const ret = api.request(options, (res, err) => {
        if (err) done(true, normalizeError(err));
        else done(false, unwrapResponse(res));
      });
      if (ret && typeof ret.then === 'function') {
        ret.then(
          (res) => done(false, unwrapResponse(res)),
          (e) => done(true, normalizeError(e))
        );
      }
    } catch (e) {
      done(true, normalizeError(e));
      return;
    }
    guard = setTimeout(() => done(true, new Error('NET_TIMEOUT: 请求超时(' + limit + 'ms)')), limit + 500);
  });
}

// logWarn 目前未被本文件使用，但保留导入会触发打包器告警，故不导入。
