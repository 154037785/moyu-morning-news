const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const voiceModes = [
  { id: "auto", label: "自动男女声" },
  { id: "female", label: "女声" },
  { id: "male", label: "男声" },
];
const state = {
  payload: null,
  currentEpisode: null,
  currentSegments: [],
  currentIndex: 0,
  isPlaying: false,
  speed: Number(localStorage.getItem("moyu:speed") || 1),
  voiceMode: localStorage.getItem("moyu:voiceMode") || "auto",
  selectedVoiceURI: localStorage.getItem("moyu:voiceURI") || "",
  voices: [],
  startedAt: 0,
  elapsedBeforeSegment: 0,
  favorites: new Set(JSON.parse(localStorage.getItem("moyu:favorites") || "[]")),
  touchStartY: 0,
};

const els = {
  refreshButton: document.getElementById("refreshButton"),
  playHeroButton: document.getElementById("playHeroButton"),
  heroTitle: document.getElementById("heroTitle"),
  heroMeta: document.getElementById("heroMeta"),
  updateStatus: document.getElementById("updateStatus"),
  episodeList: document.getElementById("episodeList"),
  sections: document.getElementById("sections"),
  playerSheet: document.getElementById("playerSheet"),
  playerPanel: document.getElementById("playerPanel"),
  sheetScrim: document.getElementById("sheetScrim"),
  closePlayerButton: document.getElementById("closePlayerButton"),
  openPickerButton: document.getElementById("openPickerButton"),
  favoriteButton: document.getElementById("favoriteButton"),
  shareButton: document.getElementById("shareButton"),
  shareSheet: document.getElementById("shareSheet"),
  shareScrim: document.getElementById("shareScrim"),
  closeShareButton: document.getElementById("closeShareButton"),
  shareStatus: document.getElementById("shareStatus"),
  playerCategory: document.getElementById("playerCategory"),
  playerTitle: document.getElementById("playerTitle"),
  playerSubtitle: document.getElementById("playerSubtitle"),
  currentTime: document.getElementById("currentTime"),
  durationTime: document.getElementById("durationTime"),
  progressSlider: document.getElementById("progressSlider"),
  backButton: document.getElementById("backButton"),
  forwardButton: document.getElementById("forwardButton"),
  mainPlayButton: document.getElementById("mainPlayButton"),
  playIcon: document.getElementById("playIcon"),
  speedRow: document.getElementById("speedRow"),
  voiceModeRow: document.getElementById("voiceModeRow"),
  voiceSelect: document.getElementById("voiceSelect"),
  voiceStatus: document.getElementById("voiceStatus"),
  scriptText: document.getElementById("scriptText"),
  episodePicker: document.getElementById("episodePicker"),
  pickerList: document.getElementById("pickerList"),
  closePickerButton: document.getElementById("closePickerButton"),
};

function formatTime(seconds) {
  const safe = Math.max(0, Math.round(seconds || 0));
  const mins = String(Math.floor(safe / 60)).padStart(2, "0");
  const secs = String(safe % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatDate(value) {
  if (!value) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeUrl(value = "") {
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}

function estimateDuration(text) {
  return Math.max(3, text.replace(/\s/g, "").length / (4.8 * state.speed));
}

function prepareSpeechText(text) {
  return String(text)
    .replace(/([，、；：])/g, "$1 ")
    .replace(/([。！？])/g, "$1  ")
    .replace(/(\d+)(亿元|亿美元|万亿美元|%|个|家|项)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function getEpisodeDuration() {
  return state.currentSegments.reduce((total, segment) => total + estimateDuration(segment), 0);
}

function getElapsed() {
  if (!state.currentEpisode) return 0;
  const current = state.isPlaying ? (Date.now() - state.startedAt) / 1000 : 0;
  return Math.min(getEpisodeDuration(), state.elapsedBeforeSegment + current);
}

function splitScript(script) {
  return script
    .split(/[\n。！？!?]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `${item}。`);
}

function renderTranscript() {
  els.scriptText.innerHTML = state.currentSegments
    .map((segment, index) => {
      const active = index === state.currentIndex ? " is-active" : "";
      const past = index < state.currentIndex ? " is-past" : "";
      return `<button class="lyric-line${active}${past}" type="button" data-line-index="${index}">${escapeHtml(segment)}</button>`;
    })
    .join("");
}

function updateTranscriptActive() {
  els.scriptText.querySelectorAll(".lyric-line").forEach((line) => {
    const index = Number(line.dataset.lineIndex);
    line.classList.toggle("is-active", index === state.currentIndex);
    line.classList.toggle("is-past", index < state.currentIndex);
  });
  const active = els.scriptText.querySelector(".lyric-line.is-active");
  if (active) {
    active.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function persistFavorites() {
  localStorage.setItem("moyu:favorites", JSON.stringify([...state.favorites]));
}

function updateFavoriteButton() {
  const isFavorite = state.currentEpisode && state.favorites.has(state.currentEpisode.id);
  els.favoriteButton.querySelector("span").textContent = isFavorite ? "★" : "☆";
}

function renderSpeeds() {
  els.speedRow.innerHTML = speeds
    .map((speed) => {
      const active = speed === state.speed ? " is-active" : "";
      const label = speed === 1 ? "1.0x" : `${speed}x`;
      return `<button class="speed-button${active}" type="button" data-speed="${speed}">${label}</button>`;
    })
    .join("");
}

function voiceGender(voice) {
  const name = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  if (/male|男|kangkang|yunxi|yunjian|zh-cn-xiaoyi/.test(name)) return "male";
  if (/female|女|xiaoxiao|xiaoyi|yaoyao|huihui|hanhan|tingting|meijia/.test(name)) return "female";
  return "unknown";
}

function voiceScore(voice, wantedGender = "unknown") {
  const name = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  let score = 0;
  if (/zh|chinese|中文|普通话|mandarin/.test(`${voice.lang} ${name}`.toLowerCase())) score += 8;
  if (/natural|neural|premium|microsoft|google|siri|xiaoxiao|yunxi|yunjian/.test(name)) score += 6;
  if (voice.localService) score += 1;
  const gender = voiceGender(voice);
  if (wantedGender !== "unknown" && gender === wantedGender) score += 5;
  if (gender === "unknown") score -= 1;
  return score;
}

function chooseVoice() {
  if (!state.voices.length) return null;

  const explicitlySelected = state.voices.find((voice) => voice.voiceURI === state.selectedVoiceURI);
  if (explicitlySelected && state.voiceMode !== "auto") return explicitlySelected;

  const wantedGender = state.voiceMode === "auto"
    ? (state.currentIndex % 2 === 0 ? "female" : "male")
    : state.voiceMode;

  const ranked = [...state.voices]
    .filter((voice) => /zh|chinese|中文|mandarin/i.test(`${voice.lang} ${voice.name}`))
    .sort((a, b) => voiceScore(b, wantedGender) - voiceScore(a, wantedGender));

  return ranked[0] || state.voices.sort((a, b) => voiceScore(b, wantedGender) - voiceScore(a, wantedGender))[0] || null;
}

function renderVoiceModes() {
  els.voiceModeRow.innerHTML = voiceModes
    .map((mode) => {
      const active = state.voiceMode === mode.id ? " is-active" : "";
      return `<button class="voice-button${active}" type="button" data-voice-mode="${mode.id}">${mode.label}</button>`;
    })
    .join("");
}

function renderVoiceSelect() {
  const voices = state.voices
    .filter((voice) => /zh|chinese|中文|mandarin/i.test(`${voice.lang} ${voice.name}`))
    .sort((a, b) => voiceScore(b, "female") - voiceScore(a, "female"));

  const options = [
    `<option value="">自动挑选更自然的人声</option>`,
    ...voices.map((voice) => {
      const gender = voiceGender(voice);
      const tag = gender === "male" ? "男声" : gender === "female" ? "女声" : "未知";
      const selected = voice.voiceURI === state.selectedVoiceURI ? " selected" : "";
      return `<option value="${escapeHtml(voice.voiceURI)}"${selected}>${escapeHtml(voice.name)} · ${tag} · ${escapeHtml(voice.lang)}</option>`;
    }),
  ];
  els.voiceSelect.innerHTML = options.join("");

  const maleCount = voices.filter((voice) => voiceGender(voice) === "male").length;
  const femaleCount = voices.filter((voice) => voiceGender(voice) === "female").length;
  els.voiceStatus.textContent = voices.length
    ? `已发现 ${voices.length} 个中文相关声音，女声 ${femaleCount} 个，男声 ${maleCount} 个。自然度取决于手机或浏览器内置语音包。`
    : "没有发现中文语音包，浏览器会使用默认声音。";
}

function loadVoices() {
  if (!("speechSynthesis" in window)) {
    els.voiceStatus.textContent = "当前浏览器不支持语音合成。";
    return;
  }
  state.voices = window.speechSynthesis.getVoices();
  renderVoiceModes();
  renderVoiceSelect();
}

function renderEpisodes() {
  const episodes = state.payload?.episodes || [];
  els.episodeList.innerHTML = episodes
    .map(
      (episode) => `
        <button class="episode-card" type="button" data-episode="${episode.id}">
          <strong>${escapeHtml(episode.title)}</strong>
          <span>${escapeHtml(episode.subtitle)}<br>${episode.count} 条 · 约 ${formatTime(episode.durationHint)}</span>
        </button>
      `
    )
    .join("");

  els.pickerList.innerHTML = episodes
    .map(
      (episode) => `
        <button class="picker-item" type="button" data-episode="${episode.id}">
          <strong>${escapeHtml(episode.title)}</strong>
          <span>${escapeHtml(episode.category)} · ${episode.count} 条新闻</span>
        </button>
      `
    )
    .join("");
}

function renderSections() {
  const sections = state.payload?.sections || {};
  const entries = Object.entries(sections);

  if (!entries.length) {
    els.sections.innerHTML = `<p class="empty">还没有新闻。点击右上角刷新试试。</p>`;
    return;
  }

  els.sections.innerHTML = entries
    .map(
      ([name, items]) => `
        <section class="section-block">
          <div class="section-heading">
            <h2>${escapeHtml(name)}</h2>
            <span>${items.length} 条</span>
          </div>
          <div class="news-list">
            ${items
              .slice(0, 5)
              .map(
                (item) => `
                  <a class="news-card" href="${safeUrl(item.link)}" target="_blank" rel="noreferrer">
                    <strong>${escapeHtml(item.displayTitle || item.title)}</strong>
                    <span>${escapeHtml(item.displayDescription || item.description || "暂无摘要")}</span>
                    <footer>
                      <span>${escapeHtml(item.source)}</span>
                      <span>${formatDate(item.publishedAt)}</span>
                    </footer>
                  </a>
                `
              )
              .join("")}
          </div>
        </section>
      `
    )
    .join("");
}

function renderHero() {
  const first = state.payload?.episodes?.[0];
  els.heroTitle.textContent = first ? first.title : "正在加载新闻";
  els.heroMeta.textContent = first
    ? `${state.payload.statusText} · ${formatDate(state.payload.updatedAt)}`
    : "连接服务器中...";
  els.updateStatus.textContent = state.payload?.statusText || "等待更新";
}

function renderAll() {
  renderHero();
  renderEpisodes();
  renderSections();
  renderSpeeds();
  renderVoiceModes();
  renderVoiceSelect();
}

async function loadNews(force = false) {
  els.updateStatus.textContent = "更新中...";
  const endpoints = force
    ? ["/api/refresh", `/data/news.json?t=${Date.now()}`]
    : [`/data/news.json?t=${Date.now()}`, "/api/news"];
  let lastError;

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`${endpoint} ${res.status}`);
      state.payload = await res.json();
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!state.payload) throw lastError || new Error("新闻数据加载失败");
  renderAll();
  const episodeFromHash = decodeURIComponent(window.location.hash.replace(/^#episode=/, ""));
  if (episodeFromHash && window.location.hash.startsWith("#episode=") && !state.currentEpisode) {
    pickEpisode(episodeFromHash, false);
  }
}

function openSheet() {
  els.playerSheet.classList.add("is-open");
  els.playerSheet.setAttribute("aria-hidden", "false");
}

function closeSheet() {
  pauseSpeech();
  els.playerSheet.classList.remove("is-open");
  els.playerSheet.setAttribute("aria-hidden", "true");
}

function openPicker() {
  els.episodePicker.classList.add("is-open");
  els.episodePicker.setAttribute("aria-hidden", "false");
}

function closePicker() {
  els.episodePicker.classList.remove("is-open");
  els.episodePicker.setAttribute("aria-hidden", "true");
}

function pickEpisode(id, autoplay = true) {
  const episode = state.payload?.episodes.find((item) => item.id === id);
  if (!episode) return;

  pauseSpeech();
  state.currentEpisode = episode;
  state.currentSegments = splitScript(episode.script);
  state.currentIndex = 0;
  state.elapsedBeforeSegment = 0;
  state.startedAt = 0;

  els.playerCategory.textContent = episode.category;
  els.playerTitle.textContent = episode.title;
  els.playerSubtitle.textContent = episode.subtitle;
  renderTranscript();
  els.durationTime.textContent = formatTime(getEpisodeDuration());
  els.currentTime.textContent = "00:00";
  els.progressSlider.value = "0";
  updateFavoriteButton();
  openSheet();
  closePicker();

  if (autoplay) playSpeech();
}

function updateProgress() {
  if (!state.currentEpisode) return;
  const duration = getEpisodeDuration();
  const elapsed = getElapsed();
  els.currentTime.textContent = formatTime(elapsed);
  els.durationTime.textContent = formatTime(duration);
  els.progressSlider.value = duration ? String(Math.round((elapsed / duration) * 100)) : "0";
  if (state.isPlaying) requestAnimationFrame(updateProgress);
}

function pauseSpeech() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  state.isPlaying = false;
  els.playIcon.textContent = "▶";
}

function speakCurrentSegment() {
  if (!state.currentSegments[state.currentIndex]) {
    pauseSpeech();
    state.currentIndex = 0;
    state.elapsedBeforeSegment = 0;
    return;
  }

  updateTranscriptActive();
  const text = state.currentSegments[state.currentIndex];
  const utterance = new SpeechSynthesisUtterance(prepareSpeechText(text));
  const voice = chooseVoice();
  utterance.lang = "zh-CN";
  utterance.rate = state.speed === 1 ? 0.95 : state.speed;
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang || "zh-CN";
  }
  const gender = voice ? voiceGender(voice) : "unknown";
  utterance.pitch = gender === "male" ? 0.96 : gender === "female" ? 1.02 : 1;
  utterance.volume = 1;

  utterance.onend = () => {
    if (!state.isPlaying) return;
    state.elapsedBeforeSegment += estimateDuration(text);
    state.currentIndex += 1;
    state.startedAt = Date.now();
    speakCurrentSegment();
  };

  utterance.onerror = () => {
    pauseSpeech();
  };

  state.startedAt = Date.now();
  window.speechSynthesis.speak(utterance);
}

function playSpeech() {
  if (!state.currentEpisode || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  state.isPlaying = true;
  els.playIcon.textContent = "Ⅱ";
  speakCurrentSegment();
  requestAnimationFrame(updateProgress);
}

function jumpBy(seconds) {
  if (!state.currentEpisode) return;
  const target = Math.max(0, Math.min(getEpisodeDuration(), getElapsed() + seconds));
  let cursor = 0;
  let nextIndex = 0;

  for (let index = 0; index < state.currentSegments.length; index += 1) {
    const duration = estimateDuration(state.currentSegments[index]);
    if (cursor + duration >= target) {
      nextIndex = index;
      break;
    }
    cursor += duration;
    nextIndex = index;
  }

  const wasPlaying = state.isPlaying;
  pauseSpeech();
  state.currentIndex = nextIndex;
  state.elapsedBeforeSegment = cursor;
  updateTranscriptActive();
  updateProgress();
  if (wasPlaying) playSpeech();
}

function seekToSegment(index, autoplay = state.isPlaying) {
  if (!state.currentEpisode) return;
  const targetIndex = Math.max(0, Math.min(state.currentSegments.length - 1, index));
  const wasPlaying = autoplay;
  pauseSpeech();
  state.currentIndex = targetIndex;
  state.elapsedBeforeSegment = state.currentSegments
    .slice(0, targetIndex)
    .reduce((total, segment) => total + estimateDuration(segment), 0);
  updateTranscriptActive();
  updateProgress();
  if (wasPlaying) playSpeech();
}

function seekPercent(percent) {
  const duration = getEpisodeDuration();
  const target = duration * (percent / 100);
  jumpBy(target - getElapsed());
}

async function shareCurrentEpisode() {
  if (!state.currentEpisode) return;
  const text = `${state.currentEpisode.title}：${state.currentEpisode.subtitle}`;
  const url = getShareUrl();
  if (navigator.share) {
    await navigator.share({ title: state.currentEpisode.title, text, url });
    return;
  }
  await navigator.clipboard.writeText(`${text}\n${url}`);
  els.shareButton.querySelector("span").textContent = "✓";
  setTimeout(() => {
    els.shareButton.querySelector("span").textContent = "↗";
  }, 1200);
}

function getShareUrl() {
  const url = new URL(window.location.href);
  url.hash = state.currentEpisode ? `episode=${encodeURIComponent(state.currentEpisode.id)}` : "";
  return url.href;
}

function openSharePanel() {
  if (!state.currentEpisode) return;
  els.shareStatus.textContent = "";
  els.shareSheet.classList.add("is-open");
  els.shareSheet.setAttribute("aria-hidden", "false");
}

function closeSharePanel() {
  els.shareSheet.classList.remove("is-open");
  els.shareSheet.setAttribute("aria-hidden", "true");
}

async function copyShareText(targetName = "链接") {
  const text = `${state.currentEpisode.title}\n${getShareUrl()}`;
  await navigator.clipboard.writeText(text);
  els.shareStatus.textContent = `${targetName}已复制`;
}

async function shareToTarget(target) {
  if (!state.currentEpisode) return;
  const title = state.currentEpisode.title;
  const summary = state.currentEpisode.subtitle;
  const url = getShareUrl();

  if (target === "copy") {
    await copyShareText("链接");
    return;
  }

  if (target === "qq") {
    const qqUrl = new URL("https://connect.qq.com/widget/shareqq/index.html");
    qqUrl.searchParams.set("url", url);
    qqUrl.searchParams.set("title", title);
    qqUrl.searchParams.set("summary", summary);
    window.open(qqUrl.href, "_blank", "noopener,noreferrer");
    els.shareStatus.textContent = "已打开 QQ 分享";
    return;
  }

  if (navigator.share) {
    await navigator.share({ title, text: summary, url });
    closeSharePanel();
    return;
  }

  const names = {
    native: "分享内容",
    wechat: "微信分享内容",
    douyin: "抖音分享内容",
    xiaohongshu: "小红书分享内容",
  };
  await copyShareText(names[target] || "分享内容");
}

els.refreshButton.addEventListener("click", () => loadNews(true));
els.playHeroButton.addEventListener("click", () => {
  const first = state.payload?.episodes?.[0];
  if (first) pickEpisode(first.id, true);
});
els.episodeList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-episode]");
  if (button) pickEpisode(button.dataset.episode, true);
});
els.pickerList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-episode]");
  if (button) pickEpisode(button.dataset.episode, true);
});
els.sheetScrim.addEventListener("click", closeSheet);
els.closePlayerButton.addEventListener("click", closeSheet);
els.openPickerButton.addEventListener("click", openPicker);
els.closePickerButton.addEventListener("click", closePicker);
els.mainPlayButton.addEventListener("click", () => (state.isPlaying ? pauseSpeech() : playSpeech()));
els.backButton.addEventListener("click", () => jumpBy(-10));
els.forwardButton.addEventListener("click", () => jumpBy(10));
els.progressSlider.addEventListener("input", (event) => seekPercent(Number(event.target.value)));
els.scriptText.addEventListener("click", (event) => {
  const line = event.target.closest("[data-line-index]");
  if (!line) return;
  seekToSegment(Number(line.dataset.lineIndex), true);
});
els.speedRow.addEventListener("click", (event) => {
  const button = event.target.closest("[data-speed]");
  if (!button) return;
  const wasPlaying = state.isPlaying;
  pauseSpeech();
  state.speed = Number(button.dataset.speed);
  localStorage.setItem("moyu:speed", String(state.speed));
  renderSpeeds();
  els.durationTime.textContent = formatTime(getEpisodeDuration());
  if (wasPlaying) playSpeech();
});
els.voiceModeRow.addEventListener("click", (event) => {
  const button = event.target.closest("[data-voice-mode]");
  if (!button) return;
  const wasPlaying = state.isPlaying;
  pauseSpeech();
  state.voiceMode = button.dataset.voiceMode;
  localStorage.setItem("moyu:voiceMode", state.voiceMode);
  renderVoiceModes();
  if (wasPlaying) playSpeech();
});
els.voiceSelect.addEventListener("change", (event) => {
  const wasPlaying = state.isPlaying;
  pauseSpeech();
  state.selectedVoiceURI = event.target.value;
  localStorage.setItem("moyu:voiceURI", state.selectedVoiceURI);
  if (state.selectedVoiceURI) {
    state.voiceMode = voiceGender(state.voices.find((voice) => voice.voiceURI === state.selectedVoiceURI) || {}) || state.voiceMode;
    if (!["male", "female"].includes(state.voiceMode)) state.voiceMode = "auto";
    localStorage.setItem("moyu:voiceMode", state.voiceMode);
    renderVoiceModes();
  }
  if (wasPlaying) playSpeech();
});
els.favoriteButton.addEventListener("click", () => {
  if (!state.currentEpisode) return;
  if (state.favorites.has(state.currentEpisode.id)) {
    state.favorites.delete(state.currentEpisode.id);
  } else {
    state.favorites.add(state.currentEpisode.id);
  }
  persistFavorites();
  updateFavoriteButton();
});
els.shareButton.addEventListener("click", () => {
  openSharePanel();
});
els.shareScrim.addEventListener("click", closeSharePanel);
els.closeShareButton.addEventListener("click", closeSharePanel);
els.shareSheet.addEventListener("click", (event) => {
  const button = event.target.closest("[data-share-target]");
  if (!button) return;
  shareToTarget(button.dataset.shareTarget).catch(() => {
    els.shareStatus.textContent = "分享失败，已尝试复制链接";
    copyShareText().catch(() => {});
  });
});
els.playerPanel.addEventListener("touchstart", (event) => {
  state.touchStartY = event.touches[0].clientY;
});
els.playerPanel.addEventListener("touchmove", (event) => {
  const delta = event.touches[0].clientY - state.touchStartY;
  if (delta > 80 && els.playerPanel.scrollTop <= 0) closeSheet();
});

window.addEventListener("beforeunload", pauseSpeech);
if ("speechSynthesis" in window) {
  loadVoices();
  window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
} else {
  renderVoiceModes();
}

loadNews().catch((error) => {
  els.heroTitle.textContent = "加载失败";
  els.heroMeta.textContent = error.message;
  els.sections.innerHTML = `<p class="empty">服务器暂时没有响应，请确认服务正在运行。</p>`;
});
