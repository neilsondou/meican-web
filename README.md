# 每餐 Web

「每餐」的 Flutter Web 构建产物，部署在 Vercel，访问地址：<https://meican.dou.asia/>。

这个仓库只放编译后的静态文件，不包含 AI 密钥、账号或密码。源码与 Cloudflare Worker 在
[neilsondou/meican](https://github.com/neilsondou/meican)。

## 已配置

- 网页端调用 `https://api.meican.dou.asia`（Cloudflare Worker + D1）。
- 网页端不内置 AI 密钥，拍照识别不需要登录；由 Worker 代理并做匿名限流，浏览器跨域也由 Worker 处理。
- 云同步是可选的，只负责备份与合并，不影响拍照、记录和趋势等本地功能。
- `vercel.json` 关闭了入口文件与 Service Worker 的长缓存，发布后能及时拿到新版本。

## 在 Vercel 部署

1. 打开 Vercel → **Add New → Project**，导入 `neilsondou/meican-web`。
2. Framework Preset 选 **Other**；Build Command 留空，Output Directory 保持默认（仓库根目录）。
3. 点击 **Deploy**。首次部署后应能通过 Vercel 提供的地址打开。
4. 进入项目 **Settings → Domains**，添加 `meican.dou.asia`。
5. 按 Vercel 页面给出的 DNS 记录配置：
   - 在 Cloudflare 的 `dou.asia` 区域添加 `CNAME`：名称 `meican`，目标 `cname.vercel-dns.com`。
   - 初始验证阶段把代理状态设为 **DNS only**（灰色云朵），避免和 Vercel 的证书签发冲突。
   - 如果 Vercel 给出了新的记录值，以 Vercel 页面为准。
6. 等待 Vercel 显示域名 Valid，打开 <https://meican.dou.asia/>。

`api.meican.dou.asia` 是 Cloudflare Worker 的自定义域名，在 Worker 的
**Settings → Domains & Routes** 中绑定，Cloudflare 会自动创建对应的 DNS 记录；它和上面
Vercel 的 `meican` 记录互不影响。

## 更新网页

在源码仓库重新构建（不要传 `MEICAN_AI_KEYS`）：

```bash
flutter build web --release \
  --no-web-resources-cdn \
  --dart-define=MEICAN_API_BASE=https://api.meican.dou.asia
```

`--no-web-resources-cdn` 让网页从本仓库的 `canvaskit/` 加载引擎文件；中文字体已经裁剪并打包在 `assets/fonts`。这两项是首屏速度的关键，构建时不要省略。

把 `build/web` 的内容覆盖到本仓库根目录，提交并推送。Vercel 会自动重新部署。

如果 Worker 没有绑定自定义域名，改用 `wrangler deploy` 输出的
`https://meican-api.<子域>.workers.dev` 重新构建；同时确认 Worker 的允许来源包含
`https://meican.dou.asia`。
