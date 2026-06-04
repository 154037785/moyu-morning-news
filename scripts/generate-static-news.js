const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const FEED_TIMEOUT_MS = Number(process.env.FEED_TIMEOUT_MS || 30000);
const TARGET_EPISODE_SECONDS = Number(process.env.TARGET_EPISODE_SECONDS || 20 * 60);
const OUT_DIR = path.join(__dirname, "..", "public", "data");
const OUT_FILE = path.join(OUT_DIR, "news.json");

const SOURCES = [
  { name: "36氪综合资讯", category: "科技商业", url: "https://36kr.com/feed" },
  { name: "36氪最新快讯", category: "科技商业", url: "https://36kr.com/feed-newsflash" },
  { name: "BBC中文", category: "国际要闻", url: "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml" },
  { name: "CNA Asia", category: "亚太", url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511" },
  { name: "CNA Business", category: "财经", url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936" },
  { name: "CNA Sport", category: "体育", url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10296" },
  { name: "CNA World", category: "国际要闻", url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6311" },
  { name: "OpenAI News", category: "大模型", url: "https://openai.com/news/rss.xml" },
  { name: "NVIDIA Blog", category: "大模型", url: "https://blogs.nvidia.com/feed/" },
  { name: "NVIDIA Developer Blog", category: "大模型", url: "https://developer.nvidia.com/blog/feed/" },
  { name: "Anthropic News Feed", category: "大模型", url: "https://raw.githubusercontent.com/0xSMW/rss-feeds/main/feeds/feed_anthropic_news.xml" },
  { name: "Planet AI", category: "大模型", url: "https://planet-ai.net/rss.xml" },
];

function decodeEntities(value = "") {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1] && entity[1].toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity] || match;
  });
}

function stripTags(value = "") {
  return decodeEntities(
    String(value)
      .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function readTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function readAtomLink(xml) {
  const href = xml.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  return href ? decodeEntities(href[1]) : readTag(xml, "link");
}

function extractImage(xml) {
  const enclosure = xml.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*type=["']image\/[^"']+["'][^>]*>/i);
  if (enclosure) return decodeEntities(enclosure[1]);
  const media = xml.match(/<media:(?:content|thumbnail)\b[^>]*url=["']([^"']+)["'][^>]*>/i);
  return media ? decodeEntities(media[1]) : "";
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "MoyuMorningNews/1.0 static generator",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseFeed(xml, source) {
  const itemMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi);
  const entryMatches = xml.match(/<entry\b[\s\S]*?<\/entry>/gi);
  const nodes = itemMatches && itemMatches.length ? itemMatches : entryMatches || [];

  return nodes.slice(0, 24).map((node) => {
    const title = readTag(node, "title");
    const description = readTag(node, "description") || readTag(node, "summary") || readTag(node, "content:encoded") || "暂无摘要。";
    const link = readAtomLink(node);
    const pubDate = readTag(node, "pubDate") || readTag(node, "published") || readTag(node, "updated");
    const parsedDate = pubDate ? new Date(pubDate) : new Date();
    return {
      id: crypto.createHash("sha1").update(`${source.name}:${title}:${link}`).digest("hex").slice(0, 16),
      title,
      description: description.slice(0, 240),
      link,
      image: extractImage(node),
      source: source.name,
      category: source.category,
      publishedAt: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
    };
  }).filter((item) => item.title);
}

function dedupeAndSort(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.title.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

function hasChinese(value = "") {
  return /[\u3400-\u9fff]/.test(value);
}

function isMostlyEnglish(value = "") {
  const letters = String(value).match(/[a-zA-Z]/g)?.length || 0;
  const chinese = String(value).match(/[\u3400-\u9fff]/g)?.length || 0;
  return letters > 18 && letters > chinese * 2;
}

function translateEnglishLite(value = "") {
  const raw = String(value);
  const text = raw.toLowerCase();
  const entities = [];
  const topics = [];
  const actions = [];

  [
    ["openai", "OpenAI"], ["anthropic", "Anthropic"], ["claude", "Claude"], ["nvidia", "英伟达"],
    ["google deepmind", "Google DeepMind"], ["gemini", "Gemini"], ["microsoft", "微软"],
    ["meta", "Meta"], ["amd", "AMD"], ["hpe", "惠普企业"], ["berkshire", "伯克希尔"],
  ].forEach(([needle, label]) => {
    if (text.includes(needle) && !entities.includes(label)) entities.push(label);
  });

  [
    [/generative ai|artificial intelligence|\bai\b/, "人工智能"],
    [/large language model|language model|foundation model|\bmodel\b|models/, "大模型"],
    [/\bagent\b|agents|agentic/, "智能体"],
    [/robot|robotics|humanoid/, "机器人"],
    [/chip|chips|gpu|accelerator|semiconductor/, "AI芯片和算力"],
    [/data center|datacenter|cloud|infrastructure/, "云和数据中心"],
    [/developer|developers|api|coding|code/, "开发者工具"],
    [/safety|alignment|policy|regulation|regulatory/, "安全与监管"],
    [/enterprise|business|customer|adoption/, "企业落地"],
    [/funding|valuation|ipo|invest|investment|raise|secures/, "资本市场"],
    [/research|paper|benchmark|eval/, "研究进展"],
  ].forEach(([pattern, label]) => {
    if (pattern.test(text) && !topics.includes(label)) topics.push(label);
  });

  [
    [/launch|release|introduce|debut|unveil|announce/, "有新的产品或能力发布"],
    [/partner|partnership|collaborat|work with/, "出现新的合作关系"],
    [/raise|funding|valuation|invest|secures/, "资本投入和估值成为关注点"],
    [/lawsuit|sue|settlement|regulation|ban|probe/, "监管和法律风险受到关注"],
    [/forecast|outlook|demand|surge|growth/, "市场预期和需求变化正在发酵"],
    [/open source|open-source/, "开源生态有新动向"],
  ].forEach(([pattern, label]) => {
    if (pattern.test(text) && !actions.includes(label)) actions.push(label);
  });

  const numbers = raw.match(/(?:US\$|\$|€|£)?\s?\d+(?:\.\d+)?\s?(?:billion|million|bn|m|%)/gi) || [];
  const entityText = entities.length ? `${entities.slice(0, 4).join("、")}相关动态` : "相关动态";
  const topicText = topics.length ? topics.slice(0, 4).join("、") : "行业变化";
  const actionText = actions.length ? actions.slice(0, 2).join("，") : "释放出新的行业信号";
  const numberText = numbers.length ? `其中提到的关键数字包括${numbers.slice(0, 3).join("、")}。` : "";
  return `消息显示，${entityText}集中在${topicText}。${actionText}。${numberText}`.trim();
}

function localizeItem(item) {
  const title = stripTags(item.title || "");
  const description = stripTags(item.description || "");
  if (hasChinese(`${title}${description}`) && !isMostlyEnglish(title)) {
    return {
      title,
      detail: description && description !== "暂无摘要。" ? description : title,
    };
  }
  return {
    title: `${item.category}消息`,
    detail: translateEnglishLite(`${title}. ${description}`),
  };
}

function decorateItem(item) {
  const localized = localizeItem(item);
  return { ...item, displayTitle: localized.title, displayDescription: localized.detail };
}

function estimateScriptSeconds(script) {
  const clean = script.replace(/\s/g, "");
  const chineseChars = clean.match(/[\u3400-\u9fff]/g)?.length || 0;
  const otherChars = clean.length - chineseChars;
  return Math.max(30, Math.round(chineseChars / 4.8 + otherChars / 8));
}

function sanitizeBroadcastScript(script = "") {
  return String(script)
    .replace(/第\s*\d+\s*个信号是[:：]?/g, "")
    .replace(/复盘第\s*\d+\s*个观察点[:：]?/g, "")
    .replace(/这条消息关系到[^。！？!?]*[。！？!?]/g, "")
    .replace(/短期看，这是新闻；中期看，[^。！？!?]*[。！？!?]/g, "")
    .replace(/换句话说，[^。！？!?]*[。！？!?]/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/(欢迎收听|各位听众|摸鱼早报|开始播报|接下来不是|目标时长|切换倍速|以上就是|祝你|我们下次|先看最靠前|继续把|重新压缩成)/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/。。+/g, "。")
    .trim();
}

function buildLocalScript(items, category) {
  const selected = items.slice(0, category === "综合" ? 42 : 32);
  const newest = selected[0] ? new Date(selected[0].publishedAt) : new Date();
  const dateText = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(newest);
  const lines = [`截至${dateText}，最新消息显示：`];

  for (const item of selected) {
    const localized = localizeItem(item);
    const prefix = category === "综合" ? `${item.category}方面，` : "";
    lines.push(`${prefix}${localized.title}。${localized.detail}。`);
  }

  while (estimateScriptSeconds(lines.join("\n")) < TARGET_EPISODE_SECONDS * 0.96) {
    for (const item of selected.slice(0, Math.min(12, selected.length))) {
      if (estimateScriptSeconds(lines.join("\n")) >= TARGET_EPISODE_SECONDS * 0.96) break;
      const localized = localizeItem(item);
      lines.push(`${localized.title}。${localized.detail}。`);
    }
  }

  return sanitizeBroadcastScript(lines.join("\n"));
}

async function askDeepSeek(baseEpisode, items) {
  if (!DEEPSEEK_API_KEY) return baseEpisode.script;
  const selected = items.slice(0, baseEpisode.category === "综合" ? 36 : 28).map((item) => ({
    title: item.title,
    description: item.description,
    source: item.source,
    category: item.category,
    publishedAt: item.publishedAt,
  }));
  const chunks = [];
  for (let index = 0; index < selected.length; index += 4) chunks.push(selected.slice(index, index + 4));
  const parts = [];

  for (let index = 0; index < Math.min(chunks.length, 10); index += 1) {
    const prompt = [
      "你是中文新闻主播和编辑。只写新闻正文，不要问候，不要解释。",
      "请把下面这一组新闻写成一段连续播报稿。",
      "要求：",
      "1. 全部使用中文；英文标题和摘要必须翻译、概括、融合。",
      "2. 只处理本组新闻，不要重复前后段会出现的内容。",
      "3. 不要写小标题、编号、项目符号、欢迎语和结束语。",
      "4. 语言要客观、准确、顺畅、信息密度高，同时像真人主播自然转述，不要公文腔。",
      "5. 可以做必要背景和影响分析，但不得编造输入以外的事实。",
      "6. 这一段不少于900个汉字，不靠重复凑字数。",
      `早报：${baseEpisode.title}`,
      `板块：${baseEpisode.category}`,
      `新闻 JSON：${JSON.stringify(chunks[index])}`,
    ].join("\n");
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: "你只写中文新闻播报正文。自然、清楚、有呼吸感，不能寒暄，不能重复。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.28,
        max_tokens: 1800,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    const data = await response.json();
    const part = data.choices?.[0]?.message?.content?.trim();
    if (part) parts.push(part);
  }

  const script = sanitizeBroadcastScript(parts.join("\n\n"));
  return estimateScriptSeconds(script) >= TARGET_EPISODE_SECONDS * 0.8 ? script : baseEpisode.script;
}

async function buildEpisode(id, title, subtitle, category, items) {
  const selected = items.slice(0, category === "综合" ? 42 : 32);
  const baseScript = buildLocalScript(selected, category);
  const baseEpisode = {
    id,
    title,
    subtitle,
    category,
    itemIds: selected.map((item) => item.id),
    count: selected.length,
    durationHint: estimateScriptSeconds(baseScript),
    script: baseScript,
    generationMode: "local",
    updatedAt: new Date().toISOString(),
  };

  try {
    const script = await askDeepSeek(baseEpisode, selected);
    return {
      ...baseEpisode,
      script,
      durationHint: estimateScriptSeconds(script),
      generationMode: script === baseScript ? "local" : "deepseek",
    };
  } catch (error) {
    return { ...baseEpisode, generationError: error.message };
  }
}

async function buildEpisodes(items) {
  const sections = {};
  for (const item of items) {
    if (!sections[item.category]) sections[item.category] = [];
    sections[item.category].push(item);
  }

  const specs = [
    ["daily-roundup", "今日总览", "跨领域重点新闻。", "综合", items],
    ...Object.entries(sections).map(([category, sectionItems]) => [
      `section-${crypto.createHash("md5").update(category).digest("hex").slice(0, 8)}`,
      `${category}早报`,
      `${category}重点新闻。`,
      category,
      sectionItems,
    ]),
  ];

  const episodes = [];
  for (const spec of specs) episodes.push(await buildEpisode(...spec));
  return episodes;
}

async function main() {
  const allItems = [];
  const sourceStatus = [];

  await Promise.all(SOURCES.map(async (source) => {
    try {
      const xml = await fetchText(source.url);
      const items = parseFeed(xml, source);
      allItems.push(...items);
      sourceStatus.push({ name: source.name, category: source.category, ok: true, count: items.length, url: source.url });
    } catch (error) {
      sourceStatus.push({ name: source.name, category: source.category, ok: false, count: 0, url: source.url, error: error.message });
    }
  }));

  const items = dedupeAndSort(allItems);
  if (!items.length) throw new Error("No news items fetched");
  const decoratedItems = items.map(decorateItem);
  const sections = {};
  for (const item of decoratedItems) {
    if (!sections[item.category]) sections[item.category] = [];
    sections[item.category].push(item);
  }
  const episodes = await buildEpisodes(items);
  const okCount = sourceStatus.filter((item) => item.ok).length;
  const payload = {
    updatedAt: new Date().toISOString(),
    statusText: `${okCount}/${sourceStatus.length} 个来源更新成功`,
    sourceStatus: sourceStatus.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
    isUpdating: false,
    lastError: null,
    generationMode: episodes.some((episode) => episode.generationMode === "deepseek") ? "deepseek" : "local",
    items: decoratedItems,
    sections,
    episodes,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${OUT_FILE}: ${decoratedItems.length} items, ${episodes.length} episodes`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
