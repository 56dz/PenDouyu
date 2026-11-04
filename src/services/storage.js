// 存储 adapter（以下均为 X6 Pro 真机实测结论）——
//   getStorage({key}) → Promise<{data:string}>；setStorage({key, data}) 才落盘
//   （传 value/content 会落盘为空串；字符串形态 setStorage(k,v) 的 promise 永不 settle）
// 统一走对象形态 + 超时保护；失败时保留内存态。高频写入串行化。

const MEMORY = {};

// 只保留底层读写原语 + 自检开关。斗鱼的持久化各自走独立 key：
//   · douyu_did            —— 取流签名用的设备标识（douyu/api.js）
//   · douyu_video_settings —— 画质偏好（video_settings.js）
//   · douyu_player_impl    —— 播放器实现开关（player.js）
export const KEYS = {
  // 自检开关（tools/seed_settings.js 预置，真机自动化用）
  autotest: 'douyu_autotest'
};

function getSetPair(key) {
  const f = typeof $falcon !== 'undefined' ? $falcon : null;
  const s = f && f.jsapi && f.jsapi.storage;
  if (!s) return null;
  if (typeof s.getStorage === 'function' && typeof s.setStorage === 'function') {
    return {
      get: () => s.getStorage({ key: key }),
      set: (v) => s.setStorage({ key: key, data: v })
    };
  }
  return null;
}

export function normalizeStoredValue(result) {
  if (result == null) return '';
  if (typeof result === 'object') {
    if (typeof result.data === 'string') return result.data;
    if (typeof result.value === 'string') return result.value;
    return '';
  }
  return typeof result === 'string' ? result : '';
}

function withTimeout(p, ms) {
  let timer = 0;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), ms);
  });
  return Promise.race([p, timeout]).then((r) => {
    clearTimeout(timer);
    return r;
  });
}

async function rawGet(key) {
  const pair = getSetPair(key);
  if (!pair) return typeof MEMORY[key] === 'string' ? MEMORY[key] : '';
  try {
    const r = await withTimeout(pair.get(), 5000);
    if (r && r.__timeout) {
      logWarn('[storage] get 超时: ' + key);
      return typeof MEMORY[key] === 'string' ? MEMORY[key] : '';
    }
    const v = normalizeStoredValue(r);
    if (v) {
      // 读到的值必须同步进内存缓存，否则后续读取会拿到空值并反过来覆盖存储
      MEMORY[key] = v;
      return v;
    }
    return typeof MEMORY[key] === 'string' ? MEMORY[key] : '';
  } catch (e) {
    return typeof MEMORY[key] === 'string' ? MEMORY[key] : '';
  }
}

let writeChain = Promise.resolve();

function rawSet(key, value) {
  const run = async () => {
    MEMORY[key] = value;
    const pair = getSetPair(key);
    if (!pair) return;
    try {
      await withTimeout(pair.set(value), 3000);
      const back = await withTimeout(pair.get(), 3000);
      if (!(back && !back.__timeout && normalizeStoredValue(back) === value)) {
        logWarn('[storage] 写入未持久化: ' + key);
      }
    } catch (e) {
      logWarn('[storage] set 异常: ' + (e && e.message));
    }
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

export function logWarn(msg) {
  // 设备日志只落 console.warn/error（console.log 不落盘）
  try {
    console.warn(msg);
  } catch (e) {
    /* 忽略 */
  }
}

export async function getJson(key, fallback) {
  const raw = await rawGet(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    logWarn('[storage] JSON 损坏: ' + key);
    return fallback;
  }
}

export function setJson(key, obj) {
  return rawSet(key, JSON.stringify(obj));
}

export async function getString(key, fallback) {
  const raw = await rawGet(key);
  return raw || fallback;
}

export function setString(key, value) {
  return rawSet(key, String(value == null ? '' : value));
}

export function memoryPeek(key) {
  return typeof MEMORY[key] === 'string' ? MEMORY[key] : '';
}
