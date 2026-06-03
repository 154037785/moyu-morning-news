const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30 * 60 * 1000);
const FEED_TIMEOUT_MS = Number(process.env.FEED_TIMEOUT_MS || 30 * 1000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const TARGET_EPISODE_SECONDS = Number(process.env.TARGET_EPISODE_SECONDS || 20 * 60);
const PUBLIC_DIR = path.join(__dirname, "public");

const SOURCES = [
  {
    name: "36氪综合资讯",
    category: "科技商业",
    url: "https://36kr.com/feed",
  },
  {
    name: "36氪最新快讯",
    category: "科技商业",
    url: "https://36kr.com/feed-newsflash",
  },
  {
    name: "BBC中文",
    category: "国际要闻",
    url: "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml",
  },
  {
    name: "CNA Asia",
    category: "亚太",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511",
  },
  {
    name: "CNA Business",
    category: "财经",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6936",
  },
  {
    name: "CNA Sport",
    category: "体育",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10296",
  },
  {
    name: "CNA World",
    category: "国际要闻",
    url: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6311",
  },
  {
    name: "OpenAI News",
    category: "大模型",
    url: "https://openai.com/news/rss.xml",
  },
  {
    name: "NVIDIA Blog",
    category: "大模型",
    url: "https://blogs.nvidia.com/feed/",
  },
  {
    name: "NVIDIA Developer Blog",
    category: "大模型",
    url: "https://developer.nvidia.com/blog/feed/",
  },
  {
    name: "Anthropic News Feed",
    category: "大模型",
    url: "https://raw.githubusercontent.com/0xSMW/rss-feeds/main/feeds/feed_anthropic_news.xml",
  },
  {
    name: "Planet AI",
    category: "大模型",
    url: "https://planet-ai.net/rss.xml",
  },
];

const FALLBACK_ITEMS = [
  {
    title: "当前还没有抓取到联网新闻",
    description: "服务器会在启动后自动尝试更新。请确认运行机器可以访问互联网，稍后刷新页面即可。",
    link: "",
    source: "系统提示",
    category: "综合",
    publishedAt: new Date().toISOString(),
  },
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

let cache = {
  updatedAt: null,
  items: [],
  episodes: [],
  generationMode: "local",
  sourceStatus: [],
  isUpdating: false,
  lastError: null,
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
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

function decodeEntities(value = "") {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1] && entity[1].toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    }
    return named[entity] || _;
  });
}

function readTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function readAtomLink(xml) {
  const href = xml.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (href) return decodeEntities(href[1]);
  return readTag(xml, "link");
}

function extractImage(xml) {
  const enclosure = xml.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*type=["']image\/[^"']+["'][^>]*>/i);
  if (enclosure) return decodeEntities(enclosure[1]);
  const media = xml.match(/<media:(?:content|thumbnail)\b[^>]*url=["']([^"']+)["'][^>]*>/i);
  if (media) return decodeEntities(media[1]);
  return "";
}

function parseFeed(xml, source) {
  const blocks = [];
  const itemMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi);
  const entryMatches = xml.match(/<entry\b[\s\S]*?<\/entry>/gi);
  const nodes = itemMatches && itemMatches.length ? itemMatches : entryMatches || [];

  for (const node of nodes.slice(0, 24)) {
    const title = readTag(node, "title");
    if (!title) continue;

    const description =
      readTag(node, "description") ||
      readTag(node, "summary") ||
      readTag(node, "content:encoded") ||
      "暂无摘要。";
    const link = readAtomLink(node);
    const pubDate = readTag(node, "pubDate") || readTag(node, "published") || readTag(node, "updated");
    const parsedDate = pubDate ? new Date(pubDate) : new Date();
    const idSeed = `${source.name}:${title}:${link}`;

    blocks.push({
      id: crypto.createHash("sha1").update(idSeed).digest("hex").slice(0, 16),
      title,
      description: description.slice(0, 240),
      link,
      image: extractImage(node),
      source: source.name,
      category: source.category,
      publishedAt: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
    });
  }

  return blocks;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "MoyuMorningNews/1.0 (+local personal news reader)",
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function dedupeAndSort(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const key = `${item.title}`.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

function summarizeStatus(status) {
  const okCount = status.filter((item) => item.ok).length;
  return `${okCount}/${status.length} 个来源更新成功`;
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
    ["openai", "OpenAI"],
    ["anthropic", "Anthropic"],
    ["claude", "Claude"],
    ["nvidia", "英伟达"],
    ["google deepmind", "Google DeepMind"],
    ["gemini", "Gemini"],
    ["microsoft", "微软"],
    ["meta", "Meta"],
    ["amd", "AMD"],
    ["hpe", "惠普企业"],
    ["berkshire", "伯克希尔"],
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

  const translatedDetail = translateEnglishLite(`${title}. ${description}`);
  return {
    title: `${item.category}消息`,
    detail: translatedDetail,
  };
}

function decorateItem(item) {
  const localized = localizeItem(item);
  return {
    ...item,
    displayTitle: localized.title,
    displayDescription: localized.detail,
  };
}

function sanitizeBroadcastScript(script = "") {
  return String(script)
    .replace(/第\s*\d+\s*个信号是[:：]?/g, "")
    .replace(/复盘第\s*\d+\s*个观察点[:：]?/g, "")
    .replace(/这条消息关系到[^。！？!?]*[。！？!?]/g, "")
    .replace(/这条消息可以放在[^。！？!?]*[。！？!?]/g, "")
    .replace(/这条消息更偏向[^。！？!?]*[。！？!?]/g, "")
    .replace(/这条消息的重点[^。！？!?]*[。！？!?]/g, "")
    .replace(/短期看，这是新闻；中期看，[^。！？!?]*[。！？!?]/g, "")
    .replace(/换句话说，[^。！？!?]*[。！？!?]/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/(欢迎收听|各位听众|摸鱼早报|开始播报|接下来不是|本期整合\d+条消息|目标时长|切换倍速|以上就是|祝你|我们下次|先看最靠前|再看这些变化|接着把视线|最后补上|继续把|重新压缩成)/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/。。+/g, "。")
    .trim();
}

function extendScriptWithNews(script, items, category) {
  const lines = sanitizeBroadcastScript(script)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const existing = lines.join("");

  for (const item of items) {
    if (estimateScriptSeconds(lines.join("\n")) >= TARGET_EPISODE_SECONDS * 0.96) break;
    const localized = localizeItem(item);
    const titleKey = localized.title.slice(0, 18);
    if (titleKey && existing.includes(titleKey)) continue;
    const prefix = category === "综合" ? `${item.category}方面，` : "";
    lines.push(`${prefix}${localized.title}。${localized.detail}。`);
  }

  return sanitizeBroadcastScript(lines.join("\n"));
}

function fitScriptToTarget(script, items, category) {
  const cleaned = sanitizeBroadcastScript(script);
  if (estimateScriptSeconds(cleaned) >= TARGET_EPISODE_SECONDS * 0.96) return cleaned;
  return extendScriptWithNews(cleaned, items, category);
}

function inferAngle(item, category) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  if (category === "大模型") {
    if (/openai|anthropic|claude|gemini|deepmind|nvidia|ai|model|agent|gpu/.test(text)) {
      return "这条消息关系到大模型生态的产品节奏、算力供给和开发者工具链。";
    }
    return "这条消息可以放在人工智能产业链的变化中观察。";
  }
  if (/融资|估值|funding|valuation|ipo|股|market|stocks|证券|基金|债|金价|oil/.test(text)) {
    return "它的看点在于资本、价格和预期的变化，后续可能影响企业融资和市场情绪。";
  }
  if (/ai|人工智能|英伟达|openai|芯片|算力|模型/.test(text)) {
    return "它折射出技术基础设施和产业应用正在继续提速。";
  }
  if (/体育|world cup|french open|足球|网球|比赛/.test(text)) {
    return "这条消息更偏向赛事进程和公众关注度的变化。";
  }
  if (/政府|政策|监管|regulatory|国债|指南|能源|安全/.test(text)) {
    return "它背后是政策、监管和公共治理方向的调整。";
  }
  return "这条消息的重点，是相关行业正在出现新的信号，需要放在更大的背景里看。";
}

function buildLead(selected, category) {
  const newest = selected[0] ? new Date(selected[0].publishedAt) : new Date();
  const dateText = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(newest);
  return [
    `截至${dateText}，最新消息显示：`,
  ];
}

function buildNarrativeLines(selected, category) {
  const lines = [];
  const chapterSize = Math.max(4, Math.ceil(selected.length / 4));

  for (let i = 0; i < selected.length; i += chapterSize) {
    const group = selected.slice(i, i + chapterSize);
    group.forEach((item) => {
      const localized = localizeItem(item);
      const categoryIntro = category === "综合" ? `${item.category}方面，` : "";
      lines.push(`${categoryIntro}${localized.title}。${localized.detail}。`);
    });
  }

  return lines;
}

function estimateScriptSeconds(script) {
  const clean = script.replace(/\s/g, "");
  const chineseChars = clean.match(/[\u3400-\u9fff]/g)?.length || 0;
  const otherChars = clean.length - chineseChars;
  return Math.max(30, Math.round(chineseChars / 4.8 + otherChars / 8));
}

function padToTarget(lines, selected, category) {
  let script = lines.join("\n");
  let loops = 0;
  while (estimateScriptSeconds(script) < TARGET_EPISODE_SECONDS * 0.96 && loops < 10) {
    loops += 1;
    selected.slice(0, Math.min(12, selected.length)).forEach((item) => {
      const localized = localizeItem(item);
      lines.push(`${localized.title}。${localized.detail}。`);
    });
    script = lines.join("\n");
  }
  return lines;
}

function buildLocalEpisode(id, title, subtitle, category, items) {
  const selected = items.slice(0, category === "综合" ? 42 : 32);
  const lines = [
    ...buildLead(selected, category),
    ...buildNarrativeLines(selected, category),
  ];
  padToTarget(lines, selected, category);

  const script = fitScriptToTarget(lines.join("\n"), selected, category);

  return {
    id,
    title,
    subtitle,
    category,
    itemIds: selected.map((item) => item.id),
    count: selected.length,
    durationHint: estimateScriptSeconds(script),
    script,
    updatedAt: new Date().toISOString(),
  };
}

async function buildAiEpisode(baseEpisode, items) {
  if ((!DEEPSEEK_API_KEY && !OPENAI_API_KEY) || !items.length) return baseEpisode;

  const selected = items.slice(0, baseEpisode.category === "综合" ? 36 : 28).map((item) => ({
    title: item.title,
    description: item.description,
    source: item.source,
    category: item.category,
    publishedAt: item.publishedAt,
  }));

  const prompt = [
    "你是资深中文新闻主播和编辑。稿件必须只播新闻事实，但语言要像真人主播自然转述，顺畅、有呼吸感，不要官腔，不要模板腔。",
    "把输入新闻整合成自然、连贯、适合语音朗读的中文播报稿。",
    "要求：",
    "1. 只输出新闻播报稿，不要问候、不要自我介绍、不要解释你在做什么。",
    "2. 英文新闻必须翻译并融合成中文，不要保留大段英文标题。",
    "3. 删除无聊、重复、空泛的内容；同一事实只说一次。",
    "4. 不要机械逐条读来源和摘要，要按重要性和逻辑关系串联。",
    "5. 可以有必要背景和影响分析，但必须基于输入事实做保守推断，不编造。",
    "6. 语言要准确、简洁、顺畅，但要有人说话的自然停顿；避免公文腔、口号腔和机械模板句。",
    "7. 目标是约二十分钟中文播报稿，正文不少于5200个汉字；靠更多事实串联、背景解释和影响分析增加信息量，不靠重复凑时长。",
    "8. 稿件要分成自然段，但不要写小标题，不要写项目符号。",
    "9. 输出纯文本，不要 Markdown。",
    `早报标题：${baseEpisode.title}`,
    `板块：${baseEpisode.category}`,
    `新闻 JSON：${JSON.stringify(selected)}`,
  ].join("\n");

  try {
    const provider = DEEPSEEK_API_KEY ? "deepseek" : "openai";
    if (provider === "deepseek") {
      const chunks = [];
      for (let index = 0; index < selected.length; index += 4) {
        chunks.push(selected.slice(index, index + 4));
      }

      const parts = [];
      for (let index = 0; index < Math.min(chunks.length, 10); index += 1) {
        const chapterPrompt = [
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
          `这是第${index + 1}组，共${chunks.length}组。`,
          `新闻 JSON：${JSON.stringify(chunks[index])}`,
        ].join("\n");

        const chapterResponse = await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: [
              { role: "system", content: "你只写中文新闻播报正文。自然、清楚、有呼吸感，不能寒暄，不能重复。" },
              { role: "user", content: chapterPrompt },
            ],
            temperature: 0.28,
            max_tokens: 1800,
            stream: false,
          }),
        });
        if (!chapterResponse.ok) throw new Error(`deepseek HTTP ${chapterResponse.status}`);
        const chapterData = await chapterResponse.json();
        const part = chapterData.choices?.[0]?.message?.content?.trim();
        if (part) parts.push(part);
      }

      const script = fitScriptToTarget(parts.join("\n\n"), items, baseEpisode.category);
      if (!script || script.length < 800) return baseEpisode;
      if (estimateScriptSeconds(script) < TARGET_EPISODE_SECONDS * 0.72) {
        return {
          ...baseEpisode,
          generationMode: "local",
          generationError: "DeepSeek 分段稿件仍低于目标时长，已回退到本地长稿。",
        };
      }
      return {
        ...baseEpisode,
        script,
        durationHint: estimateScriptSeconds(script),
        generationMode: "deepseek",
        updatedAt: new Date().toISOString(),
      };
    }

    const response = provider === "deepseek"
      ? await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: [
              { role: "system", content: "你只写中文新闻播报稿，追求客观、通顺、信息密度高，同时像真人主播自然转述。" },
              { role: "user", content: prompt },
            ],
            temperature: 0.35,
            max_tokens: 9000,
            stream: false,
          }),
        })
      : await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            input: prompt,
            temperature: 0.35,
          }),
        });
    if (!response.ok) throw new Error(`${provider} HTTP ${response.status}`);
    const data = await response.json();
    const rawScript = provider === "deepseek"
      ? data.choices?.[0]?.message?.content?.trim()
      : data.output_text ||
        data.output?.flatMap((item) => item.content || [])
          .map((part) => part.text || "")
          .join("\n")
          .trim();
    const script = fitScriptToTarget(rawScript, items, baseEpisode.category);
    if (!script || script.length < 800) return baseEpisode;
      if (estimateScriptSeconds(script) < TARGET_EPISODE_SECONDS * 0.9) {
      return {
        ...baseEpisode,
        generationMode: "local",
        generationError: "模型生成稿件低于目标时长，已回退到本地长稿。",
      };
    }
    return {
      ...baseEpisode,
      script,
      durationHint: estimateScriptSeconds(script),
      generationMode: provider,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ...baseEpisode,
      generationMode: "local",
      generationError: error.message,
    };
  }
}

async function buildEpisodes(items) {
  const sections = {};
  for (const item of items) {
    if (!sections[item.category]) sections[item.category] = [];
    sections[item.category].push(item);
  }

  const baseEpisodes = [
    buildLocalEpisode(
      "daily-roundup",
      "今日总览",
      "先听跨领域重点，再把大模型、财经和国际消息串起来。",
      "综合",
      items
    ),
    ...Object.entries(sections).map(([category, sectionItems]) =>
      buildLocalEpisode(
        `section-${crypto.createHash("md5").update(category).digest("hex").slice(0, 8)}`,
        `${category}早报`,
        `${category}板块为你整合成一段连续播报。`,
        category,
        sectionItems
      )
    ),
  ].filter((episode) => episode.count > 0);

  const episodes = [];
  for (const episode of baseEpisodes) {
    const episodeItems = episode.id === "daily-roundup"
      ? items
      : items.filter((item) => item.category === episode.category);
    episodes.push(await buildAiEpisode(episode, episodeItems));
  }
  return episodes;
}

function shapePayload() {
  const rawItems = cache.items.length ? cache.items : FALLBACK_ITEMS.map((item, index) => ({
    ...item,
    id: `fallback-${index}`,
  }));
  const items = rawItems.map(decorateItem);

  const sections = {};
  for (const item of items) {
    if (!sections[item.category]) sections[item.category] = [];
    sections[item.category].push(item);
  }

  return {
    updatedAt: cache.updatedAt,
    statusText: cache.sourceStatus.length ? summarizeStatus(cache.sourceStatus) : "等待首次更新",
    sourceStatus: cache.sourceStatus,
    isUpdating: cache.isUpdating,
    lastError: cache.lastError,
    generationMode: cache.generationMode,
    items,
    sections,
    episodes: cache.episodes.length ? cache.episodes : [buildLocalEpisode("daily-roundup", "今日总览", "等待服务器完成首次新闻整合。", "综合", items)],
  };
}

async function updateNews(force = false) {
  if (cache.isUpdating) return;
  if (!force && cache.updatedAt && Date.now() - new Date(cache.updatedAt).getTime() < CACHE_TTL_MS) return;

  cache.isUpdating = true;
  const allItems = [];
  const sourceStatus = [];

  try {
    await Promise.all(
      SOURCES.map(async (source) => {
        try {
          const xml = await fetchText(source.url);
          const items = parseFeed(xml, source);
          allItems.push(...items);
          sourceStatus.push({
            name: source.name,
            category: source.category,
            ok: true,
            count: items.length,
            url: source.url,
          });
        } catch (error) {
          sourceStatus.push({
            name: source.name,
            category: source.category,
            ok: false,
            count: 0,
            url: source.url,
            error: error.message,
          });
        }
      })
    );

    const nextItems = dedupeAndSort(allItems);
    if (nextItems.length) {
      cache.items = nextItems;
      cache.episodes = await buildEpisodes(nextItems);
      cache.generationMode =
        cache.episodes.find((episode) => episode.generationMode === "deepseek")?.generationMode ||
        cache.episodes.find((episode) => episode.generationMode === "openai")?.generationMode ||
        "local";
      cache.updatedAt = new Date().toISOString();
      cache.lastError = null;
    } else {
      cache.lastError = "没有来源返回可用新闻，已保留旧缓存或显示占位内容。";
      if (!cache.updatedAt) cache.updatedAt = new Date().toISOString();
    }
    cache.sourceStatus = sourceStatus.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  } catch (error) {
    cache.lastError = error.message;
  } finally {
    cache.isUpdating = false;
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const segments = requestPath.split("/").filter(Boolean);

  if (segments.some((segment) => segment === "..")) {
    sendText(res, 403, "Forbidden");
    return;
  }

  const filePath = path.join(PUBLIC_DIR, ...segments);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/news") {
    await updateNews(false);
    sendJson(res, 200, shapePayload());
    return;
  }

  if (url.pathname === "/api/refresh") {
    await updateNews(true);
    sendJson(res, 200, shapePayload());
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, updatedAt: cache.updatedAt, items: cache.items.length });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`摸鱼早报 running at http://localhost:${PORT}`);
  updateNews(true);
  setInterval(() => updateNews(true), CACHE_TTL_MS).unref();
});
