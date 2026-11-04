# PenDouyu 集成契约（Lead 制定，各方必须遵守）

项目：`PenDouyu`（X6 Pro 词典笔，Falcon 小程序，Vue + QuickJS）
基线：从 `PenBili` 完整复制而来，B 站功能全部保留；新增斗鱼直播（主推）。
主题：斗鱼橙 `#FF5D23`。布局沿用 PenBili（左栏 76px + 内容 884px；播放态 213:469:278）。

---

## 1. 斗鱼取流（已在本机 node 实测通过，参数不得更改）

```
GET https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did={32位hex}
  -> data.{key, rand_str, enc_time, enc_data, expire_at}
f = rand_str
循环 enc_time 次: f = md5(f + key)
auth = md5(f + key + String(rid) + String(ts))     // ts = 秒级
GET https://www.douyu.com/lapi/live/getH5PlayV1/{rid}?enc_data=..&tt=..&did=..&auth=..
    &cdn=&rate={rate}&ver=Douyu_224011102&iar=0&ive=0&prev=1&bs=2
  -> error=0 时 data.rtmp_url + '/' + data.rtmp_live = 可直接 curl 的 FLV 直链
     data.multirates = [{name, rate, bit}]
```
硬性要求：
- `ver` 必须是 `Douyu_224011102`（用 `Douyu_new` 会返回纯文本「鉴权失败」）。
- form/query 里必须带 `did`，且与 getEncryption 用的是同一个。
- `iar=0` 才会遵守 `rate`；`iar=1` 恒给最高档。
- 每个码率档必须**单独签名请求一次**；直接改 URL 里的 `_4000` 后缀会 403。
- 直链 `expire=300` 秒，播放时必须在拿到后立刻用，重连要重新签名。
- 请求头：`User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/120`，
  `Referer: https://www.douyu.com/`，`Origin: https://www.douyu.com`。

其它端点：
- 房间列表 `GET https://www.douyu.com/gapi/rkc/directory/mixList/0_0/{page}` -> data.rl[]（120/页）、data.pgcnt
- 分区列表 `GET .../mixList/2_{cid2}/{page}`（**cid1 恒为 2**，不是分类树里的 cid1）
- 分类树 `GET https://www.douyu.com/wgapi/live/liveweb/getLeftNav` -> data.cateList[]（id/cn1/list[{cid1,cid2,cn2}]）
- 搜索 `GET https://www.douyu.com/japi/search/api/getSearchRec?kw=xx` 可用；
  `/japi/search/api/searchShow?kw=` 被风控（error=1/8）→ 必须改用
  「getSearchRec 把关键词映射到分类 cid2 → 拉该分类房间 → 本地按标题/主播名过滤」。

## 2. JS 服务层契约（`src/services/douyu/`，由 services 负责人实现）

```js
// api.js
export async function ensureDid()                      // 32 位 hex，持久化在 storage
export async function fetchPlayInfo(rid, rate)         // -> {ok, url, rate, rates:[{name,rate,bit}], error, errorText}
export const DOUYU_UA, DOUYU_REFERER

// feed.js
export async function fetchCategories()                // -> [{id, name, subs:[{cid1,cid2,name}]}]
export async function fetchLiveList(cid2, page)        // cid2=0 表示推荐；-> {items, page, total}
export async function searchLive(keyword)              // -> {items, via:'direct'|'cate', error}

// 统一条目结构（browse 网格直接消费）
// { site:'douyu', rid:Number, title:String, streamer:String, cover:String,
//   avatar:String, category:String, online:Number, onlineText:String, isLive:true }
```

约束：
- 网络只能走 `src/services/net.js`（`$falcon.jsapi.http.request`，自定义头字段名是 `header` 单数，
  成功返回 `{result: body}`，非 2xx 返回 `{error:3, result:{errorMessage}}`）。
- **不要**依赖 native form POST；GET 已验证可取流。
- md5 直接用 `src/services/bili/md5.js`（已存在，勿重写）。
- 每个函数必须 catch，返回 `{ok:false, error, errorText}` 或空数组，绝不 throw 到页面。
- 不写 console.log 噪声；用 `storage.js` 的 `logWarn`。

## 3. 播放调用（UI 层）

直播：`player.open(url, 0, 0, 30, /*audio*/1, /*transpose*/1, x, y, w, h,
                  audioDevice, DOUYU_UA, DOUYU_REFERER, '', fpsCap, /*live*/1)`
- `durationMs = 0` + `isLive = 1`（第 16 个位置参数）。
- 位置显示用「已播时长」，不做 seek。
- 码率默认 `rate=2`（高清 900kbps，笔端最稳），可选 4/3/0。

## 4. native 契约（`native/csrc/`，由 native 负责人实现）

直播不再用 souphttpsrc（斗鱼 CDN 无 Content-Length/Accept-Ranges，
souphttpsrc 直接 `Server does not accept Range HTTP header` 失败；实测多种
`is-live`/`iradio-mode` 组合全部失败）。

**必须实现：fork curl 写 FIFO + `filesrc location=<FIFO> ! flvdemux`**

- FIFO 路径 `/tmp/pb2/dy-<pid>-<seq>.fifo`，`mkfifo(0600)`。
- 先 `hold_fd = open(fifo, O_RDWR|O_CLOEXEC|O_NONBLOCK)`（永不阻塞），
  再 spawn curl；写端全死后由 reaper 主动 `close(hold_fd)` 让 filesrc 收 EOF。
- spawn 用 `posix_spawn`，argv：
  `/bin/curl -s -L --connect-timeout 8 --speed-limit 1024 --speed-time 20 -o <fifo>
   -A <ua> -e <referer> -H "Origin: https://www.douyu.com" <url>`
  **必须用 `-o <fifo>` 传参**，不能用 stdout 重定向/管道：
  设备 curl 的 stdout 管道整体坏掉（`curl | cat` = 0 字节，`curl -v | cat` 报
  `curl: (3) Error`），但 `curl -o file` 和 `curl -o fifo` 完全正常（实测 427KB）。
- stderr 落 `/tmp/pb2/err-dy-<fifo basename>`。
- 直播 desc 只写 `filesrc location="<fifo 路径>" blocksize=65536 ! flvdemux name=vd`，
  其余 pad-added 分支/queue/kmssink 逻辑**完全沿用 PenBili 直播分支**。
- 停止/释放要 `kill(pid, SIGKILL)` + `waitpid` + `unlink(fifo)`。
- 保留 B 站点播（ffmpeg→FIFO→matroskademux）与 B 站直播原逻辑不动。

## 5. 分区/写文件边界（避免冲突）

| 负责人 | 可写路径 |
| --- | --- |
| native | `PenDouyu/native/csrc/**`、`PenDouyu/native/build.ps1` |
| services | `PenDouyu/src/services/douyu/**` |
| ui | `PenDouyu/src/pages/index/index.vue`、`PenDouyu/src/styles/**`、`PenDouyu/package.json`、`PenDouyu/src/app.json`、`PenDouyu/src/assets/icons/**` |
| lead | `PenDouyu/docs/**`、`PenDouyu/tools/**`、`PenDouyu/libs/**`、打包/装机/验证 |

## 6. 环境

- 工作区 `D:\Users\Daniel\code\DSH\x6pro\haas-x6pro`
- node v24.21.0；zig `env/pyzig/ziglang/zig.exe`；adb `env/adb/adb.exe`
- 构建前端：`cd PenDouyu && node ../env/node_modules/aiot-vue-cli/src/cli.js -q -p`
- 构建 native：`cd PenDouyu && node ../env/node_modules/... ` 不行，用
  `powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1`
- 设备：`./env/adb/adb.exe shell '...'`；push 到 /tmp 必须加 `MSYS_NO_PATHCONV=1`
- **测试必须静音**：任何真机播放测试不得接 alsasink 到扬声器（用 fakesink 或 volume=0）。
