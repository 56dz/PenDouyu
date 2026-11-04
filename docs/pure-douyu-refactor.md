# 剥离 B 站：纯斗鱼版重构契约（v2.0.0）

> 目的：PenDouyu 从「斗鱼 + B 站合并」改为**纯斗鱼直播客户端**。
> 这份文件是本次重构的唯一契约，两个写域（services / ui）按它对齐，不要互相猜。

## 0. 原则

1. **只删不加**。除了删掉 B 站代码与随之而来的死引用，不新增功能、不改交互。
2. **native 完全不动**。`native/csrc` 里没有任何 B 站逻辑（已 grep 确认，只有 6 处注释），
   不需要重编 `.so`，`libs/` 三个 `.so` 保持现状。
3. **斗鱼现有行为零回归**：分类两段式、搜索、码率四档、换链、蓝牙音量镜像、屏幕保活、
   KMS 挖孔几何，全部按现状保留。
4. 删除后必须能过：`node test/run.js`（裁剪后的用例）、`node ../env/node_modules/aiot-vue-cli/src/cli.js -q -p`（构建）。

## 1. 文件级删除清单（services 写域）

| 路径 | 处理 | 理由 |
| --- | --- | --- |
| `src/services/bili/`（整个目录 11 个文件） | 删 | B 站 API 客户端 |
| `src/services/feed.js` | 删 | B 站推荐/热门/搜索 |
| `src/services/history.js` | 删 | 用 bvid 作 key，斗鱼不进历史 |
| `src/services/imgurl.js` | 删 | hdslb → archive.biliimg.com，纯 B 站图床。斗鱼图床归一已内建在 `douyu/normalize.js` |
| `test/qr_login_test.js` | 删 | 纯 B 站扫码登录 |
| `src/pages/diag/` + `src/styles/diag.less` | 删（ui 写域） | B 站自检页 |

**`src/services/bili/md5.js` 不是删而是搬**：`src/services/douyu/api.js:27` 依赖它做斗鱼签名。
→ 新路径 `src/services/md5.js`（内容不变，只保留 `md5Hex`），并把 api.js 的 import 改成 `'../md5.js'`。

## 2. 模块级改写（services 写域）

### 2.1 `src/services/play_session.js`（1243 → 目标 ~400 行）

**保留**（斗鱼直播全部走这条）：
`SEEK_STEP_MS`、`LIVE_URL_TTL_MS`、`LIVE_URL_REFRESH_MS`、`shouldRefreshLiveUrl`、`num`、
`numSigned`、`numLatency`、`normalizeState`、`isLiveEnded`、`isLiveReconnecting`、
`LIVE_RECONNECT_ERR`、`resolveLiveUrl`（只剩斗鱼分支）、`refreshLiveUrl`（只剩斗鱼分支）、
`openVideo`、`togglePlay`、`recoverSession`、`readStatus`、`closeSession`、`describePlayError`，
以及内部 `douyuRateFor` / `nowMsOf` / `resolveDouyuLive` / `resolveDouyuLiveUrl` / `cancelled`。

**删除**：
- `import` 行 `bili/playurl.js`（QN_LADDER / HTML5_FPS / buildPlayurlQuery / parseHtml5Response /
  parseDashResponse / validateStreamUrl）、`bili/live.js`（fetchLivePlayUrl）、`bili/wbi.js`（deriveMixinKey）。
  `LIVE_FPS` 是 `bili/live.js` 里的常量 `= 30`，斗鱼分支也在用 → **把它内联成 play_session 自己的
  `export const LIVE_FPS = 30;`**（或直接写字面量 30），不要保留对 bili 的依赖。
- `ensureMixinResult` / `ensureMixin` 两个导出（WBI 密钥，纯 B 站）。
- `resolveVideoUrl` 的 bvid / DASH / durl 全部分支（原 :508-650）→ 改成**只分派到 resolveLiveUrl**：
  ```js
  export async function resolveVideoUrl(ctx, item) {
    return resolveLiveUrl(ctx, item);
  }
  ```
  或直接把 `openVideo` 改成先调 `resolveLiveUrl`（二选一，保持 `openVideo` 导出不变）。
- `seekTo` / `seekBy` / `isStreamEnded` / `END_TAIL_MS` / `END_DEAD_TAIL_MS` / `seekNoteDone` /
  `waitLanded` / `waitFirstFrame` / `SEEK_LAND_*` / `SEEK_FRAME_*` —— **直播不可 seek，全部删**
  （UI 同步删掉 seek 相关方法与模板）。
- `MAX_DECODE_PIXELS`、`pixelBudgetFor` / `dashLadderFor` / `videoFpsCapFor` 的引用（随 video_settings 裁剪）。

**`openVideo` 内部要改的点**：
- `const rects = playVideoRects(rs.width, rs.height, LIVE_VIDEO_AREA);`（恒定直播矩形，不再有条件分支）
- `fpsCap = liveFpsCapFor(ctx.videoSettings)`（保留；video_settings 只留 live 档）
- `input2: rs.audioUrl || ''` 恒为 `''` → 直接写 `''`
- session 里去掉 `bvid`、`cid` 的 B 站语义；保留 `roomid`、`rid`、`site:'douyu'`、`qn`、`rates`、
  `douyuRate`、`liveUrlAt`、`title`、`up`、`cover`、`desc`、`rectPhysical`、`outWidth/outHeight`、
  `aid` 删掉、`durationMs: 0`
- 日志前缀 `[bili]` → `[douyu]`

### 2.2 `src/services/video_settings.js`（230 → 目标 ~90 行）

只保留直播画质：`LIVE_QUALITY_OPTIONS`（480p30 / 720p30 / 720p60 三档，原来就有）、
`DEFAULT_VIDEO_SETTINGS`（只留 `{ version, liveQuality }`）、`normalizeVideoSettings`、
`loadVideoSettings`、`saveVideoSettings`、`nextOptionId`、`liveFpsCapFor`、`liveQualityLabel`。
删 `VIDEO_QUALITY_OPTIONS`、`dashLadderFor`、`videoFpsCapFor`、`pixelBudgetFor`、`liveQnFor`、
`videoQualityLabel`。storage 键 `bili_video_settings` → `douyu_video_settings`（老数据自然失效）。

### 2.3 `src/services/storage.js`（211 → 目标 ~110 行）

保留并**改名**：
- `KEYS.session`（`bvp_session`）→ 删（B 站匿名身份 buvid，斗鱼用 did，did 自己的键在 douyu/api.js）
- `KEYS.settings` → 删（DEFAULT_TARGET 是 bvid）
- `KEYS.history` → 删（history.js 一起删）
- `KEYS.autotest`（`bili_autotest`）→ 改 `douyu_autotest`
保留：`logWarn`、`getJson`、`setJson`、`getString`、`setString`、`memoryPeek`、`normalizeStoredValue`、
`getSetPair` 等底层能力（douyu/api.js、video_settings.js、player.js、net.js 都在用）。
删：`normalizeLogin`、`normalizeSession`、`loadSession`、`saveSession`、`normalizeSettings`、
`loadSettings`、`DEFAULT_TARGET`、`SESSION_SCHEMA_VERSION`、`SETTINGS_SCHEMA_VERSION`。

### 2.4 `src/services/player.js`

`PLAYER_IMPL_KEY` 值 `'bili_player_impl'` → `'douyu_player_impl'`；注释里 B 站字样清掉。
其余（双实现开关、参数校验、UA/Referer 校验）全部保留不动。

### 2.5 `src/services/net.js`

保留。`cancelNativePosts` 只被 index.vue 用（登录/评论），UI 删掉后若无引用则一并删该导出；
`httpGet`/`httpPost`/`unwrapResponse` 等底层能力必须保留（douyu/api.js 用）。

### 2.6 `src/services/autotest_seed.js` / `live_end_probe.js`

- `autotest_seed.js`：保留（双开关守卫，纯函数）。注释里的 `KEYS.autotest` 说明同步改名。
- `live_end_probe.js`：保留（依赖 play_session 的 isLiveEnded / isLiveReconnecting / num / numSigned，
  这些都在保留清单里）。

### 2.7 `test/run.js`（3730 → 目标 ~600-900 行）

保留用例：md5（改路径 `../src/services/md5.js`，斗鱼签名要用）、net 归一化、player 参数映射与
UA/Referer 校验、屏幕几何（GRID_COLS / trimToGridRows / seek 几何可删 seek 部分）、video_settings
（裁到 live 档）、play_session 的直播判据（isLiveEnded / isLiveReconnecting / shouldRefreshLiveUrl /
refreshLiveUrl / describePlayError）、storage schema（裁掉 login/session）、live_end_probe、
autotest_seed、douyu 相关（分类/列表/归一/搜索/取流用例可放这里或留在 douyu_feed_test.js）。
删除用例：wbi、client、playurl、probe、reply、article、action、qrlogin、feed（B 站搜索归一）、history。

## 3. UI 改写（ui 写域）

### 3.1 `src/pages/index/index.vue`（4248 → 目标 ~1400 行）

**模板删除**：
- `.sitesw` 站点切换两格（`:15` 附近）→ 左栏只留 logo
- `v-else` 的 B 站 `tabs` 四格（推荐/热门/搜索/我的，`:47`）
- `<scroller v-else-if="tab==='rcmd'||tab==='hot'">`（`:224-245`）
- `<scroller v-else-if="tab==='search'">` B 站搜索三分栏（`:248-309`）
- `<scroller v-else-if="mineView==='info'">` 我的页 + 扫码视图（`:312-421`）
- `.pleft-btns` 点赞/投币/收藏三按钮（`:99`）与 `v-else` 空占位（`:122`）
- 图文态左栏 `.ibar`（`:129-139`）、`.astage`（`:543-577`）、`.comments-col`（`:580-620`）
- 中列进度条 `.seek`（`:446-457`）与右列 `.pright` 评论区整块（`:466-531`）
- **必须保留** `:540` 的 `<div v-if="isLivePlay" class="pright-fill"></div>`（不透明兜底，删了会透出上一屏 fb 残留）

**模板保留/简化**：
- 浏览态：斗鱼搜索行 + 二级 chip + 网格 + 两套 more-row + empty（`:144-221`）
- 播放态左列：返回键 / 标题 / `.dy-meta` 三行 / 码率四档（`:56-120` 中斗鱼那支）
- 中列：`.pvideo-live` + `hole` + `.play-idle`（`:426-439`）

**script 删除**：
- imports：`feed.js`、`bili/action.js`、`bili/article.js`、`bili/client.js`、`bili/qrlogin.js`、
  `bili/reply.js`、`bili/qrcode.js`、`history.js`、`video_settings` 里被删的导出、
  `play_session` 里被删的导出（ensureMixinResult / seek 相关 / isStreamEnded / waitLanded / waitFirstFrame）
- `TABS`、`SEARCH_TYPES_UI`、`QR_CELL`/`QR_QUIET`、`gridToRows`/`lenOf`、`ABOUT_URL`/`ABOUT_QR_ROWS`、
  `WATCHDOG_*`（点播自愈，直播不需要 → 确认后删）、`SEEK_DEBOUNCE_MS`/`SEEK_NOTE_TIMEOUT_MS`、
  `NO_FRAME_FAIL_MS`（若 tryRecover 保留则保留）、`DY_URL_REFRESH_MS` 保留
- data：`tabs`、`searchTypes`、`tab`、`searchType/searchResults/searchPages/searchNoMoreMap`、
  `rcmdItems/hotItems/hotPn/hotNoMore/hotMorePn/moreNoMore`、`keyword/loading/statusText`、
  `replyCtx`、`article`、`history`、`buvidShort`、`seekStepSec`、`mineView/profile/profileStatus/qr`、
  `replies/*`、`replyOpen`、`commentsOpen`、`favOverlay`、`act`、`favFolders/favStatus`、`seekDragMs`、`cinText`。
  **`site` 也删**（纯斗鱼，不需要站点判定；同步把 `isDouyuPlay` 简化成 `this.mode==='play'`，
  或直接删掉 `isDouyuPlay` 改用 `isLivePlay`）
- computed：`aboutQrRows`、`currentItems`、`searchItems`、`commentsBackLabel`、`moreBtnText`、`hasLogin`、
  `qrPrimaryLabel`、`seekFillW`、`playDesc`、`vqText`… 删
- methods：`selectTab`、`loadTabOnce`、`loadTab`、`loadMoreHot`、`onOpenInput`、`loadMoreFromHot`、
  `loadMoreSearch`、`setSearchType`、`openArticle`、`onBackArticle`、`onPlayItem`、`onSeek`、`onSeekTouch`、
  `onSeekRelease`、`seekTo`、`openComments`/`closeComments`/`resolveReplyCtx`/`ensureReply`/`refresAct`…
  整块评论/互动/收藏/登录/扫码/`onCycleVideoQuality`/`onCycleLiveQuality`/`vqText`/`lqText`/`onIbarBack`/
  `toggleArticleComments`/`runWbiStress`/`runLiveAutotest`/`runPlayProbe`/`runAutotest` 中的 B 站部分
- `name: 'PageBili'` → `'PageDouyu'`

**methods 保留**：`sleep`、`stopPoll`、`makeCtx`（去掉 client/UA-Referer 的 B 站分支，固定斗鱼 UA/Referer）、
`dyMeta`、`formatCount`、`loadLocal`（只加载 videoSettings）、`bootHome`、`loadDyCategories`、`selectDyTop`、
`selectDyCate`、`loadDyPage`、`loadMoreDy`、`onDySearchBtn`、`onOpenDyInput`、`runDySearch`、`onExitDySearch`、
`onPlayDouyu`、`onSwitchDyRate`、`refreshDouyuLive`、`startPoll`（去掉 seek/评论/互动分支）、`onTogglePlay`、
`teardown`、`startKeepScreen`、`stopKeepScreen`、`onShow`、`onHide`、`onUnload`、`onBack`（返回浏览态的极简版）。

**注意**：`startPoll`（原 2282-2700，418 行）是最大一块，里面混着进度/seek/评论/互动的分支，
需要逐段判断哪些是直播必需的（state/首帧/换链/重连提示/已播时长），其余删掉。

### 3.2 `src/styles/base.less`（1859 → 目标 ~700 行）

删除分节：`/* 搜索 */`(495)、`/* 播放：右栏（默认评论区 + 收藏夹覆盖层）*/`(920)、
`/* 图文正文（896 宽）*/`(1124)、`/* 评论覆盖面板 */`(1191)、`/* 扫码登录 */`(1682-1859)。
`/* 播放态三列 */`(571) 里删点播专属（`.seek*`、`.pright*`、`.pinfo` 里 B 站才用的行），
**保留 `.pvideo` / `.pvideo-live` / `.video-hole*` / `.pleft*` / `.pright-fill`**。
`/* 左侧栏 */`(38) 里删 `.sitesw*`，删 `.mine*`(322 整节)、`.ibar*`（图文态）、`.astage*`、`.comments*`。
**四条铁律照旧**：禁逗号选择器 / flex 三连 / 禁 position:absolute / `<text>` 换行不渲染。

### 3.3 `src/app.json`

`pages` 只留 `index`，删 `diag` 项。

## 4. 写域边界（不要越界）

| owner | 可写 |
| --- | --- |
| services-dev | `src/services/**`（含删除）、`test/**` |
| ui-dev | `src/pages/**`、`src/styles/**` |
| lead | `src/app.json`、`src/app.js`、`README.md`、`docs/**`、`package.json`、真机构建安装 |

## 5. 验收

- [ ] `grep -rn "bili\|B站\|bilibili\|bvid" src/ test/` 剩余命中只有**确实是平台层事实**的注释
      （例如 KMS/vid 这类），不得再有代码引用与 B 站 API 路径。
- [ ] `node test/run.js` 全绿。
- [ ] `node ../env/node_modules/aiot-vue-cli/src/cli.js -q -p` exit 0 且产出 `.amr`。
- [ ] 真机：首页出斗鱼推荐流、左栏五个一级分类、点房间能起播（静音，`/tmp/pb2_mute` 存在）。

---

## 6. 落地结果与契约偏差（Lead 收尾记录）

契约是重构前写的，实际执行有四处偏差，都记在这里，避免后人拿第 0/1 节当现状读。

### 6.1 native 并非「完全不动」（契约 0.2 已作废）

`httpjson` 模块不是 B 站「功能代码」而是 B 站「专用工具」：它做的原始 POST body 与
二进制 GET，全项目只有 B 站 TV 登录和弹幕 protobuf 用。斗鱼所有接口都是普通 GET，
`$falcon.jsapi.http` 够用。留着就是死代码 + 一个额外 .so，所以一起删了：

- 删 `native/csrc/httpjson.c`（689 行）与 `libs/libjsapi_httpjson.so`（16200 B）
- `native/build.ps1` 删掉整段编译块与 `-Wl,-soname,libjsapi_httpjson.so`
- 构建告警从三条降到两条，`httpjson` 从「未找到模块」列表里消失 —— 这就是它确实不再被打包的证据

另外把 native 里 22 个 `PENBILI_*` 宏/头保护名统一改成 `PENDOUYU_*`（连同
`native/build.ps1` 的 `$env:PENDOUYU_TARGET`、zig 缓存目录 `pendouyu-zig-cache`）。
`test/run.js` 有 9 处正则**断言这些宏名**，所以必须同步改，否则单测会红。
改完全量重编：`libjsapi_player.so` 51248 / `libjsapi_player2.so` 99808，字节数与改名前一致
（纯标识符重命名，不影响代码生成）。

### 6.2 net.js 是重写不是裁剪

289 → 132 行，只留 `httpGet` / `unwrapResponse` / `tryParseJson` / `toRuntimeHeader` /
`normalizeError` 五个导出。删掉的 `httpPostForm`、`cancelNativePosts`、`httpGetBinary`、
`utf8Decode`、`httpGetTextNative`、`netAvailable`、`headersToLines` 全部是 B 站链路专用。

### 6.3 额外删掉的文件（契约 1 没列）

`api-mock/`（16 个 B 站 fixture）、`svg/`（4 个 B 站 SVG）、`src/assets/icons/` 里 14 个
B 站图标、`docs/screenshots/x6-bili.png`、`tools/` 下 9 个 B 站遗留脚本
（`probe_article.mjs`、`probe_search.mjs`、`qr_login_diag.js`、`seed_settings.js`、
`svg2png.py`、`make_icon_v2.js`、`make_icon_v2.py`、`make_icons.py`、`icon_colors.json`）。
全部 grep 确认零引用后才删，副本在 `/d/tmp/pd-bili-bk`。

顺带把 `app_icon.png` 之外又加了一个 `src/assets/icons/logo.png`(60x60)：`tools/make_douyu_icon.py`
现在从同一张斗鱼官方鲨鱼图生成两张图，界面左栏 logo 不再是粉色 B 站电视。

### 6.4 devDependencies 清空

`@resvg/resvg-js` 只被已删的 `make_icon_v2.js` 用、`jsqr` 全项目零引用，
所以整个 `devDependencies` 删掉，`package-lock.json` 从 604 行压到 32 行
（只剩 `falcon-ui` + 它的 `bindingx-parser`）。`npm ci` 从此只装一个包。

### 6.5 最终数字

| 项 | v1.0.0 | v2.0.0 |
| --- | --- | --- |
| `src/pages/index/index.vue` | 4248 行 | **1448 行** |
| `src/styles/base.less` | 1859 行 | **623 行** |
| `src/` 全部 js/vue/less | 14119 行 | **6053 行**（20 个文件） |
| `native/csrc` | 14213 行 | **13526 行** |
| `test/run.js` | 3730 行 / 204 条 | **1685 行 / 86 条** |
| native 模块 | 3 个 | **2 个** |
| AMR 包 | 304964 B | **199264 B** |
