// 여러 상황(정상, 오류 등)에서 실제 위젯 스크립트를 실행해 미리보기 보드를 만든다.
// render-previews.mjs가 이 페이지를 열고 화면을 캡처한다.
(async function () {
  "use strict";
  const { runScript, renderWidget, fitText } = window.ScriptableMock;
  const code = await (await fetch(new URLSearchParams(location.search).get("script") || "/claude-usage-widget.js")).text();

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  // 하루 이상 뒤의 목요일 11:00(한국 시간)
  function nextThursday11() {
    for (let d = 1; d <= 8; d++) {
      const k = new Date(now + 9 * HOUR + d * DAY);
      const ts = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), 11, 0) - 9 * HOUR;
      if (k.getUTCDay() === 4 && ts - now > DAY) return ts;
    }
  }
  const weekly = nextThursday11();

  const ORGS = JSON.stringify([
    { uuid: "org-api-only", name: "API", capabilities: ["api"] },
    { uuid: "org-1", name: "개인", capabilities: ["chat", "claude_max"] },
  ]);
  function usageBody({ five, fiveReset, week, opus, sonnet, extra = {} }) {
    return JSON.stringify(Object.assign({
      five_hour: five === null ? null : { utilization: five, resets_at: iso(fiveReset) },
      seven_day: { utilization: week, resets_at: iso(weekly) },
      seven_day_oauth_apps: null,
      seven_day_opus: opus == null ? null : { utilization: opus, resets_at: iso(weekly) },
      seven_day_sonnet: sonnet == null ? null : { utilization: sonnet, resets_at: iso(weekly) },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      // 뜻을 모르는 내부 코드명 항목은 위젯에 나오면 안 된다
      seven_day_iguana_necktie: { utilization: 2, resets_at: iso(weekly) },
    }, extra));
  }
  function api(routes) {
    return async (path) => {
      const r = routes[path];
      if (!r) return { status: 404, body: '{"error":"not found"}' };
      if (r === "offline") throw new Error("The Internet connection appears to be offline.");
      return r;
    };
  }
  const cookieKeychain = () => ({ "claude-usage-widget.mode": "cookie", "claude-usage-widget.session-key": "sk-ant-sid01-TEST" });
  const CACHE = "/lib/claude-usage-widget/cache.json";
  function cachedFile({ fetchedAgo, attemptAgo, data, web }) {
    return {
      [CACHE]: JSON.stringify({
        version: 1,
        data,
        fetchedAt: now - fetchedAgo,
        lastAttemptAt: now - attemptAgo,
        error: null,
        web: web || { pendingSince: null, widgetBroken: false, widgetOkAt: null, appOkAt: null },
      }),
    };
  }
  const oldData = {
    fiveHour: { pct: 58, resetsAt: now + 3 * HOUR + 20 * MIN },
    sevenDay: { pct: 34, resetsAt: weekly },
    extras: [{ label: "Opus", pct: 22, resetsAt: weekly }],
  };
  const okRoutes = (body) => ({ "/api/organizations": { status: 200, body: ORGS }, "/api/organizations/org-1/usage": { status: 200, body } });

  const SCENARIOS = [
    {
      id: "normal",
      title: "정상 (가짜 응답: 5시간 41%, 주간 12%, Opus 63%, Sonnet 9%)",
      env: () => ({ keychain: cookieKeychain(), files: {}, api: api(okRoutes(usageBody({ five: 41, fiveReset: now + 2 * HOUR + 13 * MIN + 30000, week: 12, opus: 63, sonnet: 9 }))) }),
      expectRequests: 2,
    },
    {
      id: "high",
      title: "사용량 높음 (5시간 87% · 47분 후, 주간 55%)",
      env: () => ({ keychain: cookieKeychain(), files: {}, api: api(okRoutes(usageBody({ five: 87, fiveReset: now + 47 * MIN + 30000, week: 55, opus: 92 }))) }),
      expectRequests: 2,
    },
    {
      id: "idle",
      title: "세션 시작 전 (5시간 값 비어 있음)",
      env: () => ({ keychain: cookieKeychain(), files: {}, api: api(okRoutes(usageBody({ five: null, week: 3 }))) }),
      expectRequests: 2,
    },
    {
      id: "offline",
      title: "인터넷 끊김 (23분 전 값 표시)",
      env: () => ({
        keychain: Object.assign(cookieKeychain(), { "claude-usage-widget.org-id": "org-1" }),
        files: cachedFile({ fetchedAgo: 23 * MIN, attemptAgo: 16 * MIN, data: oldData }),
        api: api({ "/api/organizations/org-1/usage": "offline" }),
      }),
      expectRequests: 1,
    },
    {
      id: "auth",
      title: "로그인 만료 (401) — 마지막 값을 회색으로",
      env: () => ({
        keychain: Object.assign(cookieKeychain(), { "claude-usage-widget.org-id": "org-1" }),
        files: cachedFile({ fetchedAgo: 40 * MIN, attemptAgo: 16 * MIN, data: oldData }),
        api: api({ "/api/organizations/org-1/usage": { status: 401, body: '{"type":"error"}' }, "/api/organizations": { status: 401, body: '{"type":"error"}' } }),
      }),
      expectRequests: 1,
    },
    {
      id: "not-configured",
      title: "로그인 정보 없음 (지운 뒤)",
      env: () => ({ keychain: {}, files: {}, api: api({}) }),
      expectRequests: 0,
    },
    {
      id: "blocked",
      title: "접속 차단 (Cloudflare)",
      env: () => ({
        keychain: cookieKeychain(),
        files: {},
        api: api({ "/api/organizations": { status: 403, body: "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cf-chl</body></html>" } }),
      }),
      expectRequests: 1,
    },
    {
      id: "format",
      title: "응답 형식 변경",
      env: () => ({ keychain: cookieKeychain(), files: {}, api: api(okRoutes(JSON.stringify({ limits: [] }))) }),
      expectRequests: 2,
    },
    {
      id: "web-ok",
      title: "앱 안 로그인 방식 — 위젯에서 정상",
      env: () => ({
        keychain: { "claude-usage-widget.mode": "web" },
        files: {},
        webView: "ok",
        api: api(okRoutes(usageBody({ five: 41, fiveReset: now + 2 * HOUR + 13 * MIN + 30000, week: 12, opus: 63, sonnet: 9 }))),
      }),
      expectRequests: 3,
    },
    {
      id: "web-fetch-blocked",
      title: "앱 안 로그인 방식 — 웹 화면 fetch가 막혀 페이지 방식으로 전환",
      env: () => ({
        keychain: { "claude-usage-widget.mode": "web" },
        files: {},
        webView: "fetch-blocked",
        api: api(okRoutes(usageBody({ five: 41, fiveReset: now + 2 * HOUR + 13 * MIN + 30000, week: 12, opus: 63, sonnet: 9 }))),
      }),
      expectRequests: 3,
    },
    {
      id: "web-unavailable",
      title: "앱 안 로그인 방식 — 위젯에서 작동 안 함",
      env: () => ({
        keychain: { "claude-usage-widget.mode": "web", "claude-usage-widget.org-id": "org-1" },
        files: cachedFile({ fetchedAgo: 20 * MIN, attemptAgo: 20 * MIN, data: oldData, web: { pendingSince: null, widgetBroken: false, widgetOkAt: null, appOkAt: now - 20 * MIN } }),
        webView: "load-fails",
        api: api({}),
      }),
      expectRequests: 0,
    },
    {
      id: "demo",
      title: "가짜 데이터 모드 (위젯 Parameter에 demo)",
      env: () => ({ keychain: {}, files: {}, api: api({}), widgetParameter: "demo" }),
      expectRequests: 0,
    },
  ];

  const FAMILIES = ["small", "medium", "accessoryCircular", "accessoryRectangular", "accessoryInline"];
  const FAMILY_NAMES = {
    small: "홈 화면 작은 크기",
    medium: "홈 화면 중간 크기",
    accessoryCircular: "잠금 화면 원형",
    accessoryRectangular: "잠금 화면 직사각형",
    accessoryInline: "잠금 화면 한 줄",
  };

  const params = new URLSearchParams(location.search);
  const theme = params.get("theme") || "light";
  const only = params.get("scenarios") ? params.get("scenarios").split(",") : null;
  document.body.className = theme;
  document.getElementById("board").style.setProperty("--cols", params.get("cols") || "1");

  const report = [];
  const board = document.getElementById("board");
  for (const sc of SCENARIOS) {
    if (only && !only.includes(sc.id)) continue;
    const env = Object.assign(sc.env(), { theme });
    const section = document.createElement("section");
    section.className = "scenario";
    section.id = `sc-${sc.id}`;
    section.innerHTML = `<h2>${sc.title}</h2>`;
    const home = document.createElement("div");
    home.className = "home";
    const lock = document.createElement("div");
    lock.className = "lock";
    section.append(home, lock);
    board.appendChild(section);

    const entry = { id: sc.id, widgets: {}, errors: [] };
    // 같은 환경(키체인·파일)을 공유하며 위젯 5종을 차례로 실행 → 두 번째부터는 저장된 값을 써야 한다
    for (const family of FAMILIES) {
      env.family = family;
      try {
        const w = await runScript(code, env);
        const el = renderWidget(w, family, theme);
        const cell = document.createElement("figure");
        cell.innerHTML = `<figcaption>${FAMILY_NAMES[family]}</figcaption>`;
        cell.prepend(el);
        (family.startsWith("accessory") ? lock : home).appendChild(cell);
        fitText(el);
        entry.widgets[family] = {
          text: el.innerText.replace(/\s+/g, " ").trim(),
          truncated: [...el.querySelectorAll('[data-truncated="1"]')].map((t) => t.textContent),
          refreshMinutes: w.refreshAfterDate ? Math.round((w.refreshAfterDate - Date.now()) / 60000) : null,
          url: w.url,
        };
        if (/iguana/i.test(entry.widgets[family].text)) entry.errors.push(`${family}: 모르는 항목이 표시됨`);
      } catch (e) {
        entry.errors.push(`${family}: ${e && e.stack}`);
      }
    }
    entry.requests = env.requests.map((r) => `${r.via} ${r.method} ${r.path}`);
    entry.expectRequests = sc.expectRequests;
    entry.cookieHeaderOk = env.requests.filter((r) => r.via === "request").every((r) => r.headers.Cookie === "sessionKey=sk-ant-sid01-TEST");
    entry.logs = env.logs || [];
    report.push(entry);
  }
  // 앱에서 실행: 위젯에서 앱 안 로그인 방식이 실패한 기록이 있을 때 쿠키 방식으로 자동 전환되는지
  if (!only) {
    const brokenWeb = () => cachedFile({ fetchedAgo: 60 * MIN, attemptAgo: 20 * MIN, data: oldData, web: { pendingSince: null, widgetBroken: false, widgetOkAt: null, appOkAt: now - 60 * MIN } });
    const routes = okRoutes(usageBody({ five: 17, fiveReset: now + HOUR, week: 82 }));
    const appTests = [
      { id: "app-auto-switch", webCookie: "anthropic-device-id=x; sessionKey=sk-ant-sid01-TEST; lastActiveOrg=org-1", expectMode: "cookie", expectAlert: "위젯 자동 갱신을 고쳤어요" },
      { id: "app-httponly", webCookie: "anthropic-device-id=x", expectMode: "web", expectAlert: "위젯이 값을 받지 못하고 있어요" },
    ];
    for (const t of appTests) {
      const files = brokenWeb();
      const cache = JSON.parse(files[CACHE]);
      cache.error = "web_unavailable";
      cache.errorContext = "widget";
      files[CACHE] = JSON.stringify(cache);
      const env = { inWidget: false, family: null, theme, keychain: { "claude-usage-widget.mode": "web", "claude-usage-widget.org-id": "org-1" }, files, webView: "ok", webCookie: t.webCookie, api: api(routes) };
      const entry = { id: t.id, widgets: {}, errors: [], expectRequests: null };
      try {
        await runScript(code, env);
      } catch (e) {
        entry.errors.push(String(e && e.stack));
      }
      const mode = env.keychain["claude-usage-widget.mode"];
      if (mode !== t.expectMode) entry.errors.push(`로그인 방식 ${mode} (예상 ${t.expectMode})`);
      if (!(env.alerts || []).includes(t.expectAlert)) entry.errors.push(`안내 창 "${t.expectAlert}" 없음: ${(env.alerts || []).join(" / ")}`);
      if (t.expectMode === "cookie") {
        const saved = JSON.parse(env.files[CACHE]);
        if (saved.web.widgetBroken || saved.error) entry.errors.push("전환 후에도 오류 기록이 남음");
        if (env.keychain["claude-usage-widget.session-key"] !== "sk-ant-sid01-TEST") entry.errors.push("키체인에 쿠키가 저장되지 않음");
      }
      entry.requests = env.requests.map((r) => `${r.via} ${r.method} ${r.path}`);
      entry.cookieHeaderOk = env.requests.filter((r) => r.via === "request").every((r) => r.headers.Cookie === "sessionKey=sk-ant-sid01-TEST");
      entry.alerts = env.alerts || [];
      report.push(entry);
    }
  }
  window.__report = report;
  window.__done = true;
})().catch((e) => {
  window.__report = [{ fatal: String(e && e.stack) }];
  window.__done = true;
});
