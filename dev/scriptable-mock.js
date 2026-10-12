// 브라우저에서 Scriptable API를 흉내 내어 위젯 스크립트를 실행하고 HTML로 그린다.
// 실제 아이폰 렌더링과 글꼴·여백이 조금 다를 수 있다. 미리보기와 동작 점검용.
(function () {
  "use strict";

  // ── 기본 값 타입 ─────────────────────────────────────────────────────────
  class Size { constructor(width, height) { this.width = width; this.height = height; } }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }
  class Rect {
    constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); }
    get minX() { return this.x; } get minY() { return this.y; }
    get maxX() { return this.x + this.width; } get maxY() { return this.y + this.height; }
  }

  class Color {
    constructor(hex, alpha = 1) {
      const h = String(hex).replace("#", "");
      this.hex = h.slice(0, 6).toUpperCase();
      this.alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : alpha;
    }
    static dynamic(light, dark) { const c = new Color(light.hex, light.alpha); c.light = light; c.dark = dark; return c; }
    static white() { return new Color("#FFFFFF"); }
    static black() { return new Color("#000000"); }
    static clear() { return new Color("#000000", 0); }
    static gray() { return new Color("#808080"); }
    static red() { return new Color("#FF0000"); }
    css(theme) {
      const c = this.light ? (theme === "dark" ? this.dark : this.light) : this;
      const n = parseInt(c.hex, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${c.alpha})`;
    }
  }

  const WEIGHTS = { ultraLight: 200, thin: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 };
  class Font {
    constructor(name, size) { this.size = size; this.weight = 400; this.rounded = false; this.name = name; }
  }
  for (const [w, value] of Object.entries(WEIGHTS)) {
    const make = (rounded) => (size) => { const f = new Font("system", size); f.weight = value; f.rounded = rounded; return f; };
    Font[`${w}SystemFont`] = make(false);
    Font[`${w}RoundedSystemFont`] = make(true);
    Font[`${w}MonospacedSystemFont`] = make(false);
  }
  Font.systemFont = Font.regularSystemFont;

  class Image {
    constructor(url, size, opts = {}) { this._url = url; this.size = size; this._symbol = !!opts.symbol; }
  }

  // ── 그리기 ───────────────────────────────────────────────────────────────
  class Path {
    constructor() { this._ops = []; }
    move(p) { this._ops.push(["move", p]); }
    addLine(p) { this._ops.push(["line", p]); }
    addLines(points) { points.forEach((p, i) => this._ops.push([i === 0 ? "move" : "line", p])); }
    addEllipse(r) { this._ops.push(["ellipse", r]); }
    addRect(r) { this._ops.push(["rect", r]); }
    addRoundedRect(r, w, h) { this._ops.push(["rrect", r, w, h]); }
    closeSubpath() { this._ops.push(["close"]); }
  }

  class DrawContext {
    constructor() {
      this.size = new Size(200, 200);
      this.respectScreenScale = false;
      this.opaque = true;
      this._ops = [];
    }
    setStrokeColor(c) { this._ops.push((g, t) => { g.strokeStyle = c.css(t); }); }
    setFillColor(c) { this._ops.push((g, t) => { g.fillStyle = c.css(t); }); }
    setLineWidth(w) { this._ops.push((g) => { g.lineWidth = w; }); }
    strokeEllipse(r) { this._ops.push((g) => { g.beginPath(); g.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2); g.stroke(); }); }
    fillEllipse(r) { this._ops.push((g) => { g.beginPath(); g.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2); g.fill(); }); }
    fillRect(r) { this._ops.push((g) => g.fillRect(r.x, r.y, r.width, r.height)); }
    addPath(path) {
      this._ops.push((g) => {
        g.beginPath();
        for (const [op, a, b, c] of path._ops) {
          if (op === "move") g.moveTo(a.x, a.y);
          else if (op === "line") g.lineTo(a.x, a.y);
          else if (op === "ellipse") g.ellipse(a.x + a.width / 2, a.y + a.height / 2, a.width / 2, a.height / 2, 0, 0, Math.PI * 2);
          else if (op === "rect") g.rect(a.x, a.y, a.width, a.height);
          else if (op === "rrect") g.roundRect(a.x, a.y, a.width, a.height, b);
          else if (op === "close") g.closePath();
        }
      });
    }
    strokePath() { this._ops.push((g) => g.stroke()); }
    fillPath() { this._ops.push((g) => g.fill()); }
    getImage() {
      const ops = this._ops.slice();
      const size = this.size;
      const opaque = this.opaque;
      // 테마마다 다시 그릴 수 있게 함수로 보관한다
      const image = new Image(null, new Size(size.width, size.height));
      image._draw = (theme) => {
        const scale = 3;
        const canvas = document.createElement("canvas");
        canvas.width = size.width * scale;
        canvas.height = size.height * scale;
        const g = canvas.getContext("2d");
        g.scale(scale, scale);
        if (opaque) { g.fillStyle = "#fff"; g.fillRect(0, 0, size.width, size.height); }
        g.lineCap = "butt";
        ops.forEach((op) => op(g, theme));
        return canvas.toDataURL("image/png");
      };
      return image;
    }
  }

  // SF Symbols 대용: 단순한 아이콘 모양(실제 아이폰에서는 SF Symbols가 쓰인다)
  const SFSymbol = {
    named(name) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="black" stroke-width="2"/><rect x="11" y="6" width="2" height="8" rx="1"/><circle cx="12" cy="17.5" r="1.3"/></svg>`;
      const img = new Image("data:image/svg+xml;utf8," + encodeURIComponent(svg), new Size(24, 24), { symbol: true });
      return { image: img, name, applyFont() {}, applyMediumWeight() {} };
    },
  };

  // ── 위젯 요소 ────────────────────────────────────────────────────────────
  class WidgetText {
    constructor(text) {
      this.kind = "text";
      this.text = text;
      this.font = Font.systemFont(17);
      this.textColor = null;
      this.lineLimit = 0;
      this.minimumScaleFactor = 1;
      this.textOpacity = 1;
      this.align = "left";
    }
    leftAlignText() { this.align = "left"; }
    centerAlignText() { this.align = "center"; }
    rightAlignText() { this.align = "right"; }
  }

  class WidgetImage {
    constructor(image) { this.kind = "image"; this.image = image; this.imageSize = null; this.tintColor = null; this.resizable = true; }
    centerAlignImage() {} leftAlignImage() {} rightAlignImage() {}
  }

  class WidgetSpacer { constructor(length) { this.kind = "spacer"; this.length = length; } }

  class WidgetStack {
    constructor() {
      this.kind = "stack";
      this.children = [];
      this.layout = "h";
      this.align = "center";
      this.size = new Size(0, 0);
      this.spacing = 0;
      this.padding = [0, 0, 0, 0];
      this.backgroundColor = null;
      this.backgroundImage = null;
      this.cornerRadius = 0;
      this.url = null;
    }
    layoutHorizontally() { this.layout = "h"; }
    layoutVertically() { this.layout = "v"; }
    topAlignContent() { this.align = "start"; }
    centerAlignContent() { this.align = "center"; }
    bottomAlignContent() { this.align = "end"; }
    setPadding(t, l, b, r) { this.padding = [t, l, b, r]; }
    useDefaultPadding() { this.padding = null; }
    addText(s) { const t = new WidgetText(String(s)); this.children.push(t); return t; }
    addImage(img) { const i = new WidgetImage(img); this.children.push(i); return i; }
    addStack() { const s = new WidgetStack(); this.children.push(s); return s; }
    addSpacer(length) { const s = new WidgetSpacer(length); this.children.push(s); return s; }
    addDate(d) { return this.addText(d.toISOString()); }
  }

  class ListWidget extends WidgetStack {
    constructor() {
      super();
      this.layout = "v";
      this.padding = null;
      this.refreshAfterDate = null;
      this.addAccessoryWidgetBackground = false;
    }
  }
  ["presentSmall", "presentMedium", "presentLarge", "presentAccessoryCircular", "presentAccessoryRectangular", "presentAccessoryInline"].forEach((m) => {
    ListWidget.prototype[m] = async function () {};
  });

  // ── HTML로 그리기 ────────────────────────────────────────────────────────
  // SwiftUI처럼 "늘어나는" 요소(유연한 Spacer를 품은 스택)는 가능한 공간을 차지한다.
  function greedy(node, axis) {
    if (node.kind !== "stack") return false;
    const fixed = axis === "h" ? node.size.width : node.size.height;
    if (fixed > 0) return false;
    return node.children.some((c) =>
      (c.kind === "spacer" && c.length == null && node.layout === axis) || greedy(c, axis)
    );
  }

  function renderNode(node, parent, theme) {
    const axis = parent.layout;
    if (node.kind === "spacer") {
      const el = document.createElement("div");
      el.className = "sp";
      if (node.length != null) {
        el.style.flex = `0 0 ${node.length}px`;
        el.style[axis === "h" ? "width" : "height"] = `${node.length}px`;
      } else {
        el.style.flex = "1 1 0";
        el.style.minWidth = "0";
        el.style.minHeight = "0";
      }
      return el;
    }
    if (node.kind === "text") {
      const el = document.createElement("div");
      el.className = "tx";
      el.textContent = node.text;
      const f = node.font;
      el.style.fontSize = `${f.size}px`;
      el.style.fontWeight = f.weight;
      el.style.color = node.textColor ? node.textColor.css(theme) : theme === "dark" ? "#fff" : "#000";
      el.style.textAlign = node.align;
      if (node.lineLimit === 1) el.style.whiteSpace = "nowrap";
      else if (node.lineLimit > 1) { el.style.display = "-webkit-box"; el.style.webkitLineClamp = node.lineLimit; el.style.webkitBoxOrient = "vertical"; }
      el.dataset.base = f.size;
      el.dataset.minscale = node.minimumScaleFactor;
      return el;
    }
    if (node.kind === "image") {
      const size = node.imageSize || node.image.size;
      const el = document.createElement("div");
      el.className = "im";
      el.style.width = `${size.width}px`;
      el.style.height = `${size.height}px`;
      const url = node.image._draw ? node.image._draw(theme) : node.image._url;
      if (node.tintColor) {
        el.style.backgroundColor = node.tintColor.css(theme);
        el.style.webkitMaskImage = `url("${url}")`;
        el.style.webkitMaskSize = "100% 100%";
      } else {
        el.style.backgroundImage = `url("${url}")`;
        el.style.backgroundSize = "100% 100%";
      }
      return el;
    }
    // stack
    const el = document.createElement("div");
    el.className = "st";
    styleStack(el, node, theme);
    if (axis) {
      const crossAxis = axis === "h" ? "v" : "h";
      if (greedy(node, axis)) el.style.flex = "1 1 0";
      if (greedy(node, crossAxis)) el.style.alignSelf = "stretch";
    }
    return el;
  }

  function styleStack(el, node, theme) {
    el.style.display = "flex";
    el.style.flexDirection = node.layout === "v" ? "column" : "row";
    el.style.alignItems = node.layout === "v" ? "flex-start" : { start: "flex-start", center: "center", end: "flex-end" }[node.align];
    if (node.spacing) el.style.gap = `${node.spacing}px`;
    if (node.padding) el.style.padding = node.padding.map((p) => `${p}px`).join(" ");
    if (node.backgroundColor) el.style.backgroundColor = node.backgroundColor.css(theme);
    if (node.backgroundImage) {
      const url = node.backgroundImage._draw ? node.backgroundImage._draw(theme) : node.backgroundImage._url;
      el.style.backgroundImage = `url("${url}")`;
      el.style.backgroundSize = "100% 100%";
    }
    if (node.cornerRadius) { el.style.borderRadius = `${node.cornerRadius}px`; el.style.overflow = "hidden"; }
    if (node.size.width > 0) { el.style.width = el.style.minWidth = el.style.maxWidth = `${node.size.width}px`; el.style.flexShrink = "0"; }
    if (node.size.height > 0) { el.style.height = el.style.minHeight = el.style.maxHeight = `${node.size.height}px`; el.style.flexShrink = "0"; }
    for (const child of node.children) el.appendChild(renderNode(child, node, theme));
  }

  const FAMILY_BOX = {
    small: { w: 158, h: 158, radius: 22, home: true },
    medium: { w: 338, h: 158, radius: 22, home: true },
    large: { w: 338, h: 354, radius: 22, home: true },
    accessoryCircular: { w: 72, h: 72, radius: 36 },
    accessoryRectangular: { w: 160, h: 72, radius: 12 },
    accessoryInline: { w: 240, h: 22, radius: 0 },
  };

  function renderWidget(widget, family, theme) {
    const box = FAMILY_BOX[family];
    const el = document.createElement("div");
    el.className = `widget ${family} ${theme}`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    el.style.borderRadius = `${box.radius}px`;
    const defaultPadding = box.home ? 16 : 0;
    const node = Object.assign({}, widget, { padding: widget.padding || [defaultPadding, defaultPadding, defaultPadding, defaultPadding] });
    node.children = widget.children;
    if (box.home && !widget.backgroundColor) el.style.backgroundColor = theme === "dark" ? "#1C1C1E" : "#fff";
    if (widget.addAccessoryWidgetBackground) el.style.backgroundColor = "rgba(255,255,255,0.16)";
    if (family === "accessoryInline") {
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.color = "#fff";
      el.style.fontSize = "15px";
      el.style.fontWeight = "600";
      el.textContent = widget.children.filter((c) => c.kind === "text").map((c) => c.text).join(" ");
      return el;
    }
    styleStack(el, node, theme);
    el.style.width = el.style.minWidth = el.style.maxWidth = `${box.w}px`;
    el.style.height = el.style.minHeight = el.style.maxHeight = `${box.h}px`;
    el.style.boxSizing = "border-box";
    el.style.overflow = "hidden";
    return el;
  }

  /** DOM에 붙인 뒤 호출: minimumScaleFactor 만큼 글자를 줄여 넘침을 막는다. */
  function fitText(root) {
    root.querySelectorAll(".tx").forEach((el) => {
      const base = parseFloat(el.dataset.base);
      const min = base * parseFloat(el.dataset.minscale || "1");
      let size = base;
      while ((el.scrollWidth > el.clientWidth + 0.5 || el.scrollHeight > el.clientHeight + 0.5) && size - 0.25 >= min) {
        size -= 0.25;
        el.style.fontSize = `${size}px`;
      }
      if (el.scrollWidth > el.clientWidth + 0.5) el.dataset.truncated = "1";
    });
  }

  // ── 실행 환경 ────────────────────────────────────────────────────────────
  /**
   * env: {
   *   family, theme, inWidget(기본 true), widgetParameter,
   *   keychain: {키: 값}, files: {경로: 문자열},
   *   api(path, {via, headers}) → {status, body} 또는 throw,
   *   webView: "ok" | "load-fails"
   *   requests: [] (호출 기록)
   * }
   */
  async function runScript(code, env) {
    let widget = null;
    const keychain = env.keychain;
    const files = env.files;
    env.requests = env.requests || [];

    const Keychain = {
      contains: (k) => Object.prototype.hasOwnProperty.call(keychain, k),
      get: (k) => { if (!(k in keychain)) throw new Error(`키체인에 ${k} 없음`); return keychain[k]; },
      set: (k, v) => { keychain[k] = String(v); },
      remove: (k) => { delete keychain[k]; },
    };
    const fm = {
      documentsDirectory: () => "/docs",
      libraryDirectory: () => "/lib",
      joinPath: (a, b) => `${a.replace(/\/$/, "")}/${b}`,
      fileExists: (p) => p in files || Object.keys(files).some((f) => f.startsWith(p + "/")) || (env.dirs || []).includes(p),
      createDirectory: (p) => { (env.dirs = env.dirs || []).push(p); },
      readString: (p) => files[p],
      writeString: (p, s) => { files[p] = s; },
      remove: (p) => { delete files[p]; },
    };
    const FileManager = { local: () => fm, iCloud: () => fm };

    class Request {
      constructor(url) { this.url = url; this.method = "GET"; this.headers = {}; this.timeoutInterval = 60; this.response = null; }
      async loadString() {
        const path = this.url.replace("https://claude.ai", "");
        env.requests.push({ via: "request", path, method: this.method, headers: this.headers });
        const res = await env.api(path, { via: "request", headers: this.headers });
        this.response = { statusCode: res.status };
        return res.body;
      }
      async loadJSON() { return JSON.parse(await this.loadString()); }
    }

    // iOS WKWebView처럼 동작한다: 스크립트의 마지막 식 결과가 Promise 같은 객체면 실패한다.
    // env.webView: "ok" | "load-fails" | "fetch-blocked"(페이지 안 fetch가 막힘, 예: 보안 정책)
    class WebView {
      async loadURL(url) {
        if (env.webView === "load-fails") throw new Error("WebView를 쓸 수 없음");
        this.path = url.replace("https://claude.ai", "");
        env.requests.push({ via: "webview-page", path: this.path, method: "GET" });
        try { this.page = await env.api(this.path, { via: "webview-page" }); } catch (e) { this.page = { status: 0, body: "" }; }
      }
      async evaluateJavaScript(js, useCallback) {
        const page = this.page || { body: "" };
        const isJson = (() => { try { JSON.parse(page.body); return true; } catch (e) { return false; } })();
        const document = {
          cookie: env.webCookie || "",
          body: { innerText: isJson ? page.body : page.body.replace(/<[^>]+>/g, " ") },
          documentElement: { outerHTML: isJson ? `<html><body><pre>${page.body}</pre></body></html>` : page.body },
        };
        const fetch = async (path) => {
          if (env.webView === "fetch-blocked") throw new TypeError("Load failed");
          env.requests.push({ via: "webview-fetch", path, method: "GET" });
          const res = await env.api(path, { via: "webview-fetch" });
          return { status: res.status, text: async () => res.body };
        };
        return new Promise((resolve, reject) => {
          const completion = (v) => resolve(v);
          let result;
          try {
            result = new Function("fetch", "completion", "document", "__js", "return eval(__js)")(fetch, completion, document, js);
          } catch (e) {
            reject(e);
            return;
          }
          const supported = result === undefined || result === null || ["string", "number", "boolean"].includes(typeof result);
          if (!supported) reject(new Error("JavaScript execution returned a result of an unsupported type"));
          else if (!useCallback) resolve(result);
        });
      }
      async present() {}
    }

    const Timer = {
      schedule(ms, repeats, cb) {
        const id = setTimeout(cb, ms);
        return { invalidate: () => clearTimeout(id) };
      },
    };

    const globals = {
      Size, Point, Rect, Color, Font, Image, Path, DrawContext, SFSymbol, ListWidget, WidgetStack,
      Keychain, FileManager, Request, WebView, Timer,
      Device: {
        screenSize: () => new Size(393, 852),
        isUsingDarkAppearance: () => env.theme === "dark",
      },
      config: {
        runsInWidget: env.inWidget !== false,
        runsInApp: env.inWidget === false,
        runsInAccessoryWidget: String(env.family).startsWith("accessory"),
        widgetFamily: env.family,
      },
      args: { widgetParameter: env.widgetParameter || null },
      Script: { setWidget: (w) => { widget = w; }, complete: () => {} },
      Alert: class {
        addAction() {} addCancelAction() {} addDestructiveAction() {} addSecureTextField() {} addTextField() {}
        textFieldValue() { return ""; }
        async presentAlert() { (env.alerts = env.alerts || []).push(this.title); return -1; }
        async presentSheet() { (env.alerts = env.alerts || []).push(this.title); return -1; }
      },
      console: { log: (...a) => (env.logs = env.logs || []).push(a.join(" ")), error: (...a) => (env.logs = env.logs || []).push(a.join(" ")) },
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(...Object.keys(globals), code);
    await fn(...Object.values(globals));
    return widget;
  }

  window.ScriptableMock = { runScript, renderWidget, fitText, Color };
})();
