// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: chart-pie;

/*
 * Claude 사용량 위젯 (Scriptable용)
 *
 * - 홈 화면(작은·중간)과 잠금 화면(원형·직사각형·한 줄)에서 Claude 구독 사용량을 보여준다.
 * - claude.ai 사용량 화면이 내부적으로 쓰는 비공식 주소를 "조회(GET)"만 한다.
 * - 로그인 정보(쿠키, 조직 ID)는 키체인에만 저장한다. 이 파일에는 어떤 비밀 값도 들어 있지 않다.
 *
 * 주소나 응답 형식이 바뀌면 "API 설정"과 parseUsage() 부분만 고치면 된다.
 */

// ─── API 설정 (주소가 바뀌면 여기만 고친다) ────────────────────────────────

const BASE_URL = "https://claude.ai";
const USAGE_PAGE_URL = "https://claude.ai/settings/usage";
const ORGS_PATH = "/api/organizations";
const usagePath = (orgId) => `/api/organizations/${encodeURIComponent(orgId)}/usage`;
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// ─── 동작 설정 ──────────────────────────────────────────────────────────────

const REFRESH_MINUTES = 15; // 위젯은 이보다 자주 claude.ai를 부르지 않는다
const APP_MIN_REFETCH_SECONDS = 60; // 앱에서 직접 새로고침할 때의 최소 간격
const REQUEST_TIMEOUT_SECONDS = 15;
const WEB_CRASH_GRACE_MS = 60 * 1000;

const KEYCHAIN = {
  mode: "claude-usage-widget.mode", // "web"(앱 안 로그인) 또는 "cookie"(쿠키 붙여넣기)
  sessionKey: "claude-usage-widget.session-key",
  orgId: "claude-usage-widget.org-id",
};
const CACHE_DIR_NAME = "claude-usage-widget";
const CACHE_FILE_NAME = "cache.json";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const KST_OFFSET_MS = 9 * HOUR_MS; // 한국은 서머타임이 없어 항상 UTC+9
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// ─── 색상 ───────────────────────────────────────────────────────────────────

const COLORS = {
  background: Color.dynamic(new Color("#FFFFFF"), new Color("#1C1C1E")),
  text: Color.dynamic(new Color("#1C1C1E"), new Color("#FFFFFF")),
  subtext: Color.dynamic(new Color("#6E6E73"), new Color("#A1A1A6")),
  barTrack: Color.dynamic(new Color("#E5E5EA"), new Color("#3A3A3C")),
  warning: Color.dynamic(new Color("#C93400"), new Color("#FF9F0A")),
  // 게이지 이미지는 그릴 때 색이 고정되므로 라이트·다크 모두에서 보이는 색을 쓴다
  ringTrack: new Color("#8E8E93", 0.25),
  green: new Color("#34C759"),
  yellow: new Color("#F5B800"),
  red: new Color("#FF3B30"),
  gray: new Color("#8E8E93"),
  lockPrimary: Color.white(),
  lockSecondary: new Color("#FFFFFF", 0.75),
  lockTrack: new Color("#FFFFFF", 0.28),
};

function levelColor(pct) {
  if (pct >= 80) return COLORS.red;
  if (pct >= 50) return COLORS.yellow;
  return COLORS.green;
}

// ─── 오류 종류와 문구 ───────────────────────────────────────────────────────

class UsageError extends Error {
  constructor(kind, detail) {
    super(detail || kind);
    this.kind = kind;
  }
}

// title: 값이 없을 때 크게 보여줄 문구, hint: 할 일, status: 값이 있을 때 아래에 붙는 짧은 문구
const ERROR_TEXT = {
  not_configured: { title: "다시 로그인 필요", hint: "Scriptable에서 스크립트를 실행해 로그인하세요", short: "로그인", symbol: "person.crop.circle.badge.exclamationmark" },
  auth: { title: "다시 로그인 필요", hint: "Scriptable에서 스크립트를 실행해 다시 로그인하세요", short: "로그인", symbol: "person.crop.circle.badge.exclamationmark" },
  blocked: { title: "접속 차단됨", hint: "앱에서 실행해 '앱 안에서 로그인' 방식으로 바꿔보세요", short: "차단됨", symbol: "hand.raised" },
  format: { title: "데이터 형식 변경됨", hint: "Claude Code에 스크립트 수정을 요청하세요", short: "형식 변경", symbol: "wrench.and.screwdriver" },
  web_unavailable: { title: "위젯 갱신 불가", hint: "앱에서 실행해 '쿠키 붙여넣기' 방식으로 바꾸세요", short: "갱신 불가", symbol: "arrow.triangle.2.circlepath" },
  offline: { title: "연결 안 됨", hint: "인터넷이 연결되면 자동으로 다시 시도해요", short: "연결 안 됨", symbol: "wifi.slash" },
  rate: { title: "잠시 후 다시 시도", hint: "요청이 많아 다음 갱신 때 다시 시도해요", short: "대기", symbol: "hourglass" },
  server: { title: "claude.ai 응답 없음", hint: "다음 갱신 때 자동으로 다시 시도해요", short: "응답 없음", symbol: "icloud.slash" },
  unknown: { title: "일시적인 문제", hint: "다음 갱신 때 자동으로 다시 시도해요", short: "오류", symbol: "exclamationmark.circle" },
};
// 값은 그대로 믿어도 되는 일시적 문제(마지막 값 + "n분 전 기준"만 표시)
const SOFT_ERRORS = ["offline", "rate", "server", "unknown"];

// ─── 시작점 (실행은 파일 맨 끝의 await main()) ──────────────────────────────

async function main() {
  if (config.runsInWidget) {
    const family = config.widgetFamily || "small";
    const state = isDemoParameter(args.widgetParameter) ? demoState() : await loadState();
    Script.setWidget(buildWidget(family, state));
  } else if (config.runsInApp) {
    await runApp();
  }
  Script.complete();
}

function isDemoParameter(value) {
  const v = String(value || "").trim().toLowerCase();
  return ["demo", "미리보기", "가짜"].includes(v);
}

// ─── 응답 읽기 (응답 형식이 바뀌면 여기만 고친다) ───────────────────────────

const EXTRA_LABELS = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  oauth_apps: "연동 앱",
  extra_usage: "추가 사용량",
};

/**
 * usage 응답(JSON)을 화면에서 쓰는 모양으로 바꾼다.
 * 반환: { fiveHour: Limit, sevenDay: Limit, extras: [{ label, ...Limit }] }
 * Limit: { pct: 숫자 또는 null, resetsAt: 밀리초 시각 또는 null }
 */
function parseUsage(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new UsageError("format", "usage 응답이 객체가 아님");
  }
  if (!("five_hour" in json) && !("seven_day" in json)) {
    throw new UsageError("format", "five_hour / seven_day 키가 없음");
  }
  const extras = [];
  for (const key of Object.keys(json)) {
    if (key === "five_hour" || key === "seven_day") continue;
    const limit = readLimit(json[key]);
    if (!limit || limit.pct === null) continue; // 값이 비어 있으면 표시하지 않는다
    extras.push({ label: extraLabel(key), pct: limit.pct, resetsAt: limit.resetsAt });
  }
  return {
    fiveHour: readLimit(json.five_hour) || { pct: null, resetsAt: null },
    sevenDay: readLimit(json.seven_day) || { pct: null, resetsAt: null },
    extras,
  };
}

function readLimit(value) {
  if (!value || typeof value !== "object" || !("utilization" in value)) return null;
  const raw = value.utilization;
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  const resetsAt = value.resets_at ? Date.parse(value.resets_at) : NaN;
  return {
    pct: Number.isFinite(n) ? n : null,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

function extraLabel(key) {
  let prefix = "";
  let rest = key;
  if (key.startsWith("seven_day_")) {
    rest = key.slice("seven_day_".length);
  } else if (key.startsWith("five_hour_")) {
    prefix = "5시간 ";
    rest = key.slice("five_hour_".length);
  }
  const known = EXTRA_LABELS[rest] || EXTRA_LABELS[key];
  if (known) return prefix + known;
  return prefix + rest.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function pickOrganization(orgs) {
  if (!Array.isArray(orgs)) throw new UsageError("format", "organizations 응답이 배열이 아님");
  const valid = orgs.filter((o) => o && typeof o.uuid === "string" && o.uuid);
  if (valid.length === 0) throw new UsageError("format", "조직 정보가 없음");
  const chat = valid.filter((o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat"));
  return chat.length > 0 ? chat : valid;
}

// ─── 데이터 가져오기 ────────────────────────────────────────────────────────

/** get(path) → { status, body } 를 받아 사용량을 읽는다. 조회(GET)만 한다. */
async function fetchUsage(get, cachedOrgId, { interactive = false } = {}) {
  let orgId = cachedOrgId || (await fetchOrgId(get, interactive));
  let res = await get(usagePath(orgId));
  if (cachedOrgId && (res.status === 403 || res.status === 404) && !isBlocked(res)) {
    // 저장해 둔 조직 ID가 더 이상 맞지 않을 수 있어 한 번만 다시 찾는다
    orgId = await fetchOrgId(get, interactive);
    res = await get(usagePath(orgId));
  }
  ensureOk(res);
  return { data: parseUsage(parseJson(res)), orgId };
}

async function fetchOrgId(get, interactive) {
  const res = await get(ORGS_PATH);
  ensureOk(res);
  const candidates = pickOrganization(parseJson(res));
  if (interactive && candidates.length > 1) {
    const alert = new Alert();
    alert.title = "어떤 계정의 사용량을 볼까요?";
    for (const org of candidates) alert.addAction(org.name || org.uuid);
    const index = await alert.presentSheet();
    if (index >= 0) return candidates[index].uuid;
  }
  return candidates[0].uuid;
}

function ensureOk(res) {
  if (res.status >= 200 && res.status < 300) return;
  if (isBlocked(res)) throw new UsageError("blocked");
  if (res.status === 401 || res.status === 403) throw new UsageError("auth");
  if (res.status === 429) throw new UsageError("rate");
  if (!res.status) throw new UsageError("offline");
  throw new UsageError("server", `HTTP ${res.status}`);
}

function isBlocked(res) {
  const body = String(res.body || "").slice(0, 6000).toLowerCase();
  if (!body.includes("<html") && !body.includes("<!doctype")) return false;
  return ["just a moment", "cf-chl", "cf_chl", "challenge-platform", "attention required", "cloudflare"].some((m) => body.includes(m));
}

function parseJson(res) {
  try {
    return JSON.parse(res.body);
  } catch (e) {
    if (isBlocked(res)) throw new UsageError("blocked");
    throw new UsageError("format", "JSON이 아닌 응답");
  }
}

/** B안: 키체인의 sessionKey 쿠키로 직접 부른다. */
function cookieGetter(sessionKey) {
  return async (path) => {
    const req = new Request(BASE_URL + path);
    req.method = "GET";
    req.timeoutInterval = REQUEST_TIMEOUT_SECONDS;
    req.headers = {
      Cookie: `sessionKey=${sessionKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      Referer: USAGE_PAGE_URL,
    };
    let body;
    try {
      body = await req.loadString();
    } catch (e) {
      throw new UsageError("offline", e && e.message);
    }
    return { status: (req.response && req.response.statusCode) || 0, body };
  };
}

/** A안: 앱 안에서 로그인한 웹 화면(WebView) 안에서 부른다. */
async function webGetter() {
  const webView = new WebView();
  try {
    await withTimeout(webView.loadURL(BASE_URL + ORGS_PATH), REQUEST_TIMEOUT_SECONDS * 1000);
  } catch (e) {
    throw e instanceof UsageError ? e : new UsageError("offline", e && e.message);
  }
  const once = async (path) => {
    const js = `fetch(${JSON.stringify(path)}, { credentials: "include", headers: { accept: "application/json" } })
      .then(function (r) { return r.text().then(function (t) { completion(JSON.stringify({ status: r.status, body: t })); }); })
      .catch(function (e) { completion(JSON.stringify({ status: 0, body: String(e) })); });`;
    const out = await withTimeout(webView.evaluateJavaScript(js, true), REQUEST_TIMEOUT_SECONDS * 1000);
    return typeof out === "string" ? JSON.parse(out) : out;
  };
  return async (path) => {
    let res = await once(path);
    if (isBlocked(res)) {
      // 웹 화면은 접속 확인 페이지를 스스로 통과하는 경우가 있어 한 번 더 기다려 본다
      await sleep(5000);
      res = await once(path);
    }
    return res;
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = Timer.schedule(ms, false, () => reject(new UsageError("offline", "시간 초과")));
    promise.then(
      (value) => { timer.invalidate(); resolve(value); },
      (error) => { timer.invalidate(); reject(error); }
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => Timer.schedule(ms, false, resolve));
}

// ─── 상태 읽기: 저장된 값 + 필요할 때만 새로 받아오기 ───────────────────────

/**
 * 반환: { data, fetchedAt, error }
 * - 마지막 시도가 15분 이내면 claude.ai를 부르지 않고 저장된 값을 쓴다
 *   (위젯을 여러 개 놓아도 한 번만 부르게 된다).
 * - force: 앱에서 사용자가 직접 새로고침할 때(1분 간격 제한만 둔다)
 */
async function loadState({ force = false, interactive = false } = {}) {
  const settings = readSettings();
  if (!settings.mode) return { data: null, fetchedAt: null, error: "not_configured" };

  const now = Date.now();
  const cache = readCache();
  const webInWidget = settings.mode === "web" && config.runsInWidget;

  if (webInWidget) {
    // 지난번 위젯 실행이 웹 화면을 띄우다 끝나지 못했다면(메모리 부족 등) 위젯에서는 이 방식이 안 되는 것
    if (cache.web.pendingSince && now - cache.web.pendingSince > WEB_CRASH_GRACE_MS) {
      cache.web.widgetBroken = true;
      cache.web.pendingSince = null;
      saveCache(cache);
    }
    if (cache.web.widgetBroken) return stateFromCache(cache, "web_unavailable");
  }

  const minGap = force ? APP_MIN_REFETCH_SECONDS * 1000 : REFRESH_MINUTES * MINUTE_MS;
  if (cache.lastAttemptAt && now - cache.lastAttemptAt < minGap) {
    return stateFromCache(cache, cache.error);
  }

  cache.lastAttemptAt = now;
  if (webInWidget) cache.web.pendingSince = now;
  saveCache(cache);

  try {
    const get = settings.mode === "cookie" ? cookieGetter(settings.sessionKey) : await webGetter();
    const result = await fetchUsage(get, settings.orgId, { interactive });
    if (result.orgId !== settings.orgId) Keychain.set(KEYCHAIN.orgId, result.orgId);
    cache.data = result.data;
    cache.fetchedAt = now;
    cache.error = null;
    if (settings.mode === "web") {
      if (config.runsInWidget) cache.web.widgetOkAt = now;
      else cache.web.appOkAt = now;
    }
  } catch (e) {
    let kind = e instanceof UsageError ? e.kind : "unknown";
    // 위젯에서 앱 안 로그인 방식이 한 번도 성공한 적 없다면, 로그인 문제가 아니라 iOS 제한일 가능성이 크다
    if (webInWidget && !cache.web.widgetOkAt && ["auth", "offline", "unknown"].includes(kind)) {
      kind = "web_unavailable";
    }
    cache.error = kind;
    cache.errorContext = config.runsInWidget ? "widget" : "app";
    console.log(`사용량 갱신 실패: ${kind} (${e && e.message})`);
  }
  cache.web.pendingSince = null;
  saveCache(cache);
  return stateFromCache(cache, cache.error);
}

function stateFromCache(cache, error) {
  return { data: cache.data || null, fetchedAt: cache.fetchedAt || null, error: error || null };
}

// ─── 저장소: 키체인(비밀 값)과 파일(마지막 값) ──────────────────────────────

function keychainGet(key) {
  try {
    return Keychain.contains(key) ? Keychain.get(key) : null;
  } catch (e) {
    return null;
  }
}

function keychainRemove(key) {
  try {
    if (Keychain.contains(key)) Keychain.remove(key);
  } catch (e) {
    // 이미 없으면 무시
  }
}

function readSettings() {
  const mode = keychainGet(KEYCHAIN.mode);
  const sessionKey = keychainGet(KEYCHAIN.sessionKey);
  const orgId = keychainGet(KEYCHAIN.orgId);
  const valid = mode === "web" || (mode === "cookie" && !!sessionKey);
  return { mode: valid ? mode : null, sessionKey, orgId };
}

function saveSettings({ mode, sessionKey, orgId }) {
  Keychain.set(KEYCHAIN.mode, mode);
  if (mode === "cookie") Keychain.set(KEYCHAIN.sessionKey, sessionKey);
  else keychainRemove(KEYCHAIN.sessionKey); // 쓰지 않는 쿠키는 남겨두지 않는다
  if (orgId) Keychain.set(KEYCHAIN.orgId, orgId);
  else keychainRemove(KEYCHAIN.orgId);
}

function clearSettings() {
  Object.values(KEYCHAIN).forEach(keychainRemove);
  try {
    const fm = FileManager.local();
    const path = cachePath();
    if (fm.fileExists(path)) fm.remove(path);
  } catch (e) {
    // 파일이 없으면 무시
  }
}

function emptyCache() {
  return {
    version: 1,
    data: null,
    fetchedAt: null,
    lastAttemptAt: null,
    error: null,
    errorContext: null,
    web: { pendingSince: null, widgetBroken: false, widgetOkAt: null, appOkAt: null },
  };
}

function cachePath() {
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.libraryDirectory(), CACHE_DIR_NAME);
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  return fm.joinPath(dir, CACHE_FILE_NAME);
}

function readCache() {
  try {
    const fm = FileManager.local();
    const path = cachePath();
    if (!fm.fileExists(path)) return emptyCache();
    const saved = JSON.parse(fm.readString(path));
    const base = emptyCache();
    return Object.assign(base, saved, { web: Object.assign(base.web, saved.web || {}) });
  } catch (e) {
    return emptyCache();
  }
}

function saveCache(cache) {
  try {
    FileManager.local().writeString(cachePath(), JSON.stringify(cache));
  } catch (e) {
    console.log(`마지막 값 저장 실패: ${e && e.message}`);
  }
}

// ─── 시간 표시 (모두 한국 시간) ─────────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, "0");
}

function kstParts(ms) {
  const d = new Date(ms + KST_OFFSET_MS);
  return { day: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

function clockText(ms) {
  const p = kstParts(ms);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 초기화까지: "47분 후", "2시간 13분 후", 하루 이상이면 "목 11:00". 이미 지났으면 null */
function untilText(ts, now) {
  const diff = ts - now;
  if (diff <= 0) return null;
  const minutes = Math.floor(diff / MINUTE_MS);
  if (minutes < 1) return "곧";
  if (minutes < 60) return `${minutes}분 후`;
  if (diff < DAY_MS) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}시간 ${m}분 후` : `${h}시간 후`;
  }
  return `${WEEKDAYS[kstParts(ts).day]} ${clockText(ts)}`;
}

function agoText(ts, now) {
  const minutes = Math.floor((now - ts) / MINUTE_MS);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / (24 * 60))}일 전`;
}

// ─── 화면용 값 정리 ─────────────────────────────────────────────────────────

function limitView(limit, now, grayOut) {
  const hasPct = limit && Number.isFinite(limit.pct);
  const pct = hasPct ? Math.max(0, Math.min(100, limit.pct)) : 0;
  const rounded = Math.round(pct);
  const pctText = pct > 0 && rounded === 0 ? "<1%" : `${rounded}%`;
  let when = null;
  let idle = null;
  if (!hasPct || !limit.resetsAt) idle = "대기 중";
  else {
    when = untilText(limit.resetsAt, now);
    if (!when) idle = "초기화됨";
  }
  return {
    pct,
    pctText,
    color: grayOut ? COLORS.gray : levelColor(pct),
    resetLines: when ? [when, "초기화"] : [idle], // 두 줄로 나눠 쓸 때
    resetText: when ? `${when} 초기화` : idle, // 한 줄로 쓸 때
  };
}

function viewModel(state) {
  const now = Date.now();
  const data = state.data;
  const grayOut = state.error === "auth";
  const error = state.error;
  let status;
  let warn = false;
  const ago = state.fetchedAt ? agoText(state.fetchedAt, now) : "";
  if (!error) status = state.fetchedAt ? `${clockText(state.fetchedAt)} 갱신` : "";
  else if (SOFT_ERRORS.includes(error)) status = `${ago} 기준`;
  else {
    warn = true;
    status = error === "auth" ? ERROR_TEXT.auth.title : `${ERROR_TEXT[error].title} · ${ago}`;
  }
  return {
    five: limitView(data.fiveHour, now, grayOut),
    week: limitView(data.sevenDay, now, grayOut),
    extras: (data.extras || []).map((x) => Object.assign({ label: x.label }, limitView(x, now, grayOut))),
    status,
    warn,
    shortProblem: warn ? ERROR_TEXT[error].short : null,
  };
}

// ─── 위젯 그리기 ────────────────────────────────────────────────────────────

function buildWidget(family, state) {
  const widget = new ListWidget();
  widget.url = USAGE_PAGE_URL;
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * MINUTE_MS);
  switch (family) {
    case "accessoryCircular":
      buildCircular(widget, state);
      break;
    case "accessoryRectangular":
      buildRectangular(widget, state);
      break;
    case "accessoryInline":
      buildInline(widget, state);
      break;
    case "small":
      buildSmall(widget, state);
      break;
    default:
      buildMedium(widget, state);
  }
  return widget;
}

/** 화면 너비로 위젯 크기를 어림한다(막대 길이 계산용, 약간 작게 잡는다). */
function homeWidgetWidth(kind) {
  const s = Device.screenSize();
  const sw = Math.min(s.width, s.height);
  if (kind === "small") return clamp(Math.round(sw * 0.395), 141, 170);
  return clamp(Math.round(sw * 0.85), 292, 364);
}

function lockRectWidth() {
  const s = Device.screenSize();
  return clamp(Math.round(Math.min(s.width, s.height) * 0.4), 150, 172);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function addText(parent, text, font, color, { lines = 1, scale = 0.75 } = {}) {
  const t = parent.addText(text);
  t.font = font;
  t.textColor = color;
  t.lineLimit = lines;
  t.minimumScaleFactor = scale;
  return t;
}

/** 가로로 가운데 정렬된 한 줄을 만든다. */
function centeredRow(parent) {
  const row = parent.addStack();
  row.layoutHorizontally();
  row.addSpacer();
  const inner = row.addStack();
  inner.layoutVertically();
  row.addSpacer();
  return inner;
}

function ringImage(pct, color, size, lineWidth, trackColor) {
  const ctx = new DrawContext();
  ctx.size = new Size(size, size);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const inset = lineWidth / 2;
  ctx.setLineWidth(lineWidth);
  ctx.setStrokeColor(trackColor);
  ctx.strokeEllipse(new Rect(inset, inset, size - lineWidth, size - lineWidth));
  if (pct > 0) {
    const center = size / 2;
    const radius = (size - lineWidth) / 2;
    const sweep = (Math.min(pct, 100) / 100) * Math.PI * 2;
    const steps = Math.max(2, Math.ceil(sweep / (Math.PI / 90)));
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const a = -Math.PI / 2 + (sweep * i) / steps;
      points.push(new Point(center + radius * Math.cos(a), center + radius * Math.sin(a)));
    }
    const path = new Path();
    path.addLines(points);
    ctx.addPath(path);
    ctx.setStrokeColor(color);
    ctx.strokePath();
    // 둥근 끝 모양
    ctx.setFillColor(color);
    for (const p of [points[0], points[points.length - 1]]) {
      ctx.fillEllipse(new Rect(p.x - inset, p.y - inset, lineWidth, lineWidth));
    }
  }
  return ctx.getImage();
}

/** 원형 게이지(가운데에 % 글자). */
function addRing(parent, view, { size, lineWidth, font, textColor, ringColor, trackColor, caption, captionFont }) {
  const ring = parent.addStack();
  ring.size = new Size(size, size);
  ring.layoutVertically();
  ring.backgroundImage = ringImage(view.pct, ringColor || view.color, size, lineWidth, trackColor || COLORS.ringTrack);
  ring.addSpacer();
  addText(centeredRow(ring), view.pctText, font, textColor, { scale: 0.6 });
  if (caption) addText(centeredRow(ring), caption, captionFont, textColor, { scale: 0.6 });
  ring.addSpacer();
  return ring;
}

/** 가로 막대. */
function addBar(parent, pct, color, width, height, trackColor) {
  const track = parent.addStack();
  track.layoutHorizontally();
  track.size = new Size(width, height);
  track.cornerRadius = height / 2;
  track.backgroundColor = trackColor || COLORS.barTrack;
  const fillWidth = Math.round((width * Math.min(pct, 100)) / 100);
  if (fillWidth > 0) {
    const fill = track.addStack();
    fill.size = new Size(Math.max(fillWidth, height), height);
    fill.cornerRadius = height / 2;
    fill.backgroundColor = color;
  }
  track.addSpacer();
  return track;
}

function addStatusRow(widget, vm, fontSize) {
  if (!vm.status) return;
  const row = widget.addStack();
  row.layoutHorizontally();
  addText(row, vm.status, Font.mediumSystemFont(fontSize), vm.warn ? COLORS.warning : COLORS.subtext, { scale: 0.7 });
  row.addSpacer();
}

// 홈 화면 작은 크기: 위 5시간 원형, 아래 주간 막대
function buildSmall(widget, state) {
  widget.backgroundColor = COLORS.background;
  const pad = 14;
  widget.setPadding(pad, pad, pad, pad);
  if (!state.data) return buildMessage(widget, state);
  const vm = viewModel(state);
  const contentWidth = homeWidgetWidth("small") - pad * 2;

  const top = widget.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  addRing(top, vm.five, { size: 54, lineWidth: 6, font: Font.boldRoundedSystemFont(15), textColor: COLORS.text });
  top.addSpacer(9);
  const col = top.addStack();
  col.layoutVertically();
  addText(col, "5시간", Font.semiboldSystemFont(14), COLORS.text);
  col.addSpacer(2);
  for (const line of vm.five.resetLines) addText(col, line, Font.systemFont(11), COLORS.subtext, { scale: 0.7 });
  top.addSpacer();

  widget.addSpacer();

  const label = widget.addStack();
  label.layoutHorizontally();
  label.bottomAlignContent();
  addText(label, "주간", Font.semiboldSystemFont(14), COLORS.text);
  label.addSpacer();
  addText(label, vm.week.pctText, Font.boldRoundedSystemFont(14), COLORS.text);
  widget.addSpacer(5);
  addBar(widget, vm.week.pct, vm.week.color, contentWidth, 6);
  widget.addSpacer(5);
  const reset = widget.addStack();
  reset.layoutHorizontally();
  addText(reset, vm.week.resetText, Font.systemFont(11), COLORS.subtext, { scale: 0.7 });
  reset.addSpacer();

  widget.addSpacer(6);
  addStatusRow(widget, vm, 10);
}

// 홈 화면 중간 크기: 왼쪽 5시간, 오른쪽 주간, 아래 모델별 막대
function buildMedium(widget, state) {
  widget.backgroundColor = COLORS.background;
  const pad = 15;
  widget.setPadding(pad, pad, pad, pad);
  if (!state.data) return buildMessage(widget, state);
  const vm = viewModel(state);
  const contentWidth = homeWidgetWidth("medium") - pad * 2;

  const top = widget.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  const blockWidth = Math.floor((contentWidth - 12) / 2);
  addGaugeBlock(top, "5시간", vm.five, blockWidth);
  top.addSpacer();
  addGaugeBlock(top, "주간", vm.week, blockWidth);

  widget.addSpacer();

  const extras = vm.extras.slice(0, 3);
  if (extras.length > 0) {
    const labelWidth = 56;
    const pctWidth = 36;
    const barWidth = contentWidth - labelWidth - pctWidth - 16;
    extras.forEach((x, i) => {
      if (i > 0) widget.addSpacer(4);
      const row = widget.addStack();
      row.layoutHorizontally();
      row.centerAlignContent();
      const labelBox = row.addStack();
      labelBox.size = new Size(labelWidth, 0);
      addText(labelBox, x.label, Font.mediumSystemFont(11), COLORS.subtext, { scale: 0.7 });
      labelBox.addSpacer();
      row.addSpacer(8);
      addBar(row, x.pct, x.color, barWidth, 5);
      row.addSpacer(8);
      const pctBox = row.addStack();
      pctBox.size = new Size(pctWidth, 0);
      pctBox.addSpacer();
      addText(pctBox, x.pctText, Font.semiboldRoundedSystemFont(11), COLORS.text);
    });
    widget.addSpacer();
  }

  addStatusRow(widget, vm, 10);
}

function addGaugeBlock(parent, title, view, width) {
  const block = parent.addStack();
  block.layoutHorizontally();
  block.centerAlignContent();
  block.size = new Size(width, 0);
  addRing(block, view, { size: 58, lineWidth: 6.5, font: Font.boldRoundedSystemFont(16), textColor: COLORS.text });
  block.addSpacer(10);
  const col = block.addStack();
  col.layoutVertically();
  addText(col, title, Font.semiboldSystemFont(15), COLORS.text);
  col.addSpacer(2);
  for (const line of view.resetLines) addText(col, line, Font.systemFont(12), COLORS.subtext, { scale: 0.7 });
  block.addSpacer();
}

// 값이 없을 때(첫 설정 전, 로그인 만료 등) 할 일을 알려주는 화면
function buildMessage(widget, state) {
  const info = ERROR_TEXT[state.error] || ERROR_TEXT.unknown;
  widget.addSpacer();
  const symbol = SFSymbol.named(info.symbol);
  if (symbol) {
    const img = centeredRow(widget).addImage(symbol.image);
    img.imageSize = new Size(26, 26);
    img.tintColor = COLORS.gray;
    widget.addSpacer(8);
  }
  addText(centeredRow(widget), info.title, Font.semiboldSystemFont(14), COLORS.text).centerAlignText();
  widget.addSpacer(4);
  addText(centeredRow(widget), info.hint, Font.systemFont(11), COLORS.subtext, { lines: 3, scale: 0.8 }).centerAlignText();
  widget.addSpacer();
}

// 잠금 화면 원형: 5시간 사용 %
function buildCircular(widget, state) {
  widget.addAccessoryWidgetBackground = true;
  widget.setPadding(0, 0, 0, 0);
  widget.addSpacer();
  if (!state.data) {
    const info = ERROR_TEXT[state.error] || ERROR_TEXT.unknown;
    const symbol = SFSymbol.named(info.symbol);
    if (symbol) {
      const img = centeredRow(widget).addImage(symbol.image);
      img.imageSize = new Size(22, 22);
      img.tintColor = COLORS.lockPrimary;
      widget.addSpacer(3);
    }
    addText(centeredRow(widget), info.short, Font.semiboldSystemFont(10), COLORS.lockPrimary, { scale: 0.6 });
  } else {
    const vm = viewModel(state);
    const row = widget.addStack();
    row.layoutHorizontally();
    row.addSpacer();
    addRing(row, vm.five, {
      size: 60,
      lineWidth: 5,
      font: Font.boldRoundedSystemFont(17),
      textColor: COLORS.lockPrimary,
      ringColor: COLORS.lockPrimary,
      trackColor: COLORS.lockTrack,
      caption: vm.shortProblem || "5시간",
      captionFont: Font.mediumSystemFont(9),
    });
    row.addSpacer();
  }
  widget.addSpacer();
}

// 잠금 화면 직사각형: "5시간 41% · 주간 12%" + 5시간 초기화까지 남은 시간
function buildRectangular(widget, state) {
  widget.setPadding(0, 0, 0, 0);
  const left = (parent) => {
    const row = parent.addStack();
    row.layoutHorizontally();
    const inner = row.addStack();
    inner.layoutVertically();
    row.addSpacer();
    return inner;
  };
  widget.addSpacer();
  if (!state.data) {
    const info = ERROR_TEXT[state.error] || ERROR_TEXT.unknown;
    addText(left(widget), `Claude · ${info.title}`, Font.semiboldSystemFont(14), COLORS.lockPrimary);
    widget.addSpacer(2);
    addText(left(widget), info.hint, Font.systemFont(12), COLORS.lockSecondary, { lines: 2, scale: 0.8 });
  } else {
    const vm = viewModel(state);
    addText(left(widget), `5시간 ${vm.five.pctText} · 주간 ${vm.week.pctText}`, Font.semiboldSystemFont(15), COLORS.lockPrimary, { scale: 0.7 });
    widget.addSpacer(4);
    addBar(left(widget), vm.five.pct, COLORS.lockPrimary, lockRectWidth() - 6, 5, COLORS.lockTrack);
    widget.addSpacer(4);
    addText(left(widget), vm.five.resetText, Font.systemFont(13), COLORS.lockSecondary, { scale: 0.7 });
    if (vm.warn || state.error) {
      addText(left(widget), vm.status, Font.mediumSystemFont(11), COLORS.lockSecondary, { scale: 0.7 });
    }
  }
  widget.addSpacer();
}

// 잠금 화면 한 줄(시계 위)
function buildInline(widget, state) {
  if (!state.data) {
    const info = ERROR_TEXT[state.error] || ERROR_TEXT.unknown;
    widget.addText(`Claude ${info.title}`);
    return;
  }
  const vm = viewModel(state);
  widget.addText(vm.warn ? `Claude ${vm.shortProblem}` : `5시간 ${vm.five.pctText} · 주간 ${vm.week.pctText}`);
}

// ─── 가짜 데이터 (실제 계정 없이 화면 확인용) ───────────────────────────────

function demoState() {
  const now = Date.now();
  const weekly = nextKstTime(4, 11, 0, now); // 목요일 11:00
  return {
    data: {
      fiveHour: { pct: 41, resetsAt: now + (2 * 60 + 13) * MINUTE_MS + 30 * 1000 },
      sevenDay: { pct: 12, resetsAt: weekly },
      extras: [
        { label: "Opus", pct: 63, resetsAt: weekly },
        { label: "Sonnet", pct: 9, resetsAt: weekly },
      ],
    },
    fetchedAt: now - 2 * MINUTE_MS,
    error: null,
  };
}

/** 하루 이상 뒤에 오는 가장 가까운 (요일, 시:분) 한국 시각 */
function nextKstTime(weekday, hour, minute, now) {
  for (let days = 1; days <= 8; days++) {
    const k = new Date(now + KST_OFFSET_MS + days * DAY_MS);
    const ts = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), hour, minute) - KST_OFFSET_MS;
    if (k.getUTCDay() === weekday && ts - now > DAY_MS) return ts;
  }
  return now + 3 * DAY_MS;
}

// ─── 앱에서 실행했을 때: 설정과 미리보기 ────────────────────────────────────

async function runApp() {
  if (!readSettings().mode) {
    const done = await setupFlow();
    if (!done) return;
  }
  await suggestCookieModeIfNeeded();
  await mainMenu();
}

async function mainMenu() {
  for (;;) {
    const settings = readSettings();
    const alert = new Alert();
    alert.title = "Claude 사용량";
    alert.message = menuSummary(settings);
    alert.addAction("지금 새로고침하고 위젯 보기");
    alert.addAction("가짜 데이터로 미리보기");
    alert.addAction(settings.mode ? "다시 로그인 · 로그인 방식 바꾸기" : "로그인 설정");
    alert.addDestructiveAction("로그인 정보 지우기");
    alert.addCancelAction("닫기");
    const choice = await alert.presentSheet();
    if (choice === -1) return;
    if (choice === 0) {
      if (!settings.mode) {
        await setupFlow();
        continue;
      }
      const state = await loadState({ force: true, interactive: true });
      if (state.error && !SOFT_ERRORS.includes(state.error)) await showProblem(state.error, settings.mode);
      await previewPicker(state);
    } else if (choice === 1) {
      await previewPicker(demoState());
    } else if (choice === 2) {
      await setupFlow();
    } else if (choice === 3) {
      await clearFlow();
    }
  }
}

function menuSummary(settings) {
  const lines = [];
  const modeName = settings.mode === "web" ? "앱 안에서 로그인" : settings.mode === "cookie" ? "쿠키 붙여넣기" : "설정 안 됨";
  lines.push(`로그인 방식: ${modeName}`);
  if (!settings.mode) return lines.join("\n");
  const cache = readCache();
  if (cache.data) {
    const vm = viewModel(stateFromCache(cache, cache.error));
    lines.push(`최근 값: 5시간 ${vm.five.pctText} · 주간 ${vm.week.pctText}`);
    if (vm.status) lines.push(vm.status);
  }
  if (settings.mode === "web") {
    let widgetCheck = "아직 확인 전 (위젯을 추가하고 30분쯤 뒤 다시 열어 보세요)";
    if (cache.web.widgetBroken || (cache.errorContext === "widget" && cache.error === "web_unavailable")) {
      widgetCheck = "작동 안 함 → 쿠키 방식을 추천해요";
    } else if (cache.web.widgetOkAt) {
      widgetCheck = `정상 (${agoText(cache.web.widgetOkAt, Date.now())} 확인)`;
    }
    lines.push(`위젯 자동 갱신: ${widgetCheck}`);
  }
  return lines.join("\n");
}

async function previewPicker(state) {
  const families = [
    ["홈 화면 작은 크기", "small"],
    ["홈 화면 중간 크기", "medium"],
    ["잠금 화면 원형", "accessoryCircular"],
    ["잠금 화면 직사각형", "accessoryRectangular"],
  ];
  for (;;) {
    const alert = new Alert();
    alert.title = "어떤 크기로 볼까요?";
    families.forEach(([name]) => alert.addAction(name));
    alert.addCancelAction("돌아가기");
    const choice = await alert.presentSheet();
    if (choice === -1) return;
    const family = families[choice][1];
    await presentWidget(buildWidget(family, state), family);
  }
}

async function presentWidget(widget, family) {
  const methods = {
    small: "presentSmall",
    medium: "presentMedium",
    accessoryCircular: "presentAccessoryCircular",
    accessoryRectangular: "presentAccessoryRectangular",
  };
  const method = methods[family];
  if (typeof widget[method] === "function") await widget[method]();
  else await widget.presentSmall();
}

async function setupFlow() {
  for (;;) {
    const alert = new Alert();
    alert.title = "로그인 방법 선택";
    alert.message =
      "① 앱 안에서 로그인: 이 앱 안에서 claude.ai에 로그인해요. 쿠키를 복사할 필요가 없어요. " +
      "다만 iOS 제한으로 위젯 자동 갱신이 안 될 수 있어서, 설정 후 자동으로 확인해 드려요.\n\n" +
      "② 쿠키 붙여넣기: PC 브라우저에서 값을 복사해 와야 하지만, 위젯 자동 갱신이 가장 확실해요.";
    alert.addAction("① 앱 안에서 로그인 (먼저 시도)");
    alert.addAction("② 쿠키 붙여넣기 (PC 필요)");
    alert.addCancelAction("취소");
    const choice = await alert.presentAlert();
    if (choice === -1) return false;
    const result = choice === 0 ? await webLoginFlow() : await cookieFlow();
    if (result === "done") return true;
    if (result === "cancel") return false;
    // "other": 다른 방식을 고르도록 처음으로
  }
}

async function webLoginFlow() {
  for (;;) {
    await notice(
      "claude.ai 로그인",
      "다음 화면에서 평소처럼 claude.ai에 로그인하세요.\n\n" +
        "• Google 버튼이 안 되면 이메일 주소를 입력해 로그인하세요(메일로 온 코드나 링크 사용).\n" +
        "• 로그인 후 사용량 화면이나 채팅 화면이 보이면, 화면 위쪽의 닫기 버튼을 누르세요."
    );
    const webView = new WebView();
    try {
      await webView.loadURL(USAGE_PAGE_URL);
    } catch (e) {
      // 화면을 띄운 뒤 사용자가 다시 시도할 수 있으므로 계속 진행
    }
    await webView.present(true);

    const result = await testConnection("web", null);
    if (result.ok) {
      await notice(
        "연결 성공",
        `${result.summary}\n\n이제 홈 화면이나 잠금 화면에 위젯을 추가하세요.\n` +
          "앱 안 로그인 방식은 위젯에서 자동 갱신이 되는지 확인이 필요해요. 위젯을 추가하고 30분쯤 뒤 이 스크립트를 다시 열면 결과를 알려드려요."
      );
      return "done";
    }
    const next = await failureChoice(result.kind, "web");
    if (next !== "retry") return next;
  }
}

async function cookieFlow() {
  for (;;) {
    const alert = new Alert();
    alert.title = "sessionKey 붙여넣기";
    alert.message =
      "PC 브라우저에서 복사한 sessionKey 값을 붙여넣으세요(방법은 설치안내 참고).\n" +
      "값은 이 아이폰의 키체인에만 저장되고 화면에 다시 표시되지 않아요.";
    alert.addSecureTextField("sk-ant-sid01-…", "");
    alert.addAction("저장하고 확인");
    alert.addCancelAction("취소");
    if ((await alert.presentAlert()) === -1) return "cancel";
    const sessionKey = normalizeSessionKey(alert.textFieldValue(0));
    if (!sessionKey) {
      await notice("값이 비어 있어요", "sessionKey 값을 붙여넣어 주세요.");
      continue;
    }
    const result = await testConnection("cookie", sessionKey);
    if (result.ok) {
      await notice("연결 성공", `${result.summary}\n\n이제 홈 화면이나 잠금 화면에 위젯을 추가하세요.`);
      return "done";
    }
    const next = await failureChoice(result.kind, "cookie");
    if (next !== "retry") return next;
  }
}

function normalizeSessionKey(raw) {
  let s = String(raw || "").trim();
  const match = s.match(/sessionKey=([^;\s]+)/);
  if (match) s = match[1];
  s = s.replace(/^["']+|["';]+$/g, "").trim();
  if (/[\s;,]/.test(s)) return ""; // 쿠키 값에 들어갈 수 없는 글자
  return s;
}

/** 연결을 시험하고, 성공하면 설정과 마지막 값을 저장한다. */
async function testConnection(mode, sessionKey) {
  try {
    const get = mode === "cookie" ? cookieGetter(sessionKey) : await webGetter();
    const { data, orgId } = await fetchUsage(get, null, { interactive: true });
    saveSettings({ mode, sessionKey, orgId });
    const now = Date.now();
    const cache = emptyCache();
    cache.data = data;
    cache.fetchedAt = now;
    cache.lastAttemptAt = now;
    if (mode === "web") cache.web.appOkAt = now;
    saveCache(cache);
    const vm = viewModel({ data, fetchedAt: now, error: null });
    return { ok: true, summary: `5시간 ${vm.five.pctText} · 주간 ${vm.week.pctText}` };
  } catch (e) {
    console.log(`연결 확인 실패: ${e && e.message}`);
    return { ok: false, kind: e instanceof UsageError ? e.kind : "unknown" };
  }
}

function failureMessage(kind, mode) {
  switch (kind) {
    case "auth":
      return mode === "web"
        ? "로그인이 확인되지 않았어요. 로그인을 끝까지 마친 뒤 닫기를 눌렀는지 확인해 주세요."
        : "쿠키 값이 올바르지 않거나 만료됐어요. PC에서 sessionKey를 다시 복사해 주세요.";
    case "blocked":
      return mode === "web"
        ? "claude.ai가 접속을 막았어요(Cloudflare). 잠시 후 다시 시도해 주세요."
        : "claude.ai가 접속을 막았어요(Cloudflare). '앱 안에서 로그인' 방식을 써 보세요.";
    case "offline":
      return "인터넷 연결을 확인한 뒤 다시 시도해 주세요.";
    case "rate":
      return "요청이 너무 많다고 해요. 몇 분 뒤 다시 시도해 주세요.";
    case "format":
      return "claude.ai 응답 형식이 바뀐 것 같아요. Claude Code에 스크립트 수정을 요청해 주세요.";
    default:
      return "알 수 없는 문제가 생겼어요. 잠시 후 다시 시도해 주세요.";
  }
}

async function failureChoice(kind, mode) {
  const alert = new Alert();
  alert.title = "연결하지 못했어요";
  alert.message = failureMessage(kind, mode);
  alert.addAction("다시 시도");
  alert.addAction("다른 로그인 방식 고르기");
  alert.addCancelAction("취소");
  const choice = await alert.presentAlert();
  if (choice === 0) return "retry";
  if (choice === 1) return "other";
  return "cancel";
}

async function showProblem(kind, mode) {
  const info = ERROR_TEXT[kind] || ERROR_TEXT.unknown;
  await notice(info.title, kind === "web_unavailable" ? info.hint : failureMessage(kind, mode));
}

/** 앱 안 로그인 방식이 위젯에서 안 되는 것으로 확인되면 쿠키 방식을 권한다. */
async function suggestCookieModeIfNeeded() {
  const settings = readSettings();
  if (settings.mode !== "web") return;
  const cache = readCache();
  const widgetFailing = cache.web.widgetBroken || (cache.errorContext === "widget" && cache.error === "web_unavailable");
  if (!widgetFailing) return;
  const alert = new Alert();
  alert.title = "위젯이 값을 받지 못하고 있어요";
  alert.message =
    "앱 안 로그인은 Scriptable 앱 안에서는 되지만, iOS 제한으로 위젯(백그라운드)에서는 작동하지 않는 것으로 확인됐어요.\n\n" +
    "쿠키 붙여넣기 방식으로 바꾸면 위젯이 자동으로 갱신돼요.";
  alert.addAction("쿠키 방식으로 바꾸기");
  alert.addCancelAction("나중에");
  if ((await alert.presentAlert()) === 0) await cookieFlow();
}

async function clearFlow() {
  const alert = new Alert();
  alert.title = "로그인 정보를 지울까요?";
  alert.message = "키체인에 저장된 로그인 정보와 마지막 사용량 값을 모두 지워요. 위젯에는 '다시 로그인 필요'가 표시돼요.";
  alert.addDestructiveAction("지우기");
  alert.addCancelAction("취소");
  if ((await alert.presentAlert()) !== 0) return;
  clearSettings();
  await notice("지웠어요", "다시 쓰려면 메뉴에서 '로그인 설정'을 누르세요.");
}

async function notice(title, message) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addAction("확인");
  await alert.presentAlert();
}

// 모든 상수가 정의된 뒤에 실행해야 하므로 반드시 파일 맨 끝에 둔다
await main();
