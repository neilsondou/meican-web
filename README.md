# 每餐 Web

「每餐」的 Flutter Web 构建产物与 Vercel Serverless API，线上地址：
<https://meican.dou.asia/>。源码在
[neilsondou/meican](https://github.com/neilsondou/meican)。

这个仓库承担三件事：

- 托管 Flutter Web 静态文件；
- `api/ai.js`：同源 AI 代理（拍照识别、体重截图识别、趋势页 AI 建议）；
- `api/login.js` / `api/logout.js` / `api/sync.js`：可选的云同步服务，数据存在
  Vercel Marketplace 的 Neon Postgres 中，不再使用 Cloudflare Worker 或 D1。

## 当前配置

- 网页端 AI 走同源 `/api/ai`，由 Vercel Serverless 转发到智谱，不需要登录。
- AI 测试密钥写在 `lib/ai-keys.js`，会随公开仓库发布；任何人都能读取和滥用这组
  免费密钥。仓库公开期间请把它当作测试用途，发现额度异常时及时更换。
- 云同步完全可选，不登录也能使用拍照、记录、AI 建议和趋势等全部本地功能。
- 网页数据保存在浏览器本地存储中；首次进入会提示不要清理浏览器缓存，并展示
  iOS / Android 安装入口。
- 自定义字体不再写进 `FontManifest`（那会让 Flutter Web 在首帧前阻塞下载约
  2.4 MB 字体）。启动时由 `FontLoader` 从国内可访问的 jsDelivr 镜像加载
  WOFF2，失败再回退到本仓库 `assets/fonts/` 下的打包文件。
- `vercel.json` 关闭入口文件的长缓存，并给字体与 CanvasKit 增加一天缓存。

## 云同步部署（Vercel + Neon）

### 1. 创建数据库

1. 打开 Vercel 项目的 **Storage / Marketplace**，选择 **Neon**（Postgres），
   创建一个免费数据库并连接到本项目。
2. Vercel 会自动注入 `POSTGRES_URL`、`POSTGRES_PRISMA_URL`、
   `POSTGRES_URL_NON_POOLING` 等环境变量。函数按以下顺序读取：
   `DATABASE_URL` → `POSTGRES_URL` → `POSTGRES_PRISMA_URL`。
3. 如果使用外部 Postgres，在 **Settings → Environment Variables** 手动添加
   `DATABASE_URL`。请使用带 `-pooler` 的池化连接串，并保留 `sslmode=require`。
4. 表结构会在第一次 API 请求时自动创建；也可以在 Neon SQL Editor 里执行
   [`db/schema.sql`](db/schema.sql)。

### 2. 初始化账号

在 Vercel **Settings → Environment Variables** 添加：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MEICAN_USERS` | 是 | JSON 对象，键是账号、值是密码，例如 `{"dty":"换成强密码","tzx":"换成强密码"}`。密码至少 6 位，建议 12 位以上。勾选 Sensitive。 |
| `MEICAN_USERS_RESET` | 否 | 临时设为 `1` 并重新部署，会把已有账号密码重置为 `MEICAN_USERS` 里的值。完成后删除该变量。 |
| `MEICAN_ALLOWED_ORIGINS` | 否 | 逗号分隔的额外允许来源。默认已包含 `meican.dou.asia`、`www.dou.asia`、本地 8899 端口和 `*.vercel.app`。 |

账号只在数据库为空时写入；之后修改环境变量不会自动覆盖已有密码。
环境变量只存在 Vercel，不会进入仓库或网页包。不要把真实密码写进代码、README 或
`db/schema.sql`。

### 3. 重新部署并验证

添加环境变量后重新部署。依次验证：

```bash
# 未登录访问：返回 401 说明函数、数据库和鉴权都正常
curl -i https://meican.dou.asia/api/sync

# 用占位账号登录：成功时返回 {"token":"...","username":"..."}
curl -i -X POST https://meican.dou.asia/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"dty","password":"你的密码"}'

# 用上一步的 token 读取云端快照
curl -i https://meican.dou.asia/api/sync \
  -H 'Authorization: Bearer 上一步返回的 token'
```

如果返回 503「云同步尚未配置数据库」，说明没有读到连接串；如果返回 500，
到 Vercel → Functions 日志查看具体错误。日志不会打印密码、Token 或连接串。

## API 约定

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/login` | `{username,password}` → `{token,username}`；401 密码错误，429 尝试过多。 |
| `POST` | `/api/logout` | Bearer Token，删除当前会话。 |
| `GET` | `/api/sync` | Bearer Token → `{revision,data}`；没有数据时 `revision=0,data=null`。 |
| `PUT` | `/api/sync` | `{baseRevision,data}` → `{revision}`；版本冲突返回 409。 |

服务端规则：

- 密码用 Node `scrypt` 加随机盐哈希，Token 只保存 SHA-256 摘要，有效期 90 天；
- 快照存在 `snapshots.data`（JSONB），用 `revision` 做乐观并发控制；
- 登录失败按 IP 限流：15 分钟内最多 10 次；
- 单个快照限制约 3.8 MB，超过返回 413；
- CORS 只允许白名单来源；原生 App 不带 `Origin`，不受影响。

## 本地预览

```bash
node tool/dev-server.js
```

打开 `http://127.0.0.1:8899/`。这个脚本同时提供静态文件和 `/api/ai` 同源转发，
和线上 Vercel 的结构一致，所以本地也能测试拍照识别和 AI 建议。直接用
`python -m http.server` 之类的纯静态服务器会没有 `/api/ai`，AI 会返回 404。

浏览器不能直接调用 `open.bigmodel.cn`：ChatGLM 的 CORS 预检响应不带
`Access-Control-Allow-Origin`，`fetch` 会直接失败。因此网页端必须保留这个同源
转发，它只把请求原样转给 ChatGLM，不登录、不存图片。

## 更新网页

在源码仓库构建（网页版使用 `lib/ai-keys.js` 的服务端密钥池）：

```bash
flutter build web --release --no-web-resources-cdn
```

网页端云同步走同源 `/api/...`，不需要再传 `MEICAN_API_BASE`。原生 App 默认使用
`https://meican.dou.asia`，需要指向别的域名时再加
`--dart-define=MEICAN_API_BASE=https://你的域名`。

`--no-web-resources-cdn` 让网页从本仓库的 `canvaskit/` 加载引擎文件。字体由
`lib/app_fonts_web.dart` 在运行时从以下镜像依次尝试，约 1.1 MB WOFF2：

1. `https://jsd.onmicrosoft.cn/gh/neilsondou/meican@main/assets/fonts/`
2. `https://cdn.jsdmirror.com/gh/neilsondou/meican@main/assets/fonts/`
3. `https://fastly.jsdelivr.net/gh/neilsondou/meican@main/assets/fonts/`
4. 本仓库 `assets/fonts/`（`rootBundle` 回退）

更新字体后需要同时推送源码仓库，等 jsDelivr 同步完成；网页端最多缓存一天。

把 `build/web` 的内容覆盖到本仓库根目录，保留以下文件/目录：

`api/`、`lib/`、`db/`、`package.json`、`vercel.json`、`README.md`、`.gitignore`、
`.nojekyll`。

提交并推送后 Vercel 自动重新部署。`package.json` 里的 `pg` 依赖会由 Vercel
在构建函数时安装。

## 手机安装包

网页首次进入的提示里有「下载 iOS 版 / 下载 Android 版」：

- iOS：<https://www.dou.asia/meican.ipa>（需要自签后安装；也可以直接在 Safari
  里「分享 → 添加到主屏幕」使用网页版）
- Android：<https://www.dou.asia/meican.apk>

两个文件放在 `neilsondou/blog2` 仓库根目录，由 `www.dou.asia` 提供，不在本仓库
构建。链接常量在源码 `lib/app_config.dart`。

## 域名与 DNS

如果 `dou.asia` 的 DNS 托管在 Cloudflare，只需添加 Vercel 给出的 CNAME
（例如 `meican` → `cname.vercel-dns.com`，初始设为 DNS only）。这里只用它做
DNS 解析，不使用任何 Cloudflare 计算、存储或 Worker 服务。以 Vercel 控制台
显示的记录为准。
