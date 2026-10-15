// Radio Agent 前端逻辑
const API = ""; // 同源部署, 直接走相对路径

const state = {
  currentStation: null,
  activeTag: null,
  countries: [],
  languages: [],
  playingUuid: null,
  geoContext: null,   // 定位上下文 (供聊天意图结合位置/天气/时间)
};

const TYPING_HTML = '<span class="typing"><span></span><span></span><span></span></span>';

const $ = (sel) => document.querySelector(sel);

// ============================================================
// 主题系统（时间自动 + 手动自定义）
// ============================================================
const THEME_LABELS = {
  morning: "清晨", day: "上午", noon: "午后", evening: "傍晚", night: "深夜",
};
const SWATCHES = ["#8b5cf6", "#22d3ee", "#f472b6", "#34d399", "#f59e0b", "#f87171"];
const THEME_STORAGE_KEY = "radio_theme";

function periodOfHour(hour) {
  if (hour >= 5 && hour < 9) return "morning";
  if (hour >= 9 && hour < 12) return "day";
  if (hour >= 12 && hour < 18) return "noon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

function getThemeConfig() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { mode: "auto", color: null };
    return JSON.parse(raw);
  } catch (e) {
    return { mode: "auto", color: null };
  }
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function applyTheme() {
  const cfg = getThemeConfig();
  const hour = new Date().getHours();
  const key = periodOfHour(hour);
  const root = document.documentElement;
  root.setAttribute("data-theme", key);

  if (cfg.mode === "manual" && cfg.color) {
    root.style.setProperty("--accent", cfg.color);
    root.style.setProperty("--accent-soft", hexToRgba(cfg.color, 0.16));
    root.style.setProperty("--orb-a", hexToRgba(cfg.color, 0.5));
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-soft");
    root.style.removeProperty("--orb-a");
  }
  updateGlobeTheme();
}

function applyThemeToUI() {
  const cfg = getThemeConfig();
  $("#theme-auto").classList.toggle("active", cfg.mode !== "manual");
  $("#theme-manual").classList.toggle("active", cfg.mode === "manual");
  document.querySelectorAll(".swatch").forEach((s) => {
    s.classList.toggle("active", cfg.mode === "manual" && cfg.color === s.dataset.c);
  });
  const hour = new Date().getHours();
  const key = periodOfHour(hour);
  const tip = cfg.mode === "manual" && cfg.color
    ? "当前使用手动强调色（背景基调仍随 " + THEME_LABELS[key] + " 变化）"
    : "当前为自动模式，颜色随一天时间变化（此刻为「" + THEME_LABELS[key] + "」）";
  const el = $("#theme-status");
  if (el) el.textContent = "🎨 " + tip;
}

function bindThemeSettings() {
  $("#theme-auto").addEventListener("click", () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ mode: "auto", color: null }));
    applyTheme();
    applyThemeToUI();
  });
  $("#theme-manual").addEventListener("click", () => {
    const cfg = getThemeConfig();
    const color = cfg.color || SWATCHES[0];
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ mode: "manual", color }));
    applyTheme();
    applyThemeToUI();
  });
  document.querySelectorAll(".swatch").forEach((s) => {
    s.addEventListener("click", () => {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ mode: "manual", color: s.dataset.c }));
      applyTheme();
      applyThemeToUI();
    });
  });
}

// ============================================================
// 3D 地球 (MapLibre globe)
// ============================================================
let globeMap = null;
let countriesData = null;
let currentCountry = null; // { cc, name }
let hoveredCountry = null;
let stationFadeRaf = null; // 电台点渐入渐出动画句柄
let stationRequestId = 0;
let stationVisibility = 1;

// 背景图层在 globe 投影下不构成球面；用面图层给整颗球体铺海洋。
const oceanData = {
  type: "FeatureCollection",
  features: [-180, -90, 0, 90].map((west) => ({
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[[west, -90], [west + 90, -90], [west + 90, 90], [west, 90], [west, -90]]],
    },
    properties: {},
  })),
};

// 进入国家时显现，继续放大时点和文字一起放大、渐出。
function stationZoomOpacity(factor) {
  return ["interpolate", ["linear"], ["zoom"],
    2.4, 0, 3.4, factor, 5.8, factor, 8, 0];
}

function setStationVisibility(factor) {
  stationVisibility = factor;
  if (!globeMap || !globeMap.getLayer("stations-dot")) return;
  globeMap.setPaintProperty("stations-dot", "circle-opacity", stationZoomOpacity(0.92 * factor));
  globeMap.setPaintProperty("stations-dot", "circle-stroke-opacity", stationZoomOpacity(0.85 * factor));
  globeMap.setPaintProperty("stations-label", "text-opacity", stationZoomOpacity(factor));
}

function buildGlobeStyle() {
  return {
    version: 8,
    projection: { type: "globe" },
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      ocean: { type: "geojson", data: oceanData },
      countries: { type: "geojson", data: countriesData, promoteId: "iso2" },
      stations: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      { id: "ocean", type: "fill", source: "ocean",
        paint: { "fill-color": "#12356b", "fill-opacity": 1 } },
      {
        id: "countries-fill", type: "fill", source: "countries",
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            "#3d4670",
            "#141a32",
          ],
          "fill-opacity": 1,
        },
      },
      {
        id: "countries-line", type: "line", source: "countries",
        paint: { "line-color": "#3f4a74", "line-width": 0.7, "line-opacity": 0.9 },
      },
      // 电台点 (原生图层, 缩放/旋转时随地图平滑跟随)
      {
        id: "stations-dot", type: "circle", source: "stations",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2.4, 4, 4.6, 8, 18],
          "circle-color": "#8b5cf6",
          "circle-opacity": stationZoomOpacity(0.92),
          "circle-stroke-width": 1.4,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-opacity": stationZoomOpacity(0.85),
        },
      },
      // 电台名标签 (随 zoom 平滑放大, 低级别时为 0 即隐藏)
      {
        id: "stations-label", type: "symbol", source: "stations",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 4.2, 0, 5.4, 11, 7, 13],
          "text-anchor": "top",
          "text-offset": [0, 0.85],
          "text-allow-overlap": false,
          "text-optional": true,
        },
        paint: {
          "text-color": "#e9edff",
          "text-halo-color": "rgba(8,11,26,0.9)",
          "text-halo-width": 1.8,
          "text-opacity": stationZoomOpacity(1),
        },
      },
    ],
  };
}

function updateGlobeTheme() {
  if (!globeMap || !globeMap.getLayer("stations-dot")) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#8b5cf6";
  globeMap.setPaintProperty("stations-dot", "circle-color", accent);
}

async function initGlobe() {
  if (!window.maplibregl) {
    console.error("MapLibre GL 未加载");
    $("#globe-title").textContent = "地图组件加载失败";
    return;
  }
  try {
    const res = await fetch("/static/data/countries.geojson?v=4");
    countriesData = await res.json();
  } catch (e) {
    console.error("国家数据加载失败", e);
    return;
  }

  globeMap = new maplibregl.Map({
    container: "globe",
    style: buildGlobeStyle(),
    center: [18, 22],
    zoom: 1.35,
    minZoom: 1,
    maxZoom: 9,
    pitch: 0,
    attributionControl: false,
    dragRotate: true,
  });

  globeMap.touchZoomRotate.enable();

  // 点击国家
  globeMap.on("click", "countries-fill", (e) => {
    const f = e.features[0];
    if (!f) return;
    const cc = f.properties.iso2;
    const name = f.properties.NAME;
    const center = f.properties.center;
    selectCountry(cc, name, center);
  });

  // hover 高亮
  globeMap.on("mousemove", "countries-fill", (e) => {
    globeMap.getCanvas().style.cursor = "pointer";
    const id = e.features.length ? e.features[0].properties.iso2 : null;
    if (id !== hoveredCountry) {
      if (hoveredCountry) globeMap.setFeatureState({ source: "countries", id: hoveredCountry }, { hover: false });
      if (id) globeMap.setFeatureState({ source: "countries", id }, { hover: true });
      hoveredCountry = id;
    }
  });
  globeMap.on("mouseleave", "countries-fill", () => {
    globeMap.getCanvas().style.cursor = "";
    if (hoveredCountry) {
      globeMap.setFeatureState({ source: "countries", id: hoveredCountry }, { hover: false });
      hoveredCountry = null;
    }
  });

  // 点击电台点播放
  globeMap.on("click", "stations-dot", (e) => {
    const p = e.features[0].properties;
    playStation(p.uuid, p.name, p.url, p.favicon, p.meta);
  });
  globeMap.on("mousemove", "stations-dot", () => {
    globeMap.getCanvas().style.cursor = "pointer";
  });
  globeMap.on("mouseleave", "stations-dot", () => {
    globeMap.getCanvas().style.cursor = "";
  });

  // 缩放/平移结束后: 自动识别当前聚焦的国家并加载电台; 缩回全球时清空
  globeMap.on("moveend", () => {
    const zoom = globeMap.getZoom();
    if (zoom < 2) {
      if (currentCountry) {
        currentCountry = null;
        $("#globe-title").textContent = "🌍 点击国家，探索电台";
        $("#globe-legend-text").textContent = "国家";
        $("#sel-country").value = "";
        clearStations();
      }
      return;
    }
    if (zoom >= 3) {
      const c = countryAtCenter();
      if (c && (!currentCountry || c.cc !== currentCountry.cc)) {
        currentCountry = c;
        $("#globe-title").textContent = `📍 ${c.name}`;
        $("#sel-country").value = c.cc;
        loadCountryStations(c.cc);
      }
    }
  });
}

function selectCountry(cc, name, center) {
  currentCountry = { cc, name };
  $("#globe-title").textContent = `📍 ${name}`;
  $("#sel-country").value = cc;
  if (center) {
    globeMap.flyTo({ center, zoom: 4.6, duration: 1800 });
  }
  loadCountryStations(cc);
  recommend("", cc, "", `${name} 的热门电台`);
}

// ---------- 点在多边形内检测 (ray casting) ----------
// 判断点是否在单个环内
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// 判断点是否在几何体 (Polygon / MultiPolygon) 内
function pointInGeometry(lng, lat, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInRing(lng, lat, geom.coordinates[0]);
  if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      if (pointInRing(lng, lat, poly[0])) return true;
    }
  }
  return false;
}

// 取当前视口中心点落在的国家 (基于 GeoJSON 数据做点-多边形检测, 不依赖渲染命中)
function countryAtCenter() {
  const c = globeMap.getCenter();
  const lng = c.lng, lat = c.lat;
  for (const f of countriesData.features) {
    if (pointInGeometry(lng, lat, f.geometry)) {
      const p = f.properties;
      return { cc: p.iso2, name: p.NAME, center: p.center };
    }
  }
  return null;
}

// 清空电台点 (缩回全球时)
function clearStations() {
  stationRequestId++;
  cancelAnimationFrame(stationFadeRaf);
  setStationVisibility(1);
  const src = globeMap && globeMap.getSource("stations");
  if (src) src.setData({ type: "FeatureCollection", features: [] });
}

// 渐出旧点 -> 更新数据 -> 渐入新点
function setStationsData(features) {
  const src = globeMap.getSource("stations");
  if (!src) return;
  cancelAnimationFrame(stationFadeRaf);
  const DUR_OUT = 160, DUR_IN = 300;
  const startVisibility = stationVisibility;
  const t0 = performance.now();
  function out(now) {
    const t = Math.min(1, (now - t0) / DUR_OUT);
    setStationVisibility(startVisibility * (1 - t));
    if (t < 1) { stationFadeRaf = requestAnimationFrame(out); return; }
    src.setData({ type: "FeatureCollection", features });
    const t1 = performance.now();
    function inn(now2) {
      const t2 = Math.min(1, (now2 - t1) / DUR_IN);
      setStationVisibility(t2);
      if (t2 < 1) stationFadeRaf = requestAnimationFrame(inn);
    }
    stationFadeRaf = requestAnimationFrame(inn);
  }
  stationFadeRaf = requestAnimationFrame(out);
}

async function loadCountryStations(cc) {
  const requestId = ++stationRequestId;
  try {
    const res = await fetch(`${API}/api/stations/geo?countrycode=${cc}&limit=200`);
    const data = await res.json();
    if (requestId !== stationRequestId || currentCountry?.cc !== cc || globeMap.getZoom() < 2) return;
    const stations = data.stations || [];
    const features = stations.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.geo_long, s.geo_lat] },
      properties: {
        uuid: s.stationuuid,
        name: s.name,
        url: s.url_resolved || s.url,
        favicon: s.favicon || "",
        meta: [s.country, s.language, s.bitrate ? `${s.bitrate}kbps` : ""].filter(Boolean).join(" · "),
      },
    }));
    setStationsData(features);
    $("#globe-legend-text").textContent = stations.length ? `${stations.length} 个电台` : "该地区暂无电台";
  } catch (e) {
    console.error("加载国家电台失败", e);
  }
}

// ---------- 星空背景 ----------
function initStars() {
  const panel = document.querySelector(".globe-panel");
  if (!panel) return;
  let layer = panel.querySelector(".globe-stars");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "globe-stars";
    panel.insertBefore(layer, panel.firstChild);
  }
  const w = panel.clientWidth || 900;
  const h = panel.clientHeight || 600;
  const rand = (a, b) => a + Math.random() * (b - a);
  const small = [], bright = [];
  for (let i = 0; i < 150; i++) {
    small.push(`${Math.round(rand(0, w))}px ${Math.round(rand(0, h))}px rgba(255,255,255,${rand(0.2, 0.55).toFixed(2)})`);
  }
  for (let i = 0; i < 42; i++) {
    bright.push(`${Math.round(rand(0, w))}px ${Math.round(rand(0, h))}px rgba(210,222,255,${rand(0.6, 1).toFixed(2)})`);
  }
  layer.innerHTML = '<span class="stars-small"></span><span class="stars-bright"></span><span class="stars-glow"></span>';
  layer.querySelector(".stars-small").style.boxShadow = small.join(",");
  layer.querySelector(".stars-bright").style.boxShadow = bright.join(",");
}

// ============================================================
// 初始化
// ============================================================
async function init() {
  applyTheme();
  bindThemeSettings();
  initStars();
  await initGlobe();
  bindEvents();
  bindPlayer();
  bindResize();
  bindSettings();
  loadQuotes();
  await Promise.all([loadTags(), loadCountries(), loadLanguages()]);
  recommend("", "", "", "在地球上点一个国家，或输入你的需求");
}

// ---------- 数据加载 ----------
async function loadTags() {
  try {
    const res = await fetch(`${API}/api/meta/tags`);
    const tags = await res.json();
    const preferred = [
      "jazz", "rock", "classical", "electronic", "pop", "hip hop",
      "chillout", "ambient", "house", "dance", "lofi", "acoustic",
      "news", "metal", "blues", "latin",
    ];
    const hasTag = tags.filter((t) => preferred.includes(t.name.toLowerCase()));
    const picked = hasTag.length >= 8 ? hasTag : tags.slice(0, 12);
    const container = $("#quick-tags");
    container.innerHTML = picked
      .map((t) => `<span class="tag" data-tag="${esc(t.name)}">${esc(t.name)}</span>`)
      .join("");
  } catch (e) {
    console.error("loadTags failed", e);
  }
}

async function loadCountries() {
  try {
    const res = await fetch(`${API}/api/meta/countries`);
    const countries = await res.json();
    const china = countries.find((c) => c.iso_3166_1 === "CN");
    const taiwan = countries.find((c) => c.iso_3166_1 === "TW");
    if (china) {
      china.name = "中国";
      if (taiwan) china.stationcount = Number(china.stationcount || 0) + Number(taiwan.stationcount || 0);
    }
    const regions = countries.filter((c) => c.iso_3166_1 !== "TW");
    state.countries = regions;
    const sel = $("#sel-country");
    sel.innerHTML = '<option value="">🌍 全部国家</option>' + regions
      .slice(0, 80)
      .map((c) => `<option value="${esc(c.iso_3166_1)}">${esc(c.name)} (${c.stationcount})</option>`)
      .join("");
  } catch (e) {
    console.error("loadCountries failed", e);
  }
}

async function loadLanguages() {
  try {
    const res = await fetch(`${API}/api/meta/languages`);
    const languages = await res.json();
    state.languages = languages;
    const sel = $("#sel-language");
    sel.innerHTML = '<option value="">🗣 全部语言</option>' + languages
      .slice(0, 60)
      .map((l) => `<option value="${esc(l.name)}">${esc(l.name)} (${l.stationcount})</option>`)
      .join("");
  } catch (e) {
    console.error("loadLanguages failed", e);
  }
}

// ---------- 事件绑定 ----------
function bindEvents() {
  $("#send-btn").addEventListener("click", sendChat);
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendChat();
  });

  $("#quick-tags").addEventListener("click", (e) => {
    const tag = e.target.closest(".tag");
    if (!tag) return;
    const tagName = tag.dataset.tag;
    toggleTag(tagName, tag);
    applyFilters();
  });

  $("#sel-country").addEventListener("change", () => {
    if (currentCountry && $("#sel-country").value !== currentCountry.cc) currentCountry = null;
    applyFilters();
  });
  $("#sel-language").addEventListener("change", applyFilters);

  $("#search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchByName(e.target.value.trim());
  });

  $("#station-list").addEventListener("click", (e) => {
    const card = e.target.closest(".station-card");
    if (!card) return;
    const { uuid, name, url, favicon, meta } = card.dataset;
    playStation(uuid, name, url, favicon, meta);
  });

  $("#chat-messages").addEventListener("click", (e) => {
    if (e.target.classList.contains("hint")) {
      $("#chat-input").value = e.target.textContent;
      sendChat();
    }
  });

  $("#locate-btn").addEventListener("click", personalizeByLocation);
  $("#quote-list").addEventListener("click", onQuoteClick);
}

// ---------- 交互 ----------
function toggleTag(tagName, el) {
  if (state.activeTag === tagName) {
    state.activeTag = null;
    el.classList.remove("active");
  } else {
    document.querySelectorAll("#quick-tags .tag").forEach((t) => t.classList.remove("active"));
    state.activeTag = tagName;
    el.classList.add("active");
  }
}

async function sendChat() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  addMessage("user", text);
  const typingEl = addMessage("bot", TYPING_HTML);

  try {
    const intentRes = await fetch(`${API}/api/intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, context: state.geoContext || null, llm: getLLMConfig() }),
    });
    const intent = await intentRes.json();

    syncIntentToUI(intent);
    updateBotMessage(typingEl, buildIntentReply(intent));

    await recommend(intent.tags?.join(",") || "", intent.country || "", intent.language || "", "");
  } catch (e) {
    updateBotMessage(typingEl, "抱歉，理解需求时出错了，请重试。");
    console.error(e);
  }
}

function syncIntentToUI(intent) {
  document.querySelectorAll("#quick-tags .tag").forEach((t) => t.classList.remove("active"));
  state.activeTag = null;
  if (intent.tags && intent.tags.length) {
    const first = intent.tags[0];
    const el = [...document.querySelectorAll("#quick-tags .tag")].find((t) => t.dataset.tag === first);
    if (el) { el.classList.add("active"); state.activeTag = first; }
  }
  if (intent.country) { $("#sel-country").value = intent.country; currentCountry = null; }
  if (intent.language) $("#sel-language").value = intent.language;
}

function buildIntentReply(intent) {
  const parts = [];
  if (intent.tags && intent.tags.length) parts.push(`风格：${intent.tags.join(" / ")}`);
  if (intent.country) {
    const c = state.countries.find((x) => x.iso_3166_1 === intent.country);
    parts.push(`地区：${c ? c.name : intent.country}`);
  }
  if (intent.language) parts.push(`语言：${intent.language}`);
  if (intent.name) parts.push(`搜索：${intent.name}`);
  if (intent.mood) parts.push(`场景：${intent.mood}`);
  return parts.length ? `我理解为 → ${parts.join("，")}。为你找到这些电台：` : "我理解为 → 热门电台。";
}

async function applyFilters() {
  const tag = state.activeTag || "";
  const country = $("#sel-country").value;
  const language = $("#sel-language").value;
  await recommend(tag, country, language, "");
}

async function recommend(tags, country, language, hint) {
  const params = new URLSearchParams();
  if (tags) params.set("tags", tags);
  if (country) params.set("countrycode", country);
  if (language) params.set("language", language);
  params.set("limit", "20");

  showSkeleton();
  try {
    const res = await fetch(`${API}/api/recommend?${params.toString()}`);
    const data = await res.json();
    renderStations(data.stations, hint || `为你推荐 ${data.count} 个电台`);
  } catch (e) {
    console.error(e);
    renderStations([], "加载失败，请重试");
    toast("加载失败，请检查网络后重试", true);
  }
}

async function searchByName(name) {
  if (!name) return;
  const params = new URLSearchParams({ name, limit: "20", order: "clickcount" });
  showSkeleton();
  try {
    const res = await fetch(`${API}/api/stations/search?${params.toString()}`);
    const data = await res.json();
    renderStations(data.stations, `“${name}” 的搜索结果（${data.count} 个）`);
  } catch (e) {
    console.error(e);
    renderStations([], "搜索失败，请重试");
  }
}

// ---------- 渲染 ----------
function showSkeleton() {
  const list = $("#station-list");
  $("#result-hint").textContent = "";
  const items = Array.from({ length: 6 }, () => `
    <div class="skeleton-card">
      <div class="sk sk-cover"></div>
      <div class="sk-body">
        <div class="sk sk-line"></div>
        <div class="sk sk-line short"></div>
      </div>
    </div>`).join("");
  list.innerHTML = items;
}

function renderStations(stations, hint) {
  const list = $("#station-list");
  $("#result-hint").textContent = hint || "";
  if (!stations || !stations.length) {
    list.innerHTML = `
      <div class="empty">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">没有找到匹配的电台</div>
        <div class="empty-sub">换个关键词，或放宽筛选条件试试</div>
      </div>`;
    triggerListFade(list);
    return;
  }
  list.innerHTML = stations.map((s, i) => {
    const tags = (s.tags || "").split(",").filter(Boolean).slice(0, 3);
    const meta = [s.country, s.language, s.bitrate ? `${s.bitrate}kbps` : "", s.codec || ""]
      .filter(Boolean).join(" · ");
    const playing = s.stationuuid === state.playingUuid ? "playing" : "";
    return `
      <div class="station-card ${playing}" style="animation-delay:${Math.min(i * 0.04, 0.5)}s"
           data-uuid="${esc(s.stationuuid)}"
           data-name="${esc(s.name)}" data-url="${esc(s.url_resolved || s.url)}"
           data-favicon="${esc(s.favicon || "")}" data-meta="${esc(meta)}">
        <div class="station-favicon">${s.favicon ? `<img src="${esc(s.favicon)}" onerror="this.remove()" />` : "♪"}</div>
        <div class="station-body">
          <div class="station-name">${esc(s.name)}</div>
          <div class="station-sub"><span>${esc(meta)}</span>${s.votes ? `<span class="vote">👍 ${s.votes}</span>` : ""}</div>
          ${tags.length ? `<div class="station-tags">${tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
        </div>
        <button class="station-play">
          <svg class="ic-play-mini" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          <span class="eq-mini"><span></span><span></span><span></span></span>
        </button>
      </div>`;
  }).join("");
  triggerListFade(list);
}

function playStation(uuid, name, url, favicon, meta) {
  const audio = $("#audio");
  state.playingUuid = uuid;
  state.currentStation = { uuid, name, url, favicon, meta };

  $("#player-name").textContent = name;
  $("#player-meta").textContent = meta;
  const cover = $("#player-cover");
  if (favicon) {
    cover.innerHTML = `<img src="${esc(favicon)}" onerror="this.replaceWith(document.createTextNode('♪'))" />`;
  } else {
    cover.textContent = "♪";
  }
  audio.src = url;
  audio.play().catch(() => toast("自动播放被浏览器拦截，请点击播放按钮", true));

  document.querySelectorAll(".station-card").forEach((c) => c.classList.remove("playing"));
  const card = document.querySelector(`.station-card[data-uuid="${uuid}"]`);
  if (card) card.classList.add("playing");

  fetch(`${API}/api/click`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stationuuid: uuid }),
  }).catch(() => {});
}

// ---------- 播放器控制 ----------
function bindPlayer() {
  const audio = $("#audio");
  const playBtn = $("#play-pause-btn");
  const player = $("#player");
  const seekBar = $("#seek-bar");
  const progress = $("#seek-progress");
  const thumb = $("#seek-thumb");
  const curTime = $("#cur-time");
  const durTime = $("#dur-time");
  const volume = $("#volume");
  const volIcon = $("#vol-icon");

  playBtn.addEventListener("click", () => {
    if (!state.currentStation) return;
    if (audio.paused) audio.play().catch(() => toast("播放失败，该电台源可能不可用", true));
    else audio.pause();
  });

  audio.addEventListener("play", () => {
    playBtn.classList.add("playing");
    player.classList.add("playing");
  });
  audio.addEventListener("pause", () => {
    playBtn.classList.remove("playing");
    player.classList.remove("playing");
  });
  audio.addEventListener("loadedmetadata", () => {
    playBtn.disabled = false;
    durTime.textContent = isFinite(audio.duration) ? fmtTime(audio.duration) : "--:--";
  });
  audio.addEventListener("timeupdate", () => {
    if (audio.duration && isFinite(audio.duration)) {
      const pct = (audio.currentTime / audio.duration) * 100;
      progress.style.width = pct + "%";
      thumb.style.left = pct + "%";
      curTime.textContent = fmtTime(audio.currentTime);
    }
  });
  audio.addEventListener("progress", () => {
    if (audio.buffered.length && audio.duration) {
      const buf = audio.buffered.end(audio.buffered.length - 1);
      $("#seek-buffer").style.width = (buf / audio.duration) * 100 + "%";
    }
  });
  audio.addEventListener("error", () => {
    playBtn.disabled = false;
    toast("无法播放该电台，请换一个试试", true);
  });

  let dragging = false;
  function seekTo(e) {
    const rect = seekBar.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (audio.duration && isFinite(audio.duration)) {
      audio.currentTime = pct * audio.duration;
    }
  }
  seekBar.addEventListener("pointerdown", (e) => {
    dragging = true;
    seekBar.setPointerCapture(e.pointerId);
    seekTo(e);
  });
  seekBar.addEventListener("pointermove", (e) => { if (dragging) seekTo(e); });
  seekBar.addEventListener("pointerup", () => { dragging = false; });

  volume.addEventListener("input", () => {
    audio.volume = parseFloat(volume.value);
    volIcon.textContent = volume.value == 0 ? "🔇" : volume.value < 0.5 ? "🔉" : "🔊";
  });
  volIcon.addEventListener("click", () => {
    if (audio.volume > 0) { audio.volume = 0; volume.value = 0; volIcon.textContent = "🔇"; }
    else { audio.volume = 1; volume.value = 1; volIcon.textContent = "🔊"; }
  });
  audio.volume = parseFloat(volume.value);
}

function fmtTime(sec) {
  if (!isFinite(sec)) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- 聊天消息 ----------
function addMessage(role, html) {
  const msgs = $("#chat-messages");
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const avatar = role === "bot" ? '<div class="avatar">🎧</div>' : "";
  div.innerHTML = `${avatar}<div class="bubble">${html}</div>`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function updateBotMessage(el, html) {
  el.querySelector(".bubble").innerHTML = html;
  const msgs = $("#chat-messages");
  msgs.scrollTop = msgs.scrollHeight;
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 2800);
}

// ---------- 句子推送 ----------
async function loadQuotes() {
  const list = $("#quote-list");
  list.innerHTML = '<div class="quote-loading"><span class="sk shimmer-text">✨ 正在为你写句子…</span></div>';
  try {
    const hour = new Date().getHours();
    const res = await fetch(`${API}/api/quotes?hour=${hour}`);
    const data = await res.json();
    $("#quote-period").textContent = data.label || "";
    const tip = document.querySelector("#quote-strip .quote-tip");
    if (tip) tip.textContent = data.source === "llm" ? "AI 为你写了此刻的句子" : "选一句，听听此刻的心情";
    list.innerHTML = (data.quotes || []).map((q) => `
      <div class="quote-card" data-tags="${esc((q.tags || []).join(","))}" data-text="${esc(q.text)}" data-mood="${esc(q.mood)}">
        <div class="quote-text">${esc(q.text)}</div>
        <div class="quote-mood">♪ ${esc(q.mood)}</div>
      </div>`).join("");
  } catch (e) {
    console.error("loadQuotes failed", e);
    const strip = $("#quote-strip");
    if (strip) strip.style.display = "none";
  }
}

async function onQuoteClick(e) {
  const card = e.target.closest(".quote-card");
  if (!card) return;
  const { tags, text, mood } = card.dataset;

  addMessage("user", `「${text}」`);
  const typing = addMessage("bot", TYPING_HTML);
  try {
    await recommend(tags, "", "", "");
    updateBotMessage(typing, `这句「${mood}」的感觉，为你找到这些电台：`);
  } catch (e) {
    updateBotMessage(typing, "加载失败了，请稍后再试。");
  }
}

// ---------- 此刻推荐 (定位 + 天气 + 时间) ----------
async function personalizeByLocation() {
  const btn = $("#locate-btn");
  if (!navigator.geolocation) {
    toast("当前浏览器不支持定位", true);
    return;
  }
  btn.classList.add("loading");
  const label = btn.querySelector("span");
  if (label) label.textContent = "定位中…";

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const hour = new Date().getHours();
      addMessage("user", "此刻，为我推荐合适的音乐 🎧");
      const typing = addMessage("bot", TYPING_HTML);
      try {
        const res = await fetch(`${API}/api/personalize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ latitude, longitude, hour, llm: getLLMConfig() }),
        });
        const data = await res.json();
        state.geoContext = { latitude, longitude, hour, ...(data.context || {}) };

        const ctx = data.context || {};
        const parts = [];
        const loc = ctx.location || {};
        if (loc.city || loc.country) parts.push(`📍 ${[loc.city, loc.country].filter(Boolean).join(" · ")}`);
        const w = ctx.weather || {};
        if (w.description) parts.push(`🌤 ${w.description} ${w.temperature ?? ""}°C`);
        parts.push(`🕐 ${periodLabel(ctx.hour ?? hour)}`);
        const ctxHtml = parts.length ? `<div class="ctx-row">${parts.join("")}</div>` : "";

        updateBotMessage(typing, (data.explanation || "根据此刻的天气与时间，为你推荐这些电台：") + ctxHtml);
        renderStations(data.stations, `此刻推荐 · ${data.count || 0} 个电台`);
      } catch (err) {
        console.error(err);
        updateBotMessage(typing, "获取推荐时出错了，请重试。");
      } finally {
        btn.classList.remove("loading");
        if (label) label.textContent = "此刻推荐";
      }
    },
    (err) => {
      btn.classList.remove("loading");
      if (label) label.textContent = "此刻推荐";
      const msg = err.code === 1 ? "定位权限被拒绝，请在浏览器设置中允许定位" : "定位失败，请检查网络后重试";
      toast(msg, true);
    },
    { timeout: 10000, enableHighAccuracy: false }
  );
}

function periodLabel(hour) {
  if (hour == null) return "";
  if (hour >= 5 && hour < 9) return "清晨";
  if (hour >= 9 && hour < 12) return "上午";
  if (hour >= 12 && hour < 18) return "午后";
  if (hour >= 18 && hour < 22) return "傍晚";
  return "深夜";
}

// ---------- AI 模型设置 (BYOK) ----------
const LLM_STORAGE_KEY = "radio_llm_cfg";

function getLLMConfig() {
  try {
    const raw = localStorage.getItem(LLM_STORAGE_KEY);
    if (!raw) return {};
    const cfg = JSON.parse(raw);
    const out = {};
    if (cfg.api_key) out.api_key = cfg.api_key;
    if (cfg.base_url) out.base_url = cfg.base_url;
    if (cfg.model) out.model = cfg.model;
    return out;
  } catch (e) {
    return {};
  }
}

function bindSettings() {
  const modal = $("#settings-modal");
  $("#settings-btn").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

  $("#settings-save").addEventListener("click", () => {
    const key = $("#set-key").value.trim();
    const base = $("#set-base").value.trim();
    const model = $("#set-model").value.trim();
    if (!key) {
      setSettingsStatus("请填写 API Key；如不想使用 AI 功能，可点「清除配置」", true);
      return;
    }
    const cfg = {};
    cfg.api_key = key;
    if (base) cfg.base_url = base;
    if (model) cfg.model = model;
    localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(cfg));
    setSettingsStatus("✓ 已保存，AI 请求将走你自己的 Key", false);
    toast("AI 配置已保存");
    setTimeout(() => (modal.hidden = true), 500);
  });

  $("#settings-clear").addEventListener("click", () => {
    localStorage.removeItem(LLM_STORAGE_KEY);
    ["#set-key", "#set-base", "#set-model"].forEach((s) => ($(s).value = ""));
    refreshLLMStatus();
    toast("已清除本地 AI 配置");
  });
}

function setSettingsStatus(msg, isErr) {
  const el = $("#set-status");
  el.textContent = msg;
  el.className = "modal-status" + (isErr ? " err" : "");
}

async function openSettings() {
  const cfg = getLLMConfig();
  $("#set-key").value = cfg.api_key || "";
  $("#set-base").value = cfg.base_url || "";
  $("#set-model").value = cfg.model || "";
  applyThemeToUI();
  $("#settings-modal").hidden = false;
  await refreshLLMStatus();
}

async function refreshLLMStatus() {
  try {
    const res = await fetch(`${API}/api/llm/status`);
    const st = await res.json();
    const local = getLLMConfig();
    if (local.api_key) {
      setSettingsStatus("✓ 当前使用你自己的 Key，AI 请求走你的额度", false);
    } else if (st.server_key) {
      setSettingsStatus("当前未配置自己的 Key，将使用服务端共享 Key", false);
    } else {
      setSettingsStatus("未配置 Key：AI 智能推荐会降级为规则匹配，其余功能不受影响", false);
    }
  } catch (e) {
    setSettingsStatus("无法获取服务端状态", true);
  }
}

// ---------- 拖拽调整模块大小 ----------
const RESIZE_STORAGE_KEY = "radio_panel_sizes";
const RESIZE_TARGETS = [
  { handle: "#rs-chat", panel: ".chat-panel", min: 240, max: 760, default: 400 },
  { handle: "#rs-list", panel: ".list-panel", min: 320, max: 900, default: 540 },
];

function loadPanelSizes() {
  try {
    return JSON.parse(localStorage.getItem(RESIZE_STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function bindResize() {
  const saved = loadPanelSizes();
  const isDesktop = window.innerWidth > 900;

  RESIZE_TARGETS.forEach(({ handle, panel, min, max, default: def }) => {
    const h = $(handle);
    const p = $(panel);
    if (!h || !p) return;

    // 恢复上次保存的高度（仅桌面端）
    if (isDesktop && saved[panel] != null) {
      p.style.height = Math.min(max, Math.max(min, saved[panel])) + "px";
    }

    let dragging = false;
    let startY = 0;
    let startH = 0;

    h.addEventListener("pointerdown", (e) => {
      dragging = true;
      startY = e.clientY;
      startH = p.getBoundingClientRect().height;
      h.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ns-resize";
      h.setPointerCapture(e.pointerId);
    });

    h.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const next = Math.min(max, Math.max(min, startH + (e.clientY - startY)));
      p.style.height = next + "px";
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      h.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const sizes = loadPanelSizes();
      sizes[panel] = p.getBoundingClientRect().height;
      localStorage.setItem(RESIZE_STORAGE_KEY, JSON.stringify(sizes));
    };
    h.addEventListener("pointerup", endDrag);
    h.addEventListener("pointercancel", endDrag);
  });
}

// ---------- 工具 ----------
function esc(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}

function triggerListFade(list) {
  list.classList.remove("fade-in");
  void list.offsetWidth; // 强制 reflow, 重新触发动画
  list.classList.add("fade-in");
}

init();
