# 摸鱼早报

一个手机优先的新闻联播播客网站：服务器联网抓取 RSS/Atom 新闻，自动分板块聚合，把多条新闻整理成连续播报稿，再用浏览器语音合成播放。

## 功能

- 联网自动更新新闻，默认每 30 分钟刷新一次。
- 按科技商业、国际要闻、财经、体育、亚太、大模型等板块整理。
- 新增大模型板块，覆盖 OpenAI、英伟达、Claude/Anthropic、AI 行业聚合动态。
- 把英文新闻中文化后融合进播报稿。
- 每条早报默认按约 20 分钟播报目标生成。
- 支持 `0.75x`、`1.0x`、`1.25x`、`1.5x`、`1.75x`、`2.0x`、`2.5x`、`3.0x` 倍速。
- 支持自动男女声、男声、女声，以及指定系统语音。
- 支持播放/暂停、后退 10 秒、快进 10 秒、进度条跳转。
- 详情页右上角支持收藏、转发；左上角支持退出和选集。
- 支持下滑退出播放器。

## 运行

```powershell
npm run dev
```

默认监听：

```text
http://localhost:3000
```

同一 Wi-Fi 下，手机可以访问电脑局域网 IP：

```text
http://你的电脑IP:3000
```

如果手机使用移动流量访问，需要部署到公网服务器，或使用 Cloudflare Tunnel、frp、ngrok 等把本机端口暴露到公网。

## 固定公网网址

`trycloudflare.com` quick tunnel 是临时网址，会过期，不适合长期分享。

### Render 免费固定网址

不买域名时，推荐部署到 Render。免费版会给一个固定网址，例如：

```text
https://moyu-morning-news.onrender.com
```

免费版可能休眠，第一次打开会慢一些，但网址不会像 quick tunnel 一样频繁变化。

部署步骤：

1. 把本项目上传到 GitHub。
2. 打开 Render Dashboard。
3. New -> Blueprint。
4. 选择这个 GitHub 仓库。
5. Render 会自动读取 [render.yaml](./render.yaml)。
6. 在 Environment 里填写：

```text
DEEPSEEK_API_KEY=你的 DeepSeek key
```

7. 点击 Deploy。

部署完成后，Render 会给出固定访问地址。手机流量和别人都可以访问这个地址。

注意：不要把 `DEEPSEEK_API_KEY` 写进代码或 GitHub 仓库。

要得到永久可用的网址，推荐使用 Cloudflare Named Tunnel，并绑定你自己的域名，例如：

```text
news.example.com
```

前提：

- 你有一个域名。
- 这个域名已经接入 Cloudflare DNS。
- 本机可以运行 `cloudflared`。

配置固定域名：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-cloudflare-named-tunnel.ps1 -Hostname news.example.com
```

启动固定网址服务：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-permanent-site.ps1
```

安装开机/登录自启动：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup-task.ps1
```

完成后，别人可以长期访问：

```text
https://news.example.com
```

## 更自然的播报稿

默认模式会用本地规则生成连续播报稿，不依赖任何付费接口。

如果你希望它真正像专业新闻编辑一样做翻译、改写、归纳和串联，可以配置 DeepSeek API：

```powershell
$env:DEEPSEEK_API_KEY="你的 key"
$env:DEEPSEEK_MODEL="deepseek-chat"
npm run dev
```

也可以配置 OpenAI API 作为备用：

```powershell
$env:OPENAI_API_KEY="你的 key"
$env:OPENAI_MODEL="gpt-4.1-mini"
npm run dev
```

配置后，每次更新新闻时会优先用 DeepSeek 生成播报稿；如果接口不可用，会自动回退到 OpenAI 或本地规则。

## 可调参数

刷新间隔，单位毫秒：

```powershell
$env:CACHE_TTL_MS=900000
```

端口：

```powershell
$env:PORT=8080
```

早报目标时长，单位秒：

```powershell
$env:TARGET_EPISODE_SECONDS=1200
```

## 新闻源

新闻源在 [server.js](./server.js) 的 `SOURCES` 里。每个源包含：

```js
{
  name: "来源名称",
  category: "板块名称",
  url: "RSS 或 Atom 地址"
}
```

默认大模型来源包括 OpenAI News、NVIDIA Blog、NVIDIA Developer Blog、Anthropic News Feed、Planet AI。

## 声音说明

网页使用浏览器内置 Web Speech API。声音自然度取决于手机或浏览器安装的语音包：iOS、Edge、Chrome、Windows、Android 上可用声音都不同。页面会自动优先选择中文、自然、神经网络或系统高质量语音，并支持男女声自动切换。
