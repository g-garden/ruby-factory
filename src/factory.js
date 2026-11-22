// 工場の Canvas 描画。状態は持たず、毎フレーム ViewModel を受け取って絵と演出だけを進める。
// balance.js などは import せず、色や整形はこのファイル内で完結させる。

const STAGES = ["mine", "belt", "refinery", "dock"];
const STAGE_LABEL = { mine: "鉱山", belt: "ベルト", refinery: "工場", dock: "出荷" };

const C = {
  bgTop: "#0b0816", bgBot: "#171030", floor: "#1d1733", floorEdge: "#3a2f63", grid: "rgba(140,120,255,0.07)",
  ink: "#f2eeff", dim: "#a59ec6", faint: "#615a86", shadow: "rgba(0,0,0,0.45)",
  ruby: "#e0115f", gold: "#ffd34d", red: "#ff3355", warn: "#ffb020", ok: "#3ddc97", cyan: "#5ee7ff",
  rock: "#3b2d55", rockHi: "#5a4682", rockLo: "#251c39", cave: "#0a0712",
  steel: "#2e3a63", steelHi: "#46578f", steelLo: "#1b223f", glass: "#0e1430",
  wood: "#b47a3a", woodHi: "#dca15a", woodLo: "#734a20",
  truck: "#e0115f", truckLo: "#8f0b3c", tire: "#15121f",
  audit: "#b77bff", lamp: "#ffd27a",
};
// 普段のトラックと特注便（金色）の配色。描き方は同じで色だけ替える
const TRUCK_PAL = {
  normal: { bedBack: "#2a1530", front: C.truckLo, rim: C.truck, chassis: "#3a1030", cab: C.truck, glass: "#9fd8ff" },
  gold: { bedBack: "#3d2a08", front: "#b8860b", rim: "#ffe27a", chassis: "#5a3f0c", cab: "#f2b81f", glass: "#fff3c4" },
};
const GEM = {
  red: ["#ff7aa6", "#e0115f", "#7a0632"],
  blue: ["#8fbaff", "#2f6bff", "#142f73"],
  green: ["#7af5bd", "#14b874", "#09553a"],
};
// SPEC 5.4 の段階順（黄, 赤, 青, 紫, 赤熱, ルビー, ミスリル, 量子, 無限）
const BELT_COLORS = ["#f5c518", "#ff4d5e", "#3e8bff", "#a55cff", "#ff7a1a", "#e0115f", "#c9f3ff", "#7cf3c8", null];
const FINAL_TIER = BELT_COLORS.length - 1;   // 無限ベルト。2 車線はこの段でだけ描く（SPEC-rubyist 2.2 ページ 2）
const POP_TIERS = ["#ffd34d", "#ffb347", "#ff7ab6", "#b39bff", "#5ee7ff", "#ffffff"];

const SPRITE_MAX = 200;
const SPRITE_RATE_MAX = 20;      // これを超える流量は帯表現に切り替える（SPEC 9 章）
const BAND_EXIT = 16;            // 帯表現から戻るしきい値（境界でのちらつき防止）
const CRATE_SPRITE_RATE = 8;     // 帯表現中に箱スプライトとして出す上限（個/秒）
const POP_PER_SEC = 6;           // 出荷ポップの上限（SPEC 9 章）
const BN_HOLD = 1.5;             // 判子を移すまでの保持秒数（SPEC 8.2）
const PARTICLE_MAX = 420;
/** 動きを減らす設定のとき、4 つに 3 つを出さない飾りの粒 */
const REDUCED_DROP = new Set(["confetti", "spark", "star", "dust", "steam"]);
const BED_CAP = 8;
// 特注便の段取り（秒）: 普段のトラックが出る → 金色が来る → 停まって光る → 去る → 普段のトラックが戻る
const SD = { out: 0.5, in: 1.1, park: 2.6, leave: 3.1, back: 3.6 };
const SD_QUEUE_MAX = 3;
const OT_MAX = 600;              // 残業灯の残り秒の上限（時計の取り違えで出しっぱなしにしない）

const UNITS = ["", "K", "M", "B", "T", "Qa", "Qi"];
function fmt(n) {
  if (n === Infinity) return "∞";
  if (!Number.isFinite(n)) return "0";
  const a = Math.abs(n);
  if (a < 1000) return a < 10 && a % 1 >= 0.05 ? n.toFixed(1) : String(Math.round(n));
  let e = Math.floor(Math.log10(a) / 3);
  if (e >= UNITS.length) return n.toExponential(2).replace("e+", "e");
  let v = n / 1000 ** e;
  let s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  if (Number(s) >= 1000) {
    e += 1;
    if (e >= UNITS.length) return n.toExponential(2).replace("e+", "e");
    v = n / 1000 ** e;
    s = v.toFixed(2);
  }
  return s + UNITS[e];
}
const fmtRate = (n) => (n === Infinity ? "∞" : fmt(n) + "/s");

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInCubic = (t) => t * t * t;
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const num = (x, d) => (typeof x === "number" && !Number.isNaN(x) ? x : d);
const hash = (n) => {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

// ctx.filter は Safari で効かないので、彩度落ちは色を灰色へ混ぜて作る
const mixCache = new Map();
function desat(hex, k) {
  if (!hex || hex[0] !== "#" || k <= 0.02) return hex;
  const q = Math.round(clamp(k, 0, 1) * 20) / 20;
  const key = hex + q;
  let out = mixCache.get(key);
  if (out) return out;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const l = (0.3 * r + 0.59 * g + 0.11 * b) * 0.72 + 18;
  out = `rgb(${Math.round(lerp(r, l, q))},${Math.round(lerp(g, l, q))},${Math.round(lerp(b, l, q))})`;
  mixCache.set(key, out);
  return out;
}

// 研磨機の熱の色。冷えていれば青、熱いほど赤。20 段に丸めて文字列をキャッシュする（desat にもそのまま渡せる hex）
const HEAT_RED_AT = 128; // 1 バッチで傷物を全部磨く（128 回前後）と真っ赤
const heatCache = new Map();
function heatHex(cold, hot, h) {
  const q = Math.round(clamp(h, 0, 1) * 20) / 20;
  const key = cold + hot + q;
  let out = heatCache.get(key);
  if (out) return out;
  const ch = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  out = "#" + [0, 1, 2].map((i) => Math.round(lerp(ch(cold, i), ch(hot, i), q)).toString(16).padStart(2, "0")).join("");
  heatCache.set(key, out);
  return out;
}

function makePath(pts) {
  const segs = [];
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const l = Math.hypot(x1 - x0, y1 - y0) || 0.001;
    segs.push({ x0, y0, dx: (x1 - x0) / l, dy: (y1 - y0) / l, l, s: len });
    len += l;
  }
  return { segs, len };
}
function pathAt(p, d, out) {
  const segs = p.segs;
  let s = segs[segs.length - 1];
  for (let i = 0; i < segs.length; i++) {
    if (d <= segs[i].s + segs[i].l) { s = segs[i]; break; }
  }
  const t = clamp(d - s.s, 0, s.l);
  out.x = s.x0 + s.dx * t;
  out.y = s.y0 + s.dy * t;
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function gearPath(ctx, cx, cy, r, teeth, rot) {
  ctx.beginPath();
  const n = teeth * 2;
  for (let i = 0; i <= n; i++) {
    const a0 = rot + (i / n) * Math.PI * 2;
    const a1 = rot + ((i + 1) / n) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.74;
    if (i === 0) ctx.moveTo(cx + Math.cos(a0) * rr, cy + Math.sin(a0) * rr);
    else ctx.lineTo(cx + Math.cos(a0) * rr, cy + Math.sin(a0) * rr);
    ctx.lineTo(cx + Math.cos(a1) * rr, cy + Math.sin(a1) * rr);
  }
  ctx.closePath();
}

const MACHINE_KIND = {
  reject: "filter", select: "filter", filter: "filter", filter_map: "filter", find_all: "filter", compact: "filter", uniq: "filter",
  sort_by: "sort", sort: "sort", min_by: "sort", max_by: "sort", reverse: "sort", minmax: "sort",
  group_by: "group", partition: "group", chunk: "group", tally: "group", values: "group",
  each_slice: "slice", first: "slice", take: "slice", last: "slice",
  each_cons: "cons", chunk_while: "chain", slice_when: "chain",
  map: "arrow", flat_map: "arrow", collect: "arrow", to_a: "arrow", zip: "arrow", concat: "arrow", flatten: "arrow",
  polish: "spark", sum: "sum", count: "sum", inject: "sum", reduce: "sum",
};

export class FactoryView {
  constructor(canvas, { onStageClick, onMineClick, onShip } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onStageClick = onStageClick;
    this.onMineClick = onMineClick;
    this.onShip = onShip;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.t = 0;
    this.sprites = [];
    this.particles = [];
    this.pops = [];
    this.stamps = [];
    this.emitQueue = [];
    this.cele = null;
    this.shakeT = 0; this.shakeAmp = 0;
    this.oreAcc = 0; this.crateAcc = 0; this.chuteAcc = 0; this.spillAcc = 0; this.smokeAcc = 0;
    this.refIn = 0; this.pending = null; this.avgCells = 1;
    this.band = false; this.bandOff = 0; this.outBandOff = 0; this.beltOff = 0;
    this.popTokens = POP_PER_SEC; this.popOverflow = false; this.aggT = 0;
    this.bn = null; this.bnCand = null; this.bnCandT = 0; this.slamT = 9;
    this.pile = 0;
    this.k = { mine: 0, belt: 0, refinery: 0.85, dock: 0 };
    this.swing = 0; this.gearRot = 0; this.mineShake = 0;
    this.bedCount = 0; this.truckT = -1; this.truckBounce = 0;
    this.prevStatus = null; this.prevProgress = null; this.steamed = false; this.flashT = 9;
    this.dug = false;
    // 裏口ノートの演出（SPEC-rubyist 4.11）。this.lanes は原石の段積みで使っているので 2 車線は dual と呼ぶ
    this.special = null; this.specialQ = []; this.sdSparkAcc = 0;
    this.otAge = 0; this.otA = 0;
    this.sealA = 0; this.sealT = 9;
    this.heatA = 0; // 研磨機の熱（0〜1）。直近のバッチの研磨の回数へ少しずつ寄せる
    this.bgWins = [];
    this.vm = null;
    this.stats = { sprites: 0, particles: 0, frameMs: 0, maxSprites: 0 };
    this.imgCache = new Map();
    this._p = { x: 0, y: 0 };

    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onClick = (e) => this._click(e);
    this._onKey = (e) => this._key(e);
    canvas.addEventListener("pointerdown", this._onDown);
    canvas.addEventListener("pointermove", this._onMove);
    canvas.addEventListener("click", this._onClick);
    canvas.addEventListener("keydown", this._onKey);
    // 動きを減らす設定のときは、揺れと紙吹雪をやめ、飾りの粒も減らす
    this._reducedMq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    canvas.style.touchAction = "manipulation";
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
    }
    this.resize();
  }

  destroy() {
    this.canvas.removeEventListener("pointerdown", this._onDown);
    this.canvas.removeEventListener("pointermove", this._onMove);
    this.canvas.removeEventListener("click", this._onClick);
    this.canvas.removeEventListener("keydown", this._onKey);
    this._ro?.disconnect();
  }


  resize() {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (cw === this.w && ch === this.h && dpr === this.dpr && this.L) return;
    this.w = cw; this.h = ch; this.dpr = dpr;
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    this.imgCache.clear();
    this._layout();
    this._bakeBackground();
    // 経路が変わるのでレーン上のスプライトは捨てる（粒子とポップは座標のまま流す）
    this.sprites.length = 0;
    this.refIn = 0;
    this.warm = false;
  }

  dig() { this._dig(null, null); }

  popMoney(amount, at = "dock") {
    if (!this.L) return;
    const L = this.L;
    const x = at === "mine" ? L.mine.cx : L.truck.bedX + L.truck.bedW / 2;
    const y = at === "mine" ? L.mine.peakY + 6 * L.u : L.truck.bedY - 14 * L.u;
    this._addPop("+$" + fmt(amount), amount, x, y, 1.15);
  }

  get reducedMotion() {
    return !!this._reducedMq?.matches;
  }

  celebrate(text) {
    this.cele = { text: String(text || "NEW RECORD"), age: 0, life: 2.4 };
    this._shake(0.45, 5);
    if (!this.L || this.reducedMotion) return;
    for (let i = 0; i < 70; i++) {
      this._particle({
        type: "confetti", x: rnd(0, this.w), y: rnd(-30, 0), vx: rnd(-40, 40), vy: rnd(40, 140),
        life: rnd(1.4, 2.4), size: rnd(3, 6) * Math.max(0.7, this.L.u), color: pick([C.gold, C.ruby, C.cyan, "#ffffff", "#b39bff"]),
        rot: rnd(0, 6), vr: rnd(-8, 8), g: 90,
      });
    }
  }

  stamp(text, stage = "dock") {
    const audit = /AUDIT/i.test(text);
    const color = audit ? C.audit : /PERFECT|クリスマス|^BOX /i.test(text) ? C.gold : /RECORD/i.test(text) ? C.cyan : C.ruby;
    this.stamps.push({ text: String(text), stage: STAGES.includes(stage) ? stage : "dock", age: 0, life: audit ? 2.2 : 1.7, color });
    if (this.stamps.length > 6) this.stamps.shift();
    if (audit) this._shake(0.2, 3);
  }

  /** 金色の特注便のトラックがドックに来て走り去る（クリスマス便の見せ場）。label は幟の文字 */
  specialDelivery(label = "") {
    const item = { label: String(label ?? ""), age: 0 };
    if (!this.special) this.special = item;
    else if (this.specialQ.length < SD_QUEUE_MAX) this.specialQ.push(item);
  }

  frame(dt, vm) {
    const t0 = performance.now();
    // 単位は秒。ms を渡されても破綻しないよう 1 を超える値は ms とみなし、タブ復帰時の巨大な dt は切る
    dt = num(dt, 0);
    if (dt > 1) dt /= 1000;
    dt = clamp(dt, 0, 0.1);
    if (Math.min(3, window.devicePixelRatio || 1) !== this.dpr) this.resize();
    if (!this.L) { this.resize(); if (!this.L) return; }
    const v = this._norm(vm || {});
    this.vm = v;
    if (!this.warm) { this.warm = true; this._prewarm(v); }
    this.t += dt;
    this._update(dt, v);
    this._draw(v);
    const ms = performance.now() - t0;
    this.stats.frameMs = this.stats.frameMs * 0.9 + ms * 0.1;
    this.stats.sprites = this.sprites.length;
    this.stats.particles = this.particles.length;
    if (this.sprites.length > this.stats.maxSprites) this.stats.maxSprites = this.sprites.length;
  }


  _stageAt(x) {
    const L = this.L;
    if (!L) return null;
    if (x < L.mine.x1) return "mine";
    if (x < L.belt.x1) return "belt";
    if (x < L.ref.x1) return "refinery";
    return "dock";
  }
  // 鉱山は連打の手応えを優先して pointerdown、他の工程はスマホで Canvas からスクロールを始めたときに
  // 誤爆しないよう click で拾う。同じ工程を両方で拾わないこと
  _pointerDown(e) {
    if (e.button !== undefined && e.button > 0) return;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (this._stageAt(x) !== "mine" || this._onMineStamp(y)) return;
    this._dig(x, y);
    this.onMineClick?.();
  }
  _click(e) {
    const r = this.canvas.getBoundingClientRect();
    const st = this._stageAt(e.clientX - r.left);
    if (st === "mine") {
      if (this._onMineStamp(e.clientY - r.top)) this.onStageClick?.("mine");
      return;
    }
    if (st) this.onStageClick?.(st);
  }
  // 鉱山はクリックが手掘りなので、赤いときは BOTTLENECK 判子の帯（上部）だけを診断カードの入口にする
  _onMineStamp(y) {
    if (this.bn !== "mine" || !this.L) return false;
    return y < this._stampPos("mine").y + Math.max(16, 22 * this.L.u);
  }
  // キーボードで掘る（canvas にフォーカスがあるとき）。押しっぱなしの自動の繰り返しは数えない（連打の代わりにならないように）
  _key(e) {
    // Cmd/Ctrl+Enter はエディタのデプロイと同じ操作なので、押し間違えても掘らない
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.repeat) return;
    this._dig(null, null);
    this.onMineClick?.();
  }
  _pointerMove(e) {
    const r = this.canvas.getBoundingClientRect();
    this.hoverStage = this._stageAt(e.clientX - r.left);
    this.canvas.style.cursor = this.hoverStage ? "pointer" : "default";
  }


  _layout() {
    const W = this.w, H = this.h;
    const u = clamp(Math.min(H / 280, W / 720), 0.5, 1.5);
    const floorY = Math.round(H * 0.69);
    const beltY = floorY - Math.max(8, 13 * u);
    const barY = floorY + Math.max(7, H * 0.055);
    const barH = Math.max(4, 5 * u);
    const font = Math.max(10, Math.round(11.5 * u));
    const labelY = barY + barH + font + 2;
    const fx = (f) => Math.round(W * f);
    const col = (x0, x1) => ({ x0, x1, w: x1 - x0, cx: (x0 + x1) / 2 });
    const mine = col(fx(0.012), fx(0.175));
    const belt = col(mine.x1, fx(0.5));
    const ref = col(belt.x1, fx(0.71));
    const outb = col(ref.x1, fx(0.785));
    const dock = col(outb.x1, fx(0.988));
    const oreR = Math.max(3.6, 6 * u);
    const crateS = Math.max(9, 15 * u);

    mine.peakY = Math.round(floorY - H * 0.47);
    mine.mouthX = mine.x1 - mine.w * 0.2;
    mine.mouthW = mine.w * 0.34;
    mine.mouthH = Math.max(14, (floorY - mine.peakY) * 0.34);
    belt.start = mine.x1 - mine.w * 0.12;

    const bodyTop = Math.round(floorY - H * 0.42);
    ref.bx0 = ref.x0 + Math.max(4, 7 * u);
    ref.bx1 = ref.x1 - Math.max(4, 7 * u);
    ref.top = bodyTop;
    ref.inX = ref.bx0 + 2;
    ref.outX = ref.bx1 - 2;
    ref.chX = ref.bx0 + (ref.bx1 - ref.bx0) * 0.16;
    ref.chW = Math.max(8, (ref.bx1 - ref.bx0) * 0.13);
    ref.chTop = bodyTop - Math.max(10, H * 0.09);
    const winPad = Math.max(4, 7 * u);
    ref.win = { x: ref.bx0 + winPad, y: bodyTop + winPad, w: ref.bx1 - ref.bx0 - winPad * 2, h: Math.max(16, (beltY - bodyTop) * 0.48) };
    ref.signY = ref.win.y + ref.win.h + Math.max(3, 5 * u);

    const tw = Math.min(dock.w - 8 * u, 132 * u);
    const tx = dock.x0 + Math.max(3, 5 * u);
    const wheelR = Math.max(3, 5.5 * u);
    const truck = {
      x: tx, w: tw, wheelR,
      bedX: tx, bedW: tw * 0.62, bedY: beltY - Math.max(5, 8 * u), bedFloor: beltY + 1, baseY: floorY - wheelR * 1.15,
    };
    truck.cabX = tx + tw * 0.65;
    truck.cabW = tw * 0.35;
    truck.cabTop = beltY - Math.max(13, 22 * u);
    dock.roofY = Math.round(lerp(bodyTop, beltY, 0.18));

    // 2 車線の奥の帯の高さ。手前の帯の原石（2 段まで）に被らない分だけ上げる
    const dualY = Math.round(beltY - Math.max(8, 8 * u) - oreR * 3.9);
    this.L = {
      W, H, u, floorY, beltY, dualY, barY, barH, font, labelY, oreR, crateS,
      mine, belt, ref, outb, dock, truck,
      cols: { mine, belt, refinery: ref, dock },
    };
    const oy = beltY - oreR * 0.92;
    const cy = beltY - crateS / 2;
    const chuteY = beltY + Math.max(5, 9 * u);
    this.P = {
      main: makePath([[belt.start, oy], [ref.inX, oy]]),
      out: makePath([[ref.outX, cy], [truck.bedX + truck.bedW * 0.5, cy]]),
      chute: makePath([[ref.inX - 6 * u, oy], [ref.inX + 4 * u, chuteY - oreR], [truck.bedX + truck.bedW * 0.45, chuteY - oreR]]),
    };
  }

  _bakeBackground() {
    const { W, H, floorY, u } = this.L;
    const c = document.createElement("canvas");
    c.width = Math.round(W * this.dpr);
    c.height = Math.round(H * this.dpr);
    const g = c.getContext("2d");
    g.scale(this.dpr, this.dpr);
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, C.bgTop);
    sky.addColorStop(1, C.bgBot);
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 60; i++) {
      const x = hash(i * 7 + 1) * W, y = hash(i * 13 + 5) * floorY * 0.7;
      g.fillStyle = `rgba(220,210,255,${0.15 + hash(i) * 0.35})`;
      g.fillRect(x, y, 1.2, 1.2);
    }
    g.fillStyle = "#140f26";
    let x = 0;
    let i = 0;
    // 遠景のビルの窓（残業灯で点ける）。焼き込みとは別に位置だけ覚えておく
    const wins = [];
    const ws = Math.max(2, 3 * u), wh = Math.max(2.5, 4 * u);
    let slot = 0;
    while (x < W) {
      const bw = (30 + hash(i * 3 + 11) * 60) * Math.max(0.6, u);
      const bh = (20 + hash(i * 5 + 3) * 50) * Math.max(0.6, u);
      g.fillRect(x, floorY - bh, bw - 4, bh);
      if (hash(i + 99) > 0.55) g.fillRect(x + bw * 0.3, floorY - bh - 18 * u, 5 * u, 18 * u);
      const sx = 7 * Math.max(0.6, u), sy = 9 * Math.max(0.6, u);
      for (let wy = floorY - bh + sy * 0.6; wy < floorY - sy * 0.8; wy += sy) {
        for (let wx = x + sx * 0.6; wx < x + bw - 4 - sx * 0.6; wx += sx) {
          const seed = ++slot * 7 + 3;
          if (hash(seed + 17) > 0.5 && wins.length < 500) wins.push({ x: wx, y: wy, w: ws, h: wh, seed });
        }
      }
      x += bw;
      i++;
    }
    this.bgWins = wins;
    g.fillStyle = C.floor;
    g.fillRect(0, floorY, W, H - floorY);
    g.fillStyle = C.floorEdge;
    g.fillRect(0, floorY, W, Math.max(1, 1.5 * u));
    g.strokeStyle = C.grid;
    g.lineWidth = 1;
    for (let gx = -W; gx < W * 2; gx += 26 * Math.max(0.6, u)) {
      g.beginPath();
      g.moveTo(gx, floorY);
      g.lineTo(W / 2 + (gx - W / 2) * 1.8, H);
      g.stroke();
    }
    this.bg = c;
  }


  _norm(vm) {
    const caps = vm.caps || {};
    const flow = Math.max(0, num(vm.flow, 0));
    const capOf = (k, d) => Math.max(0, num(caps[k], d));
    const c = { mine: capOf("mine", 0), belt: capOf("belt", 0), refinery: capOf("refinery", Infinity), dock: capOf("dock", Infinity) };
    const util = {};
    for (const s of STAGES) {
      const u = vm.util ? num(vm.util[s], NaN) : NaN;
      util[s] = clamp(Number.isNaN(u) ? (c[s] === Infinity || c[s] === 0 ? 0 : flow / c[s]) : u, 0, 1);
    }
    const passthrough = !!vm.passthrough;
    const colors = Array.isArray(vm.colors) ? vm.colors.filter((k) => GEM[k]) : [];
    const beltTier = clamp(num(vm.beltTier, 0) | 0, 0, BELT_COLORS.length - 1);
    return {
      // 裏口（SPEC-rubyist 4.11）。どれも省略可。2 車線は無限ベルトのときだけ描く（青ベルトで 2 を渡されても 1 本）
      lanes: num(vm.lanes, 1) >= 2 ? 2 : 1,
      dual: num(vm.lanes, 1) >= 2 && beltTier === FINAL_TIER,
      nightShift: !!vm.nightShift,
      overtimeLeft: this._overtimeLeft(vm.overtimeUntil),
      audited: !!vm.audited,
      // 直近のバッチで polish を呼んだ回数（研磨機の熱）。省略可
      polishHeat: Math.max(0, num(vm.polishHeat, 0)),
      flow, caps: c, util,
      bottleneck: STAGES.includes(vm.bottleneck) ? vm.bottleneck : null,
      backlog: clamp(num(vm.backlog, 0), 0, 200),
      spill: Math.max(0, num(vm.spill, 0)),
      passthrough,
      status: vm.refineryStatus || (passthrough ? "passthrough" : "running"),
      label: vm.refineryLabel ? String(vm.refineryLabel) : "",
      // 研磨機（polish）は熱で光るので、札が「+6」に隠れないよう先頭に出す
      machines: Array.isArray(vm.machines) ? (vm.machines.includes("polish") ? ["polish", ...vm.machines.filter((m) => m !== "polish")] : vm.machines) : [],
      colors: colors.length ? colors : ["red"],
      beltTier,
      crateFeed: typeof vm.crateFeed === "function" ? vm.crateFeed : null,
      vmProgress: typeof vm.vmProgress === "number" && Number.isFinite(vm.vmProgress) ? clamp(vm.vmProgress, 0, 1) : null,
      incomePerSec: Math.max(0, num(vm.incomePerSec, flow)),
    };
  }

  // overtimeUntil の時計は performance.now()（ミリ秒）。Date.now() の値を渡されても桁で見分ける
  _overtimeLeft(until) {
    if (typeof until !== "number" || !Number.isFinite(until)) return 0;
    const now = until > 1e11 ? Date.now() : performance.now();
    return clamp((until - now) / 1000, 0, OT_MAX);
  }

  _pull(v) {
    let item = null;
    try { item = v.crateFeed ? v.crateFeed() : null; } catch { item = null; }
    if (!item || !Array.isArray(item.cells) || item.cells.length === 0) {
      const color = pick(v.colors);
      const per = v.flow > 0 ? v.incomePerSec / v.flow : 1;
      item = v.passthrough
        ? { raw: true, value: 1, cells: [{ color, carat: 1 + ((Math.random() * 9) | 0), flaw: Math.random() < 0.25 }], bonuses: [] }
        : { value: per, cells: [{ color, carat: 5, flaw: false }], bonuses: [] };
    }
    this.avgCells = lerp(this.avgCells, item.cells.length, 0.15);
    return item;
  }


  _update(dt, v) {
    const L = this.L;
    const u = L.u;
    const flow = v.flow;

    if (!this.band && flow > SPRITE_RATE_MAX) this.band = true;
    else if (this.band && flow < BAND_EXIT) this.band = false;

    const speed = this._speed(flow);
    if (flow > 0) this.beltOff += speed * dt;
    this.bandOff += speed * 1.25 * dt;
    this.outBandOff += speed * 1.1 * dt;

    // ボトルネックの判子（1.5 秒ヒステリシス）。素通し中は鉱山が常に最小になるだけなので出さない
    const target = v.passthrough ? null : v.bottleneck;
    if (target !== this.bn) {
      if (this.bn === null || target === null) {
        this._moveBottleneck(target);
      } else if (this.bnCand !== target) {
        this.bnCand = target; this.bnCandT = 0;
      } else if ((this.bnCandT += dt) >= BN_HOLD) {
        this._moveBottleneck(target);
      }
    } else {
      this.bnCand = null;
    }
    const prevSlam = this.slamT;
    this.slamT += dt;
    if (prevSlam < 0.16 && this.slamT >= 0.16 && this.bn) this._slamDust();

    // 判子の移動待ちの間は、旧工程の山を新工程の backlog で動かさない（移動時の一気流しにその量を使う）
    if (target === this.bn) {
      const pileTarget = this.bn && this.bn !== "mine" ? v.backlog : 0;
      this.pile = lerp(this.pile, pileTarget, 1 - Math.exp(-dt * 3));
    }

    const bi = this.bn ? STAGES.indexOf(this.bn) : -1;
    for (let i = 0; i < STAGES.length; i++) {
      const s = STAGES[i];
      let tk = bi > 0 && i < bi ? 0.55 : 0;
      if (s === "refinery") {
        if (v.status === "passthrough" || v.status === "booting") tk = 0.88;
        else if (v.status === "restarting") tk = Math.max(tk, 0.6);
      }
      this.k[s] = lerp(this.k[s], tk, 1 - Math.exp(-dt * 4));
    }

    this._statusTransitions(v);

    const mineRate = v.caps.mine;
    const swingHz = clamp(0.7 + Math.log2(1 + mineRate) * 0.45, 0.7, 4.5);
    const prevSw = this.swing;
    this.swing += dt * swingHz;
    if (Math.floor(prevSw) !== Math.floor(this.swing)) {
      const hx = L.mine.mouthX - L.mine.mouthW * 0.15, hy = L.beltY - 6 * u;
      for (let i = 0; i < 3; i++) this._particle({ type: "spark", x: hx, y: hy, vx: rnd(-60, 30), vy: rnd(-90, -30), life: 0.35, size: 1.6, color: C.gold, g: 260 });
    }
    this.mineShake = Math.max(0, this.mineShake - dt);

    // 研磨機の熱は動いている間だけ。止まると冷める
    const heatTarget = v.status === "running" ? clamp(v.polishHeat / HEAT_RED_AT, 0, 1) : 0;
    this.heatA = lerp(this.heatA, heatTarget, 1 - Math.exp(-dt * 2));

    const gearSpeed = v.status === "running" ? 1.2 + v.util.refinery * 4 : v.status === "restarting" ? 0.4 : 0;
    this.gearRot += gearSpeed * dt;

    if (this.prevPass === true && !v.passthrough) {
      const to = { x: (L.ref.bx0 + L.ref.bx1) / 2, y: (L.ref.top + L.beltY) / 2 };
      for (const s of this.sprites) {
        if (s.kind !== "chute") continue;
        pathAt(s.path, s.d, this._p);
        this._particle({ type: "gem", sx: this._p.x, sy: this._p.y, x: this._p.x, y: this._p.y, target: to, arc: rnd(10, 30) * u, life: rnd(0.3, 0.6), color: s.color, size: L.oreR });
        s.dead = true;
      }
      this.sprites = this.sprites.filter((s) => !s.dead);
    }
    this.prevPass = v.passthrough;

    // 原石の生成。間隔が宝石の幅より詰まる流量では、ベルトの上に段を重ねて並べる
    const perLane = speed / (L.oreR * 2.3);
    this.lanes = clamp(Math.ceil(flow / (v.dual ? 2 : 1) / perLane), 1, 3);
    let spawnRate = 0;
    if (!this.band) spawnRate = flow;
    this.oreAcc = Math.min(this.oreAcc + spawnRate * dt, 3);
    while (this.oreAcc >= 1) {
      this.oreAcc -= 1;
      if (this.sprites.length < SPRITE_MAX) this._spawnOre(v);
    }

    if (this.band) {
      if (v.passthrough) {
        this.chuteAcc = Math.min(this.chuteAcc + Math.min(flow, CRATE_SPRITE_RATE) * dt, 3);
        while (this.chuteAcc >= 1) {
          this.chuteAcc -= 1;
          if (this.sprites.length < SPRITE_MAX) this._spawnChute(v, this._pull(v));
        }
      } else {
        const crateRate = flow / Math.max(1, this.avgCells);
        this.crateAcc = Math.min(this.crateAcc + Math.min(crateRate, CRATE_SPRITE_RATE) * dt, 3);
        while (this.crateAcc >= 1) {
          this.crateAcc -= 1;
          if (this.sprites.length < SPRITE_MAX) this._spawnCrate(this._pull(v));
        }
      }
    }

    for (let i = this.emitQueue.length - 1; i >= 0; i--) {
      const q = this.emitQueue[i];
      q.t -= dt;
      if (q.t <= 0) {
        this.emitQueue.splice(i, 1);
        if (this.sprites.length < SPRITE_MAX) this._spawnCrate(q.item);
      }
    }

    const P = this.P;
    let w = 0;
    for (let i = 0; i < this.sprites.length; i++) {
      const s = this.sprites[i];
      s.age += dt;
      let keep = true;
      if (s.kind === "drop") {
        s.t += dt / s.dur;
        if (s.t >= 1) {
          s.kind = "ore"; s.path = P.main; s.d = Math.max(0, s.x1 - L.belt.start);
          for (let j = 0; j < 4; j++) this._particle({ type: "dust", x: s.x1, y: L.beltY, vx: rnd(-30, 30), vy: rnd(-30, -5), life: 0.4, size: 3 * u, color: "rgba(200,180,255,0.5)", g: 60, grow: 6 });
        }
      } else {
        s.d += speed * (s.kind === "chute" ? 1.15 : 1) * dt;
        if (s.d >= s.path.len) keep = this._arrive(s, v);
      }
      if (keep) this.sprites[w++] = s;
    }
    this.sprites.length = w;

    if (v.spill > 0 && this.bn && this.bn !== "mine") {
      this.spillAcc = Math.min(this.spillAcc + Math.min(v.spill, 14) * dt, 3);
      while (this.spillAcc >= 1) {
        this.spillAcc -= 1;
        const pp = this._pilePos();
        const isCrate = this.bn === "dock";
        this._particle({
          type: isCrate ? "crate" : "gem", x: pp.x + rnd(-8, 8) * u, y: pp.y - rnd(4, 14) * u,
          vx: rnd(-30, 30) * u, vy: rnd(-40, -10) * u, g: 380 * Math.max(0.6, u), life: 1.1,
          color: pick(v.colors), size: isCrate ? L.crateS * 0.7 : L.oreR * 0.85, floor: L.floorY + 6 * u, rot: rnd(0, 6), vr: rnd(-6, 6),
        });
      }
    }

    const chx = L.ref.chX + L.ref.chW / 2, chy = L.ref.chTop;
    let smokeRate = 0, smokeColor = "";
    if (v.status === "overheat") {
      smokeRate = 16; smokeColor = "rgba(58,50,62,0.92)";
      if (Math.random() < dt * 10) this._particle({ type: "spark", x: chx + rnd(-3, 3), y: chy, vx: rnd(-15, 25), vy: rnd(-70, -30), life: 0.9, size: 2, color: pick(["#ff7a2a", "#ffb347", "#ff3b1f"]), g: -10 });
    }
    else if (v.status === "restarting") { smokeRate = 7; smokeColor = "rgba(160,150,180,0.55)"; }
    else if (v.status === "jam") { smokeRate = 3; smokeColor = "rgba(90,80,100,0.6)"; }
    else if (v.status === "running" && v.util.refinery > 0.05) { smokeRate = 1.2 + v.util.refinery * 2.5; smokeColor = "rgba(230,225,255,0.22)"; }
    this.smokeAcc = Math.min(this.smokeAcc + smokeRate * dt, 3);
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      this._particle({ type: "smoke", x: chx + rnd(-2, 2) * u, y: chy, vx: rnd(4, 18) * u, vy: rnd(-34, -20) * u, life: rnd(1.4, 2.2), size: rnd(4, 6) * u, grow: 12 * u, color: smokeColor });
    }

    let pw = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      if (p.target) {
        const k = easeInCubic(clamp(p.age / p.life, 0, 1));
        p.x = lerp(p.sx, p.target.x, k); p.y = lerp(p.sy, p.target.y, k) - Math.sin(k * Math.PI) * p.arc;
      } else {
        p.vy += (p.g || 0) * dt;
        if (p.type === "smoke" || p.type === "steam") { p.vx *= 1 - dt * 0.6; p.vy *= 1 - dt * 0.4; }
        if (p.type === "confetti") { p.vx += Math.sin(this.t * 3 + p.rot) * 30 * dt; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.floor && p.y > p.floor) { p.y = p.floor; p.vy *= -0.3; p.vx *= 0.6; }
      }
      if (p.vr) p.rot += p.vr * dt;
      this.particles[pw++] = p;
    }
    this.particles.length = pw;

    this.popTokens = Math.min(POP_PER_SEC, this.popTokens + POP_PER_SEC * dt);
    this.aggT += dt;
    if (this.aggT >= 1) {
      this.aggT = 0;
      if ((this.popOverflow || (this.band && !v.passthrough)) && v.incomePerSec > 0) {
        this._addPop("+$" + fmt(v.incomePerSec) + "/s", v.incomePerSec, L.dock.cx, L.dock.roofY - 8 * u, 1.2, true);
      }
      this.popOverflow = false;
    }
    let qw = 0;
    for (let i = 0; i < this.pops.length; i++) {
      const p = this.pops[i];
      p.age += dt;
      if (p.age < p.life) this.pops[qw++] = p;
    }
    this.pops.length = qw;

    for (const s of this.stamps) s.age += dt;
    this.stamps = this.stamps.filter((s) => s.age < s.life);
    if (this.cele) { this.cele.age += dt; if (this.cele.age > this.cele.life) this.cele = null; }
    this.shakeT = Math.max(0, this.shakeT - dt);
    this.truckBounce = Math.max(0, this.truckBounce - dt);
    this.flashT += dt;

    if (this.truckT >= 0) {
      this.truckT += dt;
      if (this.truckT > 1.4) this.truckT = -1;
      else if (this.truckT > 0.7 && this.bedCount > 0) this.bedCount = 0;
    } else if (this.bedCount >= BED_CAP) {
      this.truckT = 0;
    }

    this._updateBackdoor(dt, v);
  }

  _updateBackdoor(dt, v) {
    const L = this.L, u = L.u;
    // 残業灯: 点くときは 0.4 秒でふわっと、消えるときは最後の 1.5 秒で落とす
    if (v.overtimeLeft > 0) {
      this.otAge += dt;
      this.otA = Math.min(1, this.otAge / 0.4) * Math.min(1, v.overtimeLeft / 1.5);
    } else {
      this.otAge = 0;
      this.otA = 0;
    }
    // AUDITED の常設の判子。立ち上がりで小さく押し直す
    if (v.audited && this.sealA === 0) this.sealT = 0;
    this.sealA = v.audited ? Math.min(1, this.sealA + dt * 6) : Math.max(0, this.sealA - dt * 2);
    this.sealT += dt;

    const sp = this.special;
    if (!sp) return;
    sp.age += dt;
    if (sp.age >= SD.back) {
      this.special = this.specialQ.shift() || null;
      return;
    }
    const T = L.truck;
    if (sp.age >= SD.in - 0.05 && !sp.landed) {
      sp.landed = true;
      this._shake(0.12, 1.6);
      for (let i = 0; i < 18; i++) {
        const a = rnd(0, Math.PI * 2);
        this._particle({ type: "star", x: T.x + T.w * 0.4, y: T.bedY, vx: Math.cos(a) * rnd(50, 140), vy: Math.sin(a) * rnd(40, 120) - 40, life: 0.8, size: 3.4 * Math.max(0.7, u), color: C.gold, g: 90 });
      }
    }
    if (sp.age >= SD.in && sp.age < SD.park) {
      this.sdSparkAcc = Math.min(this.sdSparkAcc + 10 * dt, 3);
      while (this.sdSparkAcc >= 1) {
        this.sdSparkAcc -= 1;
        this._particle({ type: "star", x: T.x + rnd(0, T.w), y: rnd(T.cabTop, T.baseY), vx: rnd(-10, 10), vy: rnd(-40, -15), life: rnd(0.5, 0.9), size: rnd(1.8, 3) * Math.max(0.7, u), color: pick([C.gold, "#fff6c8"]), g: 0 });
      }
    }
  }

  // 特注便のトラックのずれ（右へ走り去る量）。普段のトラックと金色のトラックの両方
  _specialOffsets() {
    const sp = this.special;
    if (!sp || !this.L) return null;
    const L = this.L;
    const dist = L.W - L.truck.x + 10;
    const t = sp.age;
    let normal = 0, gold = dist;
    if (t < SD.out) normal = easeInCubic(t / SD.out) * dist;
    else if (t < SD.leave) normal = dist;
    else normal = (1 - easeOutCubic(clamp((t - SD.leave) / (SD.back - SD.leave), 0, 1))) * dist;
    if (t >= SD.out && t < SD.in) gold = (1 - easeOutCubic((t - SD.out) / (SD.in - SD.out))) * dist;
    else if (t >= SD.in && t < SD.park) gold = 0;
    else if (t >= SD.park && t < SD.leave) gold = easeInCubic((t - SD.park) / (SD.leave - SD.park)) * dist;
    return { normal, gold, dist };
  }

  _speed(flow) {
    return 80 * Math.max(0.6, this.L.u) * (1 + 0.22 * Math.log10(1 + flow));
  }

  // 開いた直後やリサイズ直後にベルトが空にならないよう、いまの流量で並べておく
  _prewarm(v) {
    if (this.band || v.flow <= 0 || v.flow > SPRITE_RATE_MAX) return;
    const speed = this._speed(v.flow);
    const P = this.P;
    const n = Math.min(40, Math.floor((v.flow * P.main.len) / speed));
    for (let i = 0; i < n; i++) {
      this._spawnOre(v);
      this.sprites[this.sprites.length - 1].d = P.main.len * ((i + Math.random() * 0.5) / Math.max(1, n));
      this.sprites[this.sprites.length - 1].age = 1;
    }
    if (v.passthrough) {
      const m = Math.min(20, Math.floor((v.flow * P.chute.len) / (speed * 1.15)));
      for (let i = 0; i < m; i++) {
        this._spawnChute(v, this._pull(v));
        const s = this.sprites[this.sprites.length - 1];
        s.d = P.chute.len * ((i + 0.5) / Math.max(1, m));
        s.age = 1;
      }
    } else {
      const m = Math.min(10, Math.floor((v.flow / Math.max(1, this.avgCells)) * (P.out.len / speed)));
      for (let i = 0; i < m; i++) {
        this._spawnCrate(this._pull(v));
        const s = this.sprites[this.sprites.length - 1];
        s.d = P.out.len * ((i + 0.5) / Math.max(1, m));
        s.age = 1;
      }
    }
  }

  _statusTransitions(v) {
    const L = this.L;
    const st = v.status;
    const prog = v.vmProgress;
    const done = (this.prevProgress !== null && (prog === null || prog >= 1)) || (this.prevStatus === "booting" && st !== "booting");
    if (done && !this.steamed) { this._steam(26); this.steamed = true; }
    if (prog !== null && prog < 1) this.steamed = false;
    if (this.prevStatus && this.prevStatus !== st) {
      if ((this.prevStatus === "passthrough" || this.prevStatus === "booting") && st === "running") {
        this.flashT = 0;
        const r = L.ref;
        for (let i = 0; i < 26; i++) {
          const a = rnd(0, Math.PI * 2);
          this._particle({ type: "spark", x: (r.bx0 + r.bx1) / 2, y: (r.top + L.beltY) / 2, vx: Math.cos(a) * rnd(60, 160), vy: Math.sin(a) * rnd(60, 160), life: 0.6, size: 2, color: pick([C.gold, C.ruby, "#ffffff"]), g: 120 });
        }
      }
      if (this.prevStatus === "restarting" && st !== "restarting") this._steam(12);
    }
    this.prevStatus = st;
    this.prevProgress = prog;
  }

  _moveBottleneck(target) {
    if (this.bn && this.bn !== "mine" && this.pile > 4) {
      const from = this._pilePos();
      const to = this.bn === "refinery" ? { x: this.L.ref.inX + 6, y: this.L.beltY - 6 }
        : this.bn === "dock" ? { x: this.L.truck.bedX + this.L.truck.bedW / 2, y: this.L.truck.bedY }
          : { x: this.L.ref.inX - 10, y: this.L.beltY - 6 };
      const n = Math.min(40, Math.round(this.pile));
      for (let i = 0; i < n; i++) {
        this._particle({
          type: this.bn === "dock" ? "crate" : "gem", sx: from.x + rnd(-14, 14) * this.L.u, sy: from.y - rnd(0, 18) * this.L.u, x: from.x, y: from.y,
          target: to, arc: rnd(4, 26) * this.L.u, life: 0.25 + (i / n) * 1.25, color: pick(this.vm?.colors || ["red"]),
          size: this.bn === "dock" ? this.L.crateS * 0.75 : this.L.oreR,
        });
      }
    }
    this.bn = target;
    this.bnCand = null;
    this.pile = 0;
    if (target) this.slamT = 0;
  }

  _slamDust() {
    const p = this._stampPos(this.bn);
    this._shake(0.14, 2.2);
    for (let i = 0; i < 12; i++) {
      const a = rnd(0, Math.PI * 2);
      this._particle({ type: "dust", x: p.x + Math.cos(a) * 30 * this.L.u, y: p.y + Math.sin(a) * 10 * this.L.u, vx: Math.cos(a) * 70, vy: Math.sin(a) * 30, life: 0.45, size: 3 * this.L.u, grow: 10 * this.L.u, color: "rgba(255,80,110,0.35)" });
    }
  }

  _steam(n) {
    const L = this.L;
    const chx = L.ref.chX + L.ref.chW / 2;
    for (let i = 0; i < n; i++) {
      this._particle({ type: "steam", x: chx + rnd(-3, 3), y: L.ref.chTop, vx: rnd(-50, 70) * L.u, vy: rnd(-110, -35) * L.u, life: rnd(1.0, 2.0), size: rnd(3, 7) * L.u, grow: 30 * L.u, color: "rgba(255,255,255,0.42)" });
    }
  }

  _shake(t, amp) {
    if (this.reducedMotion) return;
    this.shakeAmp = this.shakeT > 0 ? Math.max(this.shakeAmp, amp) : amp;
    this.shakeT = Math.max(this.shakeT, t);
  }

  _particle(p) {
    if (this.particles.length >= PARTICLE_MAX) return;
    if (this.reducedMotion && REDUCED_DROP.has(p.type) && Math.random() < 0.75) return;
    p.age = 0;
    this.particles.push(p);
  }

  _spawnOre(v) {
    const color = pick(v.colors);
    this.laneIdx = ((this.laneIdx || 0) + 1) % 840;
    // 2 車線のときは手前と奥の帯に交互に載せる
    const back = v.dual ? this.laneIdx % 2 : 0;
    const lane = Math.floor(this.laneIdx / (v.dual ? 2 : 1)) % (this.lanes || 1);
    this.sprites.push({
      kind: "ore", path: this.P.main, d: 0, age: 0,
      color, carat: 1 + ((Math.random() * 9) | 0), flaw: Math.random() < 0.25,
      jy: -lane * this.L.oreR * 1.3 - back * (this.L.beltY - this.L.dualY),
    });
  }

  _spawnChute(v, item) {
    const c = item.cells[0] || { color: pick(v.colors), carat: 5, flaw: false };
    this.sprites.push({ kind: "chute", path: this.P.chute, d: 0, age: 0, color: GEM[c.color] ? c.color : "red", carat: c.carat, flaw: !!c.flaw && !c.polished, item, jy: 0 });
  }

  _spawnCrate(item) {
    this.sprites.push({ kind: "crate", path: this.P.out, d: 0, age: 0, item, jy: 0 });
  }

  _dig(x, y) {
    if (!this.L) return;
    const L = this.L;
    this.dug = true;
    this.mineShake = 0.18;
    const v = this.vm;
    const color = v ? pick(v.colors) : "red";
    const x0 = x == null ? L.mine.cx + rnd(-10, 10) * L.u : clamp(x, L.mine.x0 + 6, L.mine.x1 - 6);
    const y0 = y == null ? L.mine.peakY + 10 * L.u : clamp(y, L.mine.peakY, L.floorY - 4);
    const x1 = L.belt.start + rnd(6, 26) * L.u;
    if (this.sprites.length < SPRITE_MAX) {
      this.sprites.push({
        kind: "drop", t: 0, dur: 0.5, x0, y0, x1, y1: L.beltY - L.oreR * 0.92, arc: 38 * L.u, age: 0,
        color, carat: 1 + ((Math.random() * 9) | 0), flaw: Math.random() < 0.25, path: this.P.main, d: 0, jy: 0,
      });
    }
    for (let i = 0; i < 6; i++) {
      this._particle({ type: "spark", x: x0, y: y0, vx: rnd(-90, 90), vy: rnd(-120, -20), life: 0.4, size: 1.8, color: pick([C.gold, "#ffffff", GEM[color][0]]), g: 300 });
    }
  }

  _arrive(s, v) {
    const L = this.L;
    if (s.kind === "ore") {
      if (v.passthrough) {
        const item = this._pull(v);
        s.kind = "chute"; s.path = this.P.chute; s.d = 0; s.item = item;
        const c = item.cells[0];
        if (c && GEM[c.color]) { s.color = c.color; s.carat = c.carat; s.flaw = !!c.flaw && !c.polished; }
        return true;
      }
      if (this.band) return false;
      this.refIn += 1;
      if (!this.pending) this.pending = this._pull(v);
      if (this.refIn >= this.pending.cells.length) {
        this.refIn -= this.pending.cells.length;
        this.emitQueue.push({ t: 0.22, item: this.pending });
        this.pending = null;
      }
      return false;
    }
    const item = s.item || { value: 1, cells: [] };
    const T = L.truck;
    if (this.truckT < 0 || this.truckT > 1.2) {
      this.bedCount = Math.min(BED_CAP, this.bedCount + 1);
      this.truckBounce = 0.18;
    }
    const value = num(item.value, 0);
    // 続けて出るポップが重ならないよう、ドックの左右に交互に出す
    this.popLane = ((this.popLane || 0) + 1) % 2;
    const px = L.dock.cx + (this.popLane ? 1 : -1) * L.dock.w * 0.2;
    const py = T.bedY - 12 * L.u;
    // 帯表現中は合計表示が主役なので、個別のポップは半分に間引く
    const cost = this.band ? 2 : 1;
    // スクラップの箱（value 0）は「+$0」を出さない
    if (value > 0 && this.popTokens >= cost) {
      this.popTokens -= cost;
      this._addPop("+$" + fmt(value), value, px, py, 1);
    } else if (value > 0) {
      this.popOverflow = true;
    }
    if (item.perfect) {
      for (let i = 0; i < 14; i++) {
        const a = rnd(0, Math.PI * 2);
        this._particle({ type: "star", x: px, y: T.bedY, vx: Math.cos(a) * rnd(40, 110), vy: Math.sin(a) * rnd(40, 110) - 30, life: 0.7, size: 3.2 * Math.max(0.7, L.u), color: C.gold, g: 80 });
      }
    }
    try { this.onShip?.(item); } catch { /* 呼び手側の失敗で描画を止めない */ }
    return false;
  }

  _addPop(text, value, x, y, scale = 1, agg = false) {
    const digits = Math.log10(Math.max(1, Math.abs(value)));
    const tier = clamp(Math.floor(digits / 3), 0, POP_TIERS.length - 1);
    const base = Math.max(11, 12 * Math.max(0.8, this.L ? this.L.u : 1));
    // 桁が大きいほど大きく。ただし狭い画面で工場を覆わないよう幅で頭打ちにする
    const cap = this.L ? Math.max(14, this.L.W * 0.045) : 40;
    const size = Math.min(cap * scale, base * (1 + Math.min(digits, 15) * 0.06) * scale);
    const u = this.L ? this.L.u : 1;
    const jx = agg ? 0 : rnd(-4, 4) * u;
    const jy = agg ? 0 : rnd(-3, 3) * u;
    this.pops.push({ text, x: x + jx, y: y + jy, size, color: agg ? C.cyan : POP_TIERS[tier], age: 0, life: agg ? 1.3 : 0.95, vx: rnd(-8, 8), agg });
    if (this.pops.length > 24) this.pops.shift();
  }

  _pilePos() {
    const L = this.L;
    if (this.bn === "belt") return { x: L.belt.start + 22 * L.u, y: L.beltY };
    if (this.bn === "dock") return { x: L.outb.x0 + (L.truck.bedX - L.outb.x0) * 0.4, y: L.beltY };
    return { x: L.ref.inX - 22 * L.u, y: L.beltY };
  }

  _stampPos(stage) {
    const L = this.L;
    const col = L.cols[stage] || L.dock;
    let x = col.cx;
    if (stage === "belt") x = (L.belt.start + L.ref.inX) / 2;
    const y = Math.max(L.font + 8, L.H * 0.17);
    return { x, y };
  }


  _draw(v) {
    const ctx = this.ctx;
    const L = this.L;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, L.W, L.H);
    ctx.drawImage(this.bg, 0, 0, L.W, L.H);
    ctx.save();
    if (this.shakeT > 0) {
      const a = this.shakeAmp * (this.shakeT / 0.45) * L.u;
      ctx.translate(rnd(-a, a), rnd(-a, a));
    }
    this._drawSkyExtras(v);
    this._drawGlow(v);
    this._drawMine(v);
    this._drawMainBelt(v);
    this._drawRefinery(v);
    this._drawOutBelt(v);
    this._drawDock(v);
    this._drawPile(v);
    this._drawSprites(v);
    this._drawParticles();
    this._drawPileLabel();
    this._drawHint(v);
    this._drawBottleneckStamp();
    this._drawStamps();
    this._drawGenerator(v);
    this._drawLabels(v);
    this._drawPops();
    // 夜間ラインの札は終盤（帯表現でポップが出続ける）にしか出ないので、ポップに隠れないよう手前に描く
    this._drawNightSigns(v);
    // 特注便の幟は一回きりの見せ場なので、出荷ポップより手前に出す
    this._drawSpecialBanner();
    this._drawOvertimeBadge(v);
    ctx.restore();
    this._drawCelebrate();
  }

  // 夜間ラインの月と、残業灯で点く遠景の窓
  _drawSkyExtras(v) {
    const ctx = this.ctx, L = this.L, u = L.u;
    if (v.nightShift) {
      const r = Math.max(5, 8 * u);
      const x = L.outb.cx, y = Math.max(r + 4, L.H * 0.09);
      ctx.fillStyle = "rgba(255,240,190,0.12)";
      ctx.beginPath(); ctx.arc(x, y, r * 2.1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff1bf";
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.bgTop;
      ctx.beginPath(); ctx.arc(x + r * 0.45, y - r * 0.3, r * 0.88, 0, Math.PI * 2); ctx.fill();
    }
    const a = this.otA;
    if (a <= 0) return;
    for (const w of this.bgWins) {
      const h = hash(w.seed);
      // 1 割ほどは蛍光灯がちらつく
      const flick = h < 0.1 ? (Math.sin(this.t * (9 + h * 40) + w.seed) > -0.3 ? 1 : 0.25) : 1;
      ctx.fillStyle = `rgba(255,${Math.round(196 + h * 40)},${Math.round(110 + h * 60)},${(0.55 + h * 0.4) * a * flick})`;
      ctx.fillRect(w.x, w.y, w.w, w.h);
    }
  }

  // 窓の明かり（鉱山・ドック・工場）。夜間ラインか残業のときだけ点く
  _windowLight() {
    return Math.max(this.vm?.nightShift ? 1 : 0, this.otA);
  }

  _litWindow(x, y, w, h, a, seed) {
    const ctx = this.ctx;
    const f = 0.88 + 0.12 * Math.sin(this.t * 3 + seed * 1.7);
    ctx.fillStyle = `rgba(255,200,110,${0.22 * a * f})`;
    ctx.fillRect(x - w * 0.5, y - h * 0.4, w * 2, h * 1.8);
    ctx.fillStyle = `rgba(255,214,130,${0.95 * a * f})`;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = `rgba(120,70,20,${0.55 * a})`;
    ctx.fillRect(x + w / 2 - 0.5, y, 1, h);
  }

  _mineWindows() {
    const a = this._windowLight();
    if (a <= 0) return;
    const L = this.L, m = L.mine, u = L.u;
    const w = Math.max(3.5, 5 * u), h = Math.max(4, 6 * u);
    const y = m.peakY + (L.floorY - m.peakY) * 0.4;
    for (let i = 0; i < 3; i++) this._litWindow(m.x0 + m.w * (0.24 + i * 0.13) - w / 2, y + (i === 1 ? -h * 0.6 : 0), w, h, a, i);
  }

  _dockWindows(dx0, dx1, dy0) {
    const a = this._windowLight();
    if (a <= 0) return;
    const u = this.L.u;
    const w = Math.max(4, 7 * u), h = Math.max(4, 7 * u);
    // 夜間ラインの札の分だけ左を空ける
    if (this.vm?.nightShift) dx0 += this._signFont() * 2.9;
    const n = Math.max(2, Math.min(5, Math.floor((dx1 - dx0) / (w * 2.6))));
    const step = (dx1 - dx0) / n;
    for (let i = 0; i < n; i++) this._litWindow(dx0 + step * (i + 0.5) - w / 2, dy0 + Math.max(2, 3 * u), w, h, a, i + 5);
  }

  _hangSign(text, cx, y, bg, fg) {
    const ctx = this.ctx, u = this.L.u;
    const fs = this._signFont();
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + fs * 0.8, h = fs + 5;
    const x = clamp(cx, w / 2 + 2, this.L.W - w / 2 - 2);
    const sw = Math.sin(this.t * 1.6 + cx) * 0.04;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(sw);
    ctx.strokeStyle = "rgba(200,190,230,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-w * 0.3, 0); ctx.lineTo(0, -4 * u - 2); ctx.lineTo(w * 0.3, 0); ctx.stroke();
    ctx.fillStyle = bg;
    roundRect(ctx, -w / 2, 0, w, h, 3);
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1;
    roundRect(ctx, -w / 2 + 1.5, 1.5, w - 3, h - 3, 2);
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, h / 2 + 0.5);
    ctx.restore();
  }

  // 夜間ラインの札（鉱山とドック）。合鍵で動かしたラインなので、残業だけのときは出さない
  _drawNightSigns(v) {
    if (!v.nightShift) return;
    const L = this.L, m = L.mine, d = L.dock, u = L.u;
    this._hangSign("夜間", m.x0 + m.w * 0.37, m.peakY + (L.floorY - m.peakY) * 0.56, "#1b1640", C.lamp);
    // ドックは出荷ポップが通る高さを避けて、屋根のすぐ下の左端に吊るす（窓はこの右から並べる）
    const roofH = Math.max(5, 8 * u);
    const fs = this._signFont();
    this._hangSign("夜間", d.x0 + Math.max(5, 9 * u) + fs * 1.4, d.roofY + roofH + Math.max(3, 4 * u), "#1b1640", C.lamp);
  }

  _signFont() {
    return Math.max(9, Math.round(10 * this.L.u));
  }

  // 工場の常設の AUDITED（このデプロイが鑑定長に見抜かれている間）。故障の札が出ているときは札の下に隠れる
  _drawAuditSeal() {
    if (this.sealA <= 0) return;
    const L = this.L, r = L.ref, u = L.u;
    const fs = Math.max(8, Math.round(10 * u));
    this.ctx.font = `900 ${fs}px "Arial Black", system-ui, sans-serif`;
    const half = (this.ctx.measureText("AUDITED").width + fs * 0.9) / 2;
    const cx = Math.max((r.bx0 + r.bx1) / 2, r.bx1 - half - 5 * u);
    const top = r.win.y + r.win.h, bottom = L.floorY - Math.max(7, 13 * u) - Math.max(2, 3 * u);
    const cy = lerp(top, bottom, 0.5);
    const t = clamp(this.sealT / 0.14, 0, 1);
    const scale = 1 + 0.9 * (1 - easeOutCubic(t));
    this._drawStampBox("AUDITED", cx, cy, C.audit, fs, -0.16, scale, this.sealA * 0.92);
  }

  // 特注便の幟（金色のトラックの上）
  _drawSpecialBanner() {
    const sp = this.special;
    const off = this._specialOffsets();
    if (!sp || !off || sp.age < SD.out + 0.2 || sp.age > SD.leave) return;
    const ctx = this.ctx, L = this.L, T = L.truck, u = L.u;
    const a = clamp((sp.age - SD.out - 0.2) / 0.3, 0, 1) * clamp((SD.leave - sp.age) / 0.25, 0, 1);
    const fs = Math.max(10, Math.round(12 * u));
    const text = !sp.label ? "特注便" : /便/.test(sp.label) ? sp.label : `特注便  ${sp.label}`;
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    const t = this._fit(text, Math.min(L.W - 8, Math.max(L.dock.w * 2.2, 230)) - fs);
    const w = ctx.measureText(t).width + fs, h = fs + 8;
    const cx = clamp(T.x + T.w / 2, w / 2 + 3, L.W - w / 2 - 3) + off.gold;
    const y = T.cabTop - h - Math.max(4, 8 * u);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = "#ffd34d";
    roundRect(ctx, cx - w / 2, y, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = "#7a5200";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#3a2400";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(t, cx, y + h / 2 + 0.5);
    ctx.restore();
  }

  // 残業の残り時間（右上の小さな札）
  _drawOvertimeBadge(v) {
    if (this.otA <= 0) return;
    const ctx = this.ctx, L = this.L, u = L.u;
    const fs = Math.max(9, Math.round(10.5 * u));
    const text = `残業中 ${Math.ceil(v.overtimeLeft)} 秒`;
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + fs * 1.9, h = fs + 8;
    const x = L.W - w - 6, y = 6;
    ctx.save();
    ctx.globalAlpha = this.otA;
    ctx.fillStyle = "rgba(40,22,6,0.85)";
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,190,90,0.7)";
    ctx.lineWidth = 1;
    ctx.stroke();
    const blink = 0.55 + 0.45 * Math.sin(this.t * 6);
    ctx.fillStyle = `rgba(255,150,40,${blink})`;
    ctx.beginPath(); ctx.arc(x + fs * 0.75, y + h / 2, fs * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.lamp;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + fs * 1.35, y + h / 2 + 0.5);
    ctx.restore();
  }

  _drawGlow(v) {
    if (!this.bn) return;
    const ctx = this.ctx, L = this.L;
    const col = L.cols[this.bn];
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 5.5);
    const x = col.x0 + 2, w = col.w - 4, y = L.H * 0.08, h = L.barY + L.barH + 3 - y;
    ctx.fillStyle = `rgba(255,40,80,${0.06 + 0.07 * pulse})`;
    roundRect(ctx, x, y, w, h, 10 * L.u);
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = `rgba(255,51,85,${(0.5 - i * 0.15) * (0.45 + 0.55 * pulse)})`;
      ctx.lineWidth = 1.5 + i * 2.5;
      roundRect(ctx, x, y, w, h, 10 * L.u);
      ctx.stroke();
    }
  }

  _drawMine(v) {
    const ctx = this.ctx, L = this.L, m = L.mine, u = L.u;
    const k = this.k.mine;
    const sx = this.mineShake > 0 ? rnd(-1.5, 1.5) : 0;
    ctx.save();
    ctx.translate(sx, 0);
    ctx.fillStyle = desat(C.rock, k);
    ctx.beginPath();
    ctx.moveTo(m.x0, L.floorY);
    ctx.lineTo(m.x0 + m.w * 0.12, m.peakY + (L.floorY - m.peakY) * 0.35);
    ctx.lineTo(m.x0 + m.w * 0.38, m.peakY);
    ctx.lineTo(m.x0 + m.w * 0.55, m.peakY + (L.floorY - m.peakY) * 0.18);
    ctx.lineTo(m.x0 + m.w * 0.72, m.peakY + (L.floorY - m.peakY) * 0.1);
    ctx.lineTo(m.x1 + m.w * 0.02, m.peakY + (L.floorY - m.peakY) * 0.55);
    ctx.lineTo(m.x1 + m.w * 0.05, L.floorY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = desat(C.rockHi, k);
    ctx.beginPath();
    ctx.moveTo(m.x0 + m.w * 0.38, m.peakY);
    ctx.lineTo(m.x0 + m.w * 0.55, m.peakY + (L.floorY - m.peakY) * 0.18);
    ctx.lineTo(m.x0 + m.w * 0.46, m.peakY + (L.floorY - m.peakY) * 0.5);
    ctx.lineTo(m.x0 + m.w * 0.25, m.peakY + (L.floorY - m.peakY) * 0.22);
    ctx.closePath();
    ctx.fill();
    for (let i = 0; i < 7; i++) {
      const gx = m.x0 + m.w * (0.15 + hash(i * 3 + 1) * 0.55);
      const gy = m.peakY + (L.floorY - m.peakY) * (0.35 + hash(i * 5 + 2) * 0.55);
      const tw = 0.5 + 0.5 * Math.sin(this.t * 2 + i * 1.7);
      ctx.fillStyle = desat(GEM[v.colors[i % v.colors.length]][0], k);
      ctx.globalAlpha = 0.35 + tw * 0.55;
      ctx.beginPath();
      const r = (1.4 + hash(i) * 1.6) * Math.max(0.7, u);
      ctx.moveTo(gx, gy - r); ctx.lineTo(gx + r, gy); ctx.lineTo(gx, gy + r); ctx.lineTo(gx - r, gy);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this._mineWindows();
    const mx = m.mouthX, mw = m.mouthW, mh = m.mouthH;
    ctx.fillStyle = C.cave;
    ctx.beginPath();
    ctx.moveTo(mx - mw / 2, L.floorY);
    ctx.lineTo(mx - mw / 2, L.floorY - mh * 0.55);
    ctx.quadraticCurveTo(mx, L.floorY - mh * 1.25, mx + mw / 2, L.floorY - mh * 0.55);
    ctx.lineTo(mx + mw / 2, L.floorY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = desat("#7a5a3a", k);
    ctx.lineWidth = Math.max(2, 3 * u);
    ctx.beginPath();
    ctx.moveTo(mx - mw / 2, L.floorY);
    ctx.lineTo(mx - mw / 2, L.floorY - mh * 0.6);
    ctx.lineTo(mx + mw / 2, L.floorY - mh * 0.6);
    ctx.lineTo(mx + mw / 2, L.floorY);
    ctx.stroke();
    const lg = 0.6 + 0.4 * Math.sin(this.t * 7);
    ctx.fillStyle = `rgba(255,200,90,${0.5 + 0.4 * lg})`;
    ctx.beginPath();
    ctx.arc(mx, L.floorY - mh * 0.6 + 4 * u, Math.max(1.5, 2.4 * u), 0, Math.PI * 2);
    ctx.fill();
    const ph = this.swing % 1;
    const ang = ph < 0.7 ? lerp(-1.25, 0.25, easeInCubic(ph / 0.7)) : lerp(0.25, -1.25, easeOutCubic((ph - 0.7) / 0.3));
    const px = mx - mw * 0.55, py = L.floorY - mh * 0.95;
    const hl = Math.max(12, 21 * u);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.strokeStyle = desat("#c08a4a", k);
    ctx.lineWidth = Math.max(1.5, 2.2 * u);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(hl, hl * 0.35); ctx.stroke();
    ctx.strokeStyle = desat("#d8d4ea", k);
    ctx.lineWidth = Math.max(2, 3 * u);
    ctx.beginPath();
    ctx.moveTo(hl - 4 * u, hl * 0.35 - 7 * u);
    ctx.quadraticCurveTo(hl + 3 * u, hl * 0.35, hl - 2 * u, hl * 0.35 + 8 * u);
    ctx.stroke();
    ctx.restore();
    ctx.restore();
  }

  _beltColor(v, k) {
    const c = BELT_COLORS[v.beltTier];
    if (c) return desat(c, k);
    return `hsl(${(this.t * 90) % 360},90%,62%)`;
  }

  _drawConveyor(x0, x1, y, k, v, off) {
    const ctx = this.ctx, L = this.L, u = L.u;
    const th = Math.max(5, 8 * u);
    ctx.fillStyle = desat("#2a2346", k);
    for (let x = x0 + 8 * u; x < x1 - 4; x += 34 * Math.max(0.6, u)) ctx.fillRect(x, y + th, Math.max(2, 3 * u), L.floorY - y - th);
    ctx.fillStyle = desat("#3a3160", k);
    roundRect(ctx, x0, y, x1 - x0, th, th / 2);
    ctx.fill();
    const bc = this._beltColor(v, k);
    ctx.save();
    roundRect(ctx, x0, y, x1 - x0, th * 0.55, th / 3);
    ctx.clip();
    ctx.fillStyle = bc;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x0, y, x1 - x0, th);
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = "#15102a";
    ctx.lineWidth = Math.max(1, 1.4 * u);
    const sp = 12 * Math.max(0.6, u);
    const o = off % sp;
    ctx.beginPath();
    for (let x = x0 - sp + o; x < x1; x += sp) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + th * 0.35, y + th * 0.28);
      ctx.lineTo(x, y + th * 0.55);
    }
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.fillStyle = desat("#5a4f8a", k);
    for (const x of [x0 + th / 2, x1 - th / 2]) {
      ctx.beginPath(); ctx.arc(x, y + th / 2, th / 2, 0, Math.PI * 2); ctx.fill();
    }
  }

  _drawMainBelt(v) {
    const L = this.L;
    const k = this.k.belt;
    if (v.dual) {
      // 2 車線: 奥の帯を先に描き、手前の帯の原石は 2 段までにして奥が隠れないようにする
      const back = L.belt.start + 6 * L.u;
      this._drawConveyor(back, L.ref.inX + 4, L.dualY, k, v, this.beltOff * 0.97);
      if (this.band) this._drawOreBand(v, back + 4, L.ref.inX - 2, this.bandOff * 0.96 + 37, L.dualY, 2);
    }
    this._drawConveyor(L.belt.start, L.ref.inX + 4, L.beltY, k, v, this.beltOff);
    if (this.band) this._drawOreBand(v, L.belt.start + 4, L.ref.inX - 2, this.bandOff, L.beltY, v.dual ? 2 : 4);
  }

  _drawOreBand(v, x0, x1, off, baseY = this.L.beltY, maxRows = 4) {
    const ctx = this.ctx, L = this.L, u = L.u;
    const lg = Math.log10(Math.max(1, v.flow / SPRITE_RATE_MAX));
    const rows = clamp(1 + Math.floor(lg / 1.4), 1, maxRows);
    const r = L.oreR * clamp(0.95 - lg * 0.05, 0.6, 0.95);
    const sp = r * 1.9;
    const len = x1 - x0;
    const n = Math.ceil(len / sp) + 1;
    const th = rows * r * 1.55 + r * 0.6;
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    roundRect(ctx, x0, baseY - th, len, th, r);
    ctx.fill();
    for (let row = 0; row < rows; row++) {
      const o = (off * (1 + row * 0.07)) % (sp * n);
      for (let i = 0; i < n; i++) {
        let x = x0 + ((i * sp + o) % (sp * n));
        if (x > x1) continue;
        const lap = Math.floor((i * sp + off * (1 + row * 0.07)) / (sp * n));
        const h = hash(i * 31 + row * 977 + lap * 7919);
        const color = v.colors[Math.floor(h * v.colors.length) % v.colors.length];
        const y = baseY - r * 0.9 - row * r * 1.45;
        if (row % 2) x += sp / 2;
        if (x > x1) continue;
        this._gem(x, y, r, color, h > 0.8, false, null);
      }
    }
  }

  _drawRefinery(v) {
    const ctx = this.ctx, L = this.L, r = L.ref, u = L.u;
    const k = this.k.refinery;
    const st = v.status;
    const hot = st === "overheat" ? 0.5 + 0.5 * Math.sin(this.t * 9) : 0;
    ctx.fillStyle = desat("#3a3355", k);
    ctx.fillRect(r.chX, r.chTop, r.chW, r.top - r.chTop + 2);
    ctx.fillStyle = desat(C.ruby, Math.max(k, 0.25));
    ctx.fillRect(r.chX - 1.5 * u, r.chTop, r.chW + 3 * u, Math.max(2, 3 * u));
    const bw = r.bx1 - r.bx0, bh = L.floorY - r.top;
    ctx.fillStyle = desat(C.steelLo, k);
    roundRect(ctx, r.bx0, r.top, bw, bh, 6 * u);
    ctx.fill();
    ctx.fillStyle = desat(C.steel, k);
    roundRect(ctx, r.bx0 + 2, r.top + 2, bw - 4, bh - 4, 5 * u);
    ctx.fill();
    if (hot > 0) {
      ctx.fillStyle = `rgba(255,60,30,${0.18 + hot * 0.22})`;
      roundRect(ctx, r.bx0, r.top, bw, bh, 6 * u);
      ctx.fill();
    }
    ctx.fillStyle = desat(C.ruby, k);
    ctx.fillRect(r.bx0 + 2, r.top + 2, bw - 4, Math.max(2, 3 * u));
    ctx.fillStyle = C.cave;
    const ph = Math.max(10, 16 * u);
    ctx.fillRect(r.bx0, L.beltY - ph + 2, Math.max(4, 6 * u), ph);
    ctx.fillRect(r.bx1 - Math.max(4, 6 * u), L.beltY - ph + 2, Math.max(4, 6 * u), ph);
    // 2 車線の奥の帯の入口
    if (v.dual) ctx.fillRect(r.bx0, L.dualY - ph + 2, Math.max(4, 6 * u), ph);
    const w = r.win;
    ctx.fillStyle = desat(C.glass, k * 0.5);
    roundRect(ctx, w.x, w.y, w.w, w.h, 4 * u);
    ctx.fill();
    const lit = st === "running" || st === "idle";
    if (lit) {
      ctx.fillStyle = `rgba(120,160,255,${st === "running" ? 0.12 + 0.06 * Math.sin(this.t * 4) : 0.05})`;
      roundRect(ctx, w.x, w.y, w.w, w.h, 4 * u);
      ctx.fill();
    }
    if (this.otA > 0) {
      ctx.fillStyle = `rgba(255,190,90,${0.2 * this.otA})`;
      roundRect(ctx, w.x, w.y, w.w, w.h, 4 * u);
      ctx.fill();
    }
    this._drawMachines(v, w, k);
    ctx.strokeStyle = desat(C.steelHi, k);
    ctx.lineWidth = Math.max(1, 1.5 * u);
    roundRect(ctx, w.x, w.y, w.w, w.h, 4 * u);
    ctx.stroke();
    const gr = Math.max(5, 9 * u);
    const gx = r.bx1 - gr - 4 * u, gy = r.top - gr * 0.35;
    ctx.fillStyle = desat("#8a86a8", k);
    gearPath(ctx, gx, gy, gr, 8, this.gearRot);
    ctx.fill();
    ctx.fillStyle = desat(C.steelLo, k);
    ctx.beginPath(); ctx.arc(gx, gy, gr * 0.32, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = desat("#6c6890", k);
    gearPath(ctx, gx - gr * 1.45, gy + gr * 0.55, gr * 0.62, 6, -this.gearRot * 1.6 + 0.3);
    ctx.fill();
    if (this.flashT < 0.6) {
      ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - this.flashT / 0.6)})`;
      roundRect(ctx, r.bx0, r.top, bw, bh, 6 * u);
      ctx.fill();
    }
    const fw = bw * 0.3, fh = Math.max(7, 13 * u);
    const fx = (r.bx0 + r.bx1) / 2 - fw / 2, fy = L.floorY - fh - Math.max(2, 3 * u);
    if (!v.passthrough && st !== "booting") {
      ctx.fillStyle = "#0b0714";
      roundRect(ctx, fx, fy, fw, fh, Math.min(fh / 2, 5 * u));
      ctx.fill();
    }
    const flick = 0.85 + 0.15 * Math.sin(this.t * 13) * Math.sin(this.t * 7.3);
    const heat = st === "overheat" ? 1 : st === "running" ? 0.25 + 0.75 * v.util.refinery : st === "idle" || st === "jam" || st === "inspect-error" ? 0.12 : 0;
    if (heat > 0) {
      ctx.fillStyle = st === "overheat" ? `rgba(255,60,25,${0.95 * flick})` : `rgba(255,${Math.round(110 + 60 * heat)},40,${(0.25 + 0.6 * heat) * flick})`;
      roundRect(ctx, fx + 2, fy + fh * 0.35, fw - 4, fh * 0.65 - 2, Math.min(fh / 3, 4 * u));
      ctx.fill();
    }
    if (st === "jam") this._drawBeacon((r.bx0 + r.bx1) / 2, r.top, "#ff2a44");
    else if (st === "inspect-error") this._drawBeacon((r.bx0 + r.bx1) / 2, r.top, "#ffc21a");
    this._drawAuditSeal();
    this._drawSign(v);
  }

  _drawBeacon(x, y, color) {
    const ctx = this.ctx, u = this.L.u;
    const a = this.t * 7;
    const len = 46 * Math.max(0.7, u);
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = color;
    for (const off of [0, Math.PI]) {
      const aa = a + off;
      ctx.beginPath();
      ctx.moveTo(x, y - 5 * u);
      ctx.lineTo(x + Math.cos(aa - 0.22) * len, y - 5 * u + Math.sin(aa - 0.22) * len * 0.35);
      ctx.lineTo(x + Math.cos(aa + 0.22) * len, y - 5 * u + Math.sin(aa + 0.22) * len * 0.35);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = "#222";
    ctx.fillRect(x - 5 * u, y - 2 * u, 10 * u, 3 * u);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y - 4 * u, Math.max(3, 4.5 * u), Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * Math.sin(this.t * 14)})`;
    ctx.beginPath();
    ctx.arc(x - 1.2 * u, y - 5.5 * u, 1.3 * u, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawSign(v) {
    const st = v.status;
    const table = {
      booting: ["起動待ち", "#4a4560", C.dim],
      passthrough: ["素通し中", "#4a4560", C.ink],
      idle: ["待機", "#2a3150", C.dim],
      jam: ["詰まり", "#c8102e", "#ffffff"],
      overheat: ["オーバーヒート", "#2a0d0d", "#ff7a4a"],
      restarting: ["再起動中…", "#4a4560", "#ffffff"],
      "inspect-error": ["検品エラー", "#ffc21a", "#1a1300"],
    };
    const def = table[st];
    if (!def) return;
    const ctx = this.ctx, L = this.L, r = L.ref, u = L.u;
    const [title, bg, fg] = def;
    const fs = Math.max(9, Math.round(11 * u));
    const maxW = r.bx1 - r.bx0 - 6 * u;
    const lines = [title];
    if (v.label) lines.push(v.label);
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    const cx = (r.bx0 + r.bx1) / 2;
    const swingA = st === "jam" || st === "inspect-error" ? Math.sin(this.t * 3.2) * 0.06 : 0;
    const h = lines.length * (fs + 3) + 5;
    const y = r.signY;
    ctx.save();
    ctx.translate(cx, y);
    ctx.rotate(swingA);
    ctx.fillStyle = bg;
    roundRect(ctx, -maxW / 2, 0, maxW, h, 3 * u);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    lines.forEach((ln, i) => {
      ctx.font = `${i === 0 ? 800 : 600} ${i === 0 ? fs : Math.max(9, fs - 2)}px ${i === 0 ? "system-ui, sans-serif" : "ui-monospace, Menlo, monospace"}`;
      ctx.fillText(this._fit(ln, maxW - 6), 0, 3 + i * (fs + 3));
    });
    if (st === "restarting") {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(maxW / 2 - fs * 0.8, h / 2, fs * 0.35, this.t * 8, this.t * 8 + 4.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _fit(text, maxW) {
    const ctx = this.ctx;
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  }

  _drawMachines(v, w, k) {
    const ctx = this.ctx, u = this.L.u;
    const ms = v.machines;
    if (!ms.length) return;
    const labeled = w.w >= 104;
    const pad = Math.max(2, 3 * u);
    const running = v.status === "running";
    const active = running ? Math.floor(this.t * (2 + v.util.refinery * 6)) % ms.length : -1;
    if (labeled) {
      const fs = Math.max(8, Math.round(9 * u));
      ctx.font = `600 ${fs}px ui-monospace, Menlo, monospace`;
      const ch = fs + 6;
      let x = w.x + pad, y = w.y + pad;
      for (let i = 0; i < ms.length; i++) {
        const name = String(ms[i]);
        const cw = ch + ctx.measureText(name).width + 6;
        if (x + cw > w.x + w.w - pad) { x = w.x + pad; y += ch + 3; }
        if (y + ch > w.y + w.h - pad + 1) {
          ctx.fillStyle = C.dim;
          ctx.textBaseline = "middle";
          ctx.fillText(`+${ms.length - i}`, w.x + w.w - pad - 14, w.y + w.h - ch / 2 - pad);
          break;
        }
        const on = i === active;
        const heat = name === "polish" ? this._heatGlow(x, y, cw, ch, k) : null;
        ctx.fillStyle = heat ? heat.bg : desat(on ? "#3b2a6e" : "#1f1a3d", k);
        roundRect(ctx, x, y, cw, ch, 3);
        ctx.fill();
        ctx.strokeStyle = heat && !on ? heat.edge : desat(on ? C.gold : "#4b4380", k);
        ctx.lineWidth = 1;
        ctx.stroke();
        this._machineIcon(name, x + ch / 2, y + ch / 2, ch * 0.32, k, on, heat?.edge);
        ctx.fillStyle = desat(on ? "#ffffff" : "#c9c2ee", k);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(name, x + ch, y + ch / 2 + 0.5);
        x += cw + 3;
      }
    } else {
      const n = ms.length;
      const cols = Math.min(n, Math.max(1, Math.floor((w.w - pad) / 13)));
      const rows = Math.ceil(n / cols);
      const cs = Math.min(16, (w.w - pad * 2) / cols - 2, (w.h - pad * 2) / Math.min(rows, 2) - 2);
      for (let i = 0; i < Math.min(n, cols * 2); i++) {
        const cx = w.x + pad + (i % cols) * (cs + 2) + cs / 2;
        const cy = w.y + pad + Math.floor(i / cols) * (cs + 2) + cs / 2;
        const on = i === active;
        const heat = ms[i] === "polish" ? this._heatGlow(cx - cs / 2, cy - cs / 2, cs, cs, k) : null;
        ctx.fillStyle = heat ? heat.bg : desat(on ? "#3b2a6e" : "#1f1a3d", k);
        roundRect(ctx, cx - cs / 2, cy - cs / 2, cs, cs, 2);
        ctx.fill();
        this._machineIcon(String(ms[i]), cx, cy, cs * 0.32, k, on, heat?.edge);
      }
    }
  }

  /**
   * 研磨機（polish の札）の熱。札のまわりに熱の色をうっすら敷き、札の地と縁の色を返す。
   * 冷えていれば青、そのバッチで磨いた回数が多いほど赤くなる（HEAT_RED_AT 回で真っ赤）
   */
  _heatGlow(x, y, w, h, k) {
    const ctx = this.ctx;
    const t = this.heatA;
    if (t > 0.05) {
      const pad = 1.5 + 2.5 * t;
      ctx.globalAlpha = (0.25 + 0.35 * t) * (0.85 + 0.15 * Math.sin(this.t * (3 + 6 * t)));
      ctx.fillStyle = desat(heatHex("#3d7bff", "#ff3a1a", t), k);
      roundRect(ctx, x - pad, y - pad, w + pad * 2, h + pad * 2, 3 + pad);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    return { bg: desat(heatHex("#1a2a5a", "#5e1a12", t), k), edge: desat(heatHex("#6fa8ff", "#ff6a3a", t), k) };
  }

  _machineIcon(name, x, y, s, k, on, tint = null) {
    const ctx = this.ctx;
    const kind = MACHINE_KIND[name] || "gear";
    const col = on ? desat(C.gold, k) : tint ?? desat("#9d8cff", k);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(1, s * 0.28);
    ctx.lineCap = "round";
    ctx.beginPath();
    switch (kind) {
      case "filter":
        ctx.moveTo(x - s, y - s * 0.8); ctx.lineTo(x + s, y - s * 0.8); ctx.lineTo(x + s * 0.2, y + s * 0.1);
        ctx.lineTo(x + s * 0.2, y + s); ctx.lineTo(x - s * 0.2, y + s * 0.8); ctx.lineTo(x - s * 0.2, y + s * 0.1); ctx.closePath();
        ctx.fill();
        break;
      case "sort":
        for (let i = 0; i < 3; i++) ctx.rect(x - s + i * s * 0.75, y + s - (i + 1) * s * 0.62, s * 0.5, (i + 1) * s * 0.62);
        ctx.fill();
        break;
      case "group":
        for (let i = 0; i < 3; i++) { ctx.moveTo(x - s * 0.7 + i * s * 0.7 + s * 0.28, y + s * 0.3); ctx.arc(x - s * 0.7 + i * s * 0.7, y + s * 0.3, s * 0.28, 0, Math.PI * 2); }
        ctx.moveTo(x, y - s); ctx.lineTo(x - s * 0.7, y); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.7, y); ctx.moveTo(x, y - s); ctx.lineTo(x, y);
        ctx.stroke();
        break;
      case "slice":
        for (let i = 0; i < 3; i++) ctx.rect(x - s + i * s * 0.72, y - s * 0.4, s * 0.52, s * 0.8);
        ctx.fill();
        break;
      case "cons":
        ctx.rect(x - s, y - s * 0.6, s * 1.3, s * 1.0);
        ctx.rect(x - s * 0.3, y - s * 0.3, s * 1.3, s * 1.0);
        ctx.stroke();
        break;
      case "chain":
        ctx.ellipse(x - s * 0.42, y, s * 0.55, s * 0.36, 0, 0, Math.PI * 2);
        ctx.moveTo(x + s * 0.97, y);
        ctx.ellipse(x + s * 0.42, y, s * 0.55, s * 0.36, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "arrow":
        ctx.moveTo(x - s, y); ctx.lineTo(x + s, y); ctx.moveTo(x + s * 0.3, y - s * 0.6); ctx.lineTo(x + s, y); ctx.lineTo(x + s * 0.3, y + s * 0.6);
        ctx.stroke();
        break;
      case "spark":
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          const r = i % 2 ? s * 0.38 : s * 1.05;
          if (i === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
          else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        break;
      case "sum":
        ctx.moveTo(x + s * 0.8, y - s); ctx.lineTo(x - s * 0.8, y - s); ctx.lineTo(x + s * 0.1, y); ctx.lineTo(x - s * 0.8, y + s); ctx.lineTo(x + s * 0.8, y + s);
        ctx.stroke();
        break;
      default:
        gearPath(ctx, x, y, s, 6, on ? this.t * 4 : 0);
        ctx.fill();
    }
    ctx.lineCap = "butt";
  }

  _drawOutBelt(v) {
    const L = this.L, u = L.u;
    const k = this.k.dock * 0.5;
    if (v.passthrough) {
      const ctx = this.ctx;
      const y = this.P.chute.segs[1].y0 + L.oreR;
      const th = Math.max(4, 6 * u);
      const x0 = L.ref.inX - 6 * u, x1 = L.truck.bedX + L.truck.bedW * 0.5;
      ctx.fillStyle = "#6f63a8";
      ctx.beginPath();
      ctx.moveTo(x0, L.beltY);
      ctx.lineTo(x0 + 10 * u, y);
      ctx.lineTo(x1, y);
      ctx.lineTo(x1, y + th);
      ctx.lineTo(x0 + 8 * u, y + th);
      ctx.lineTo(x0 - 2 * u, L.beltY + th * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#b3a8ea";
      ctx.fillRect(x0 + 10 * u, y, x1 - x0 - 10 * u, Math.max(1, 1.5 * u));
      ctx.fillStyle = "#3a3160";
      for (let x = x0 + 30 * u; x < x1; x += 46 * Math.max(0.6, u)) ctx.fillRect(x, y + th, Math.max(2, 2.5 * u), L.floorY - y - th);
      return;
    }
    const x0 = L.ref.outX - 4, x1 = L.truck.bedX + 2;
    this._drawConveyor(x0, x1, L.beltY, k, v, this.beltOff);
    const crateRate = v.flow / Math.max(1, this.avgCells);
    if (this.band && crateRate > CRATE_SPRITE_RATE) {
      const ctx = this.ctx;
      const s = L.crateS * 0.7;
      const sp = s * 1.25;
      const n = Math.ceil((x1 - x0) / sp) + 1;
      ctx.globalAlpha = 0.85;
      for (let i = 0; i < n; i++) {
        const x = x0 + ((i * sp + this.outBandOff) % (sp * n));
        if (x > x1 - s) continue;
        ctx.drawImage(this._crateImg(s, false), x, L.beltY - s, s, s);
      }
      ctx.globalAlpha = 1;
    }
  }

  _drawDock(v) {
    const ctx = this.ctx, L = this.L, d = L.dock, T = L.truck, u = L.u;
    const k = this.k.dock;
    const roofH = Math.max(5, 8 * u);
    ctx.fillStyle = desat("#1d1738", k);
    ctx.fillRect(d.x0 + 2, d.roofY, d.w - 4, L.floorY - d.roofY);
    const dx0 = d.x0 + Math.max(5, 9 * u), dx1 = d.x1 - Math.max(5, 9 * u), dy0 = d.roofY + roofH + Math.max(4, 7 * u);
    ctx.fillStyle = desat("#100c22", k);
    ctx.fillRect(dx0, dy0, dx1 - dx0, L.floorY - dy0);
    ctx.fillStyle = desat("#2a2250", k);
    for (let y = dy0 + 3 * u; y < L.floorY; y += Math.max(3, 5 * u)) ctx.fillRect(dx0, y, dx1 - dx0, 1);
    this._dockWindows(dx0, dx1, dy0);
    ctx.fillStyle = desat("#2b2450", k);
    ctx.fillRect(d.x0 + 2, d.roofY, d.w - 4, roofH);
    ctx.fillStyle = desat(C.gold, Math.max(k, 0.2));
    const sw = 10 * Math.max(0.6, u);
    for (let x = d.x0 + 2; x < d.x1 - 2 - sw; x += sw * 2) ctx.fillRect(x, d.roofY, sw, Math.max(2, 2.5 * u));
    const lampOn = this.truckBounce > 0 || this.truckT >= 0;
    ctx.fillStyle = lampOn ? "#ffe066" : desat("#6b5a2a", k);
    ctx.beginPath();
    ctx.arc((dx0 + dx1) / 2, dy0 - Math.max(2.5, 4 * u), Math.max(2, 2.6 * u), 0, Math.PI * 2);
    ctx.fill();
    let dx = 0;
    if (this.truckT >= 0) {
      const tt = this.truckT;
      if (tt < 0.7) dx = easeInCubic(tt / 0.7) * (L.W - T.x + 10);
      else dx = (1 - easeOutCubic((tt - 0.7) / 0.7)) * (L.W - T.x + 10);
    }
    const sd = this._specialOffsets();
    if (sd) dx = Math.max(dx, sd.normal);
    const by = this.truckBounce > 0 ? -Math.sin((this.truckBounce / 0.18) * Math.PI) * 2.2 * u : 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(d.x0, 0, L.W - d.x0, L.H);
    ctx.clip();
    if (!sd || dx < sd.dist) this._drawTruck(v, k, dx, by, TRUCK_PAL.normal, this.bedCount, false);
    if (sd && sd.gold < sd.dist) {
      const sp = this.special;
      const parked = sp.age >= SD.in && sp.age < SD.park;
      const gb = parked ? -Math.abs(Math.sin((sp.age - SD.in) * 9)) * 1.2 * u * Math.max(0, 1 - (sp.age - SD.in) * 2) : 0;
      this._drawTruck(v, 0, sd.gold, gb, TRUCK_PAL.gold, 6, true);
    }
    ctx.restore();
  }

  _drawTruck(v, k, dx, by, pal, count, gold) {
    const ctx = this.ctx, L = this.L, T = L.truck, u = L.u;
    ctx.save();
    ctx.translate(dx, by);
    // 荷台（奥 → 積み荷 → 手前の板の順に描いて、積み荷が荷台に入って見えるようにする）
    ctx.fillStyle = desat(pal.bedBack, k);
    ctx.fillRect(T.bedX, T.bedY, T.bedW, T.baseY - T.bedY);
    const cs = L.crateS * 0.72;
    const perRow = Math.max(1, Math.floor((T.bedW - 4) / (cs + 1)));
    for (let i = 0; i < count; i++) {
      const col = i % perRow, row = Math.floor(i / perRow);
      const x = T.bedX + 2 + col * (cs + 1);
      if (v.passthrough && !gold) {
        this._gem(x + cs / 2, T.bedFloor - L.oreR * 0.7 - row * L.oreR * 1.2, L.oreR * 0.9, v.colors[i % v.colors.length], false, false, null);
      } else {
        ctx.drawImage(this._crateImg(cs, gold), x, T.bedFloor - cs - row * (cs - 1), cs, cs);
      }
    }
    const frontY = lerp(T.bedY, T.bedFloor, 0.55);
    ctx.fillStyle = desat(pal.front, k);
    ctx.fillRect(T.bedX, frontY, T.bedW, T.baseY - frontY);
    ctx.fillStyle = desat(pal.rim, k);
    ctx.fillRect(T.bedX, frontY, T.bedW, Math.max(1.5, 2 * u));
    if (gold) {
      // 荷台の側面の帯の星
      ctx.fillStyle = `rgba(255,246,200,${0.6 + 0.4 * Math.sin(this.t * 10)})`;
      const sy = lerp(frontY, T.baseY, 0.55), ss = Math.max(2, 2.6 * u);
      for (const fx of [0.25, 0.5, 0.75]) {
        const sx = T.bedX + T.bedW * fx;
        ctx.beginPath();
        ctx.moveTo(sx, sy - ss); ctx.lineTo(sx + ss * 0.3, sy - ss * 0.3); ctx.lineTo(sx + ss, sy); ctx.lineTo(sx + ss * 0.3, sy + ss * 0.3);
        ctx.lineTo(sx, sy + ss); ctx.lineTo(sx - ss * 0.3, sy + ss * 0.3); ctx.lineTo(sx - ss, sy); ctx.lineTo(sx - ss * 0.3, sy - ss * 0.3);
        ctx.fill();
      }
    }
    ctx.fillStyle = desat(pal.chassis, k);
    ctx.fillRect(T.bedX, T.baseY - Math.max(2, 3 * u), T.cabX + T.cabW - T.bedX, Math.max(2, 3 * u));
    ctx.fillStyle = desat(pal.cab, k);
    roundRect(ctx, T.cabX, T.cabTop, T.cabW, T.baseY - T.cabTop, 4 * u);
    ctx.fill();
    ctx.fillStyle = desat(pal.glass, k);
    roundRect(ctx, T.cabX + T.cabW * 0.45, T.cabTop + 3 * u, T.cabW * 0.45, (T.baseY - T.cabTop) * 0.35, 2 * u);
    ctx.fill();
    ctx.fillStyle = "#ffdf6b";
    ctx.fillRect(T.cabX + T.cabW - 2.5 * u, T.baseY - 7 * u, 2.5 * u, 3 * u);
    if (gold) {
      // 屋根の回転灯
      const bx = T.cabX + T.cabW * 0.5, byy = T.cabTop;
      ctx.fillStyle = `rgba(255,220,90,${0.5 + 0.5 * Math.sin(this.t * 14)})`;
      ctx.beginPath(); ctx.arc(bx, byy, Math.max(2, 3 * u), Math.PI, 0); ctx.fill();
    }
    ctx.fillStyle = C.tire;
    const wy = L.floorY - T.wheelR;
    for (const wx of [T.bedX + T.bedW * 0.25, T.bedX + T.bedW * 0.75, T.cabX + T.cabW * 0.6]) {
      ctx.beginPath(); ctx.arc(wx, wy, T.wheelR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = gold ? "#e8c35a" : "#8a85a8";
      ctx.beginPath(); ctx.arc(wx, wy, T.wheelR * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.tire;
    }
    ctx.restore();
  }

  _drawPile(v) {
    if (!this.bn || this.bn === "mine" || this.pile < 0.5) return;
    const ctx = this.ctx, L = this.L, u = L.u;
    const p = this._pilePos();
    const count = Math.round(this.pile);
    const isCrate = this.bn === "dock";
    const shown = Math.min(isCrate ? 15 : 36, Math.ceil(count / (isCrate ? 4 : 4)));
    const s = isCrate ? L.crateS * 0.72 : L.oreR * 1.6;
    let i = 0, row = 0;
    let topY = p.y;
    while (i < shown) {
      const inRow = Math.max(1, (isCrate ? 5 : 8) - row);
      for (let c = 0; c < inRow && i < shown; c++, i++) {
        const x = p.x + (c - (inRow - 1) / 2) * s * 0.92 + (hash(i * 13) - 0.5) * 2;
        const y = p.y - row * s * (isCrate ? 0.92 : 0.62) - s / 2;
        topY = Math.min(topY, y - s / 2);
        if (isCrate) ctx.drawImage(this._crateImg(s, false), x - s / 2, y - s / 2, s, s);
        else this._gem(x, y, s / 2, v.colors[Math.floor(hash(i * 7 + 3) * v.colors.length)], hash(i * 5) < 0.25, false, null);
      }
      row++;
    }
    const fs = Math.max(10, Math.round(11 * u));
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const label = `在庫 ${count}${count >= 200 ? "+" : ""}`;
    const spill = v.spill <= 0 ? "" : L.W < 520 ? `こぼれ ${fmt(v.spill)}/s` : `こぼれ ${fmt(v.spill)} 個/秒`;
    const half = Math.max(ctx.measureText(label).width, ctx.measureText(spill).width) / 2;
    // 工場の窓や運転台に文字が重ならないよう、工程の手前で止める
    const limit = this.bn === "refinery" ? L.ref.inX - 4 : this.bn === "dock" ? L.truck.bedX - 2 : L.W - 4;
    const tx = clamp(Math.min(p.x, limit - half), half + 3, L.W - half - 3);
    // 文字はスプライトより手前に出したいので、描くのは _drawPileLabel で後から
    this._pileLabel = { label, spill, tx, topY, fs };
  }

  _drawPileLabel() {
    const pl = this._pileLabel;
    this._pileLabel = null;
    if (!pl) return;
    const ctx = this.ctx;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.font = `800 ${pl.fs}px system-ui, sans-serif`;
    this._outlined(pl.label, pl.tx, pl.topY - 2, "#ffd0d8");
    if (pl.spill) {
      ctx.font = `700 ${Math.max(9, pl.fs - 1)}px system-ui, sans-serif`;
      this._outlined(pl.spill, pl.tx, pl.topY - pl.fs - 3, C.red);
    }
  }

  _outlined(text, x, y, color) {
    const ctx = this.ctx;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(10,6,20,0.9)";
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  _drawSprites(v) {
    const ctx = this.ctx, L = this.L, u = L.u;
    const p = this._p;
    const carats = this.sprites.length < 70 && L.oreR >= 5 && (this.lanes || 1) === 1;
    for (const s of this.sprites) {
      if (s.kind === "drop") {
        const t = s.t;
        const x = lerp(s.x0, s.x1, t);
        const y = lerp(s.y0, s.y1, t * t) - Math.sin(t * Math.PI) * s.arc;
        this._gem(x, y, L.oreR * 1.1, s.color, s.flaw, false, carats ? s.carat : null);
        continue;
      }
      pathAt(s.path, s.d, p);
      if (s.kind === "ore" || s.kind === "chute") {
        const hop = s.age < 0.25 ? Math.sin((s.age / 0.25) * Math.PI) * 5 * u : 0;
        this._gem(p.x, p.y - hop + s.jy, L.oreR, s.color, s.flaw, false, carats ? s.carat : null);
      } else {
        const it = s.item || {};
        const cs = L.crateS;
        const a = s.age;
        let sx = 1, sy = 1, jump = 0;
        if (a < 0.4) {
          const t = a / 0.4;
          const e = Math.sin(t * Math.PI * 2.2) * (1 - t);
          sx = 1 + e * 0.35; sy = 1 - e * 0.35;
          jump = Math.sin(clamp(t * 1.4, 0, 1) * Math.PI) * 10 * u;
        }
        const left = s.path.len - s.d;
        const hopLen = 16 * Math.max(0.7, u);
        if (left < hopLen) jump += Math.sin((1 - left / hopLen) * Math.PI) * 9 * u;
        const w = cs * sx, h = cs * sy;
        const x = p.x - w / 2, y = p.y + cs / 2 - h - jump;
        const xmas = Array.isArray(it.bonuses) && it.bonuses.some((b) => b?.key === "christmas");
        ctx.drawImage(this._crateImg(cs, !!it.perfect, xmas), x, y, w, h);
        const cells = it.cells || [];
        const n = Math.min(3, cells.length);
        for (let i = 0; i < n; i++) {
          const c = cells[Math.floor((i * cells.length) / n)];
          if (!c || !GEM[c.color]) continue;
          this._gem(x + w * (0.25 + i * 0.25) + (n === 1 ? w * 0.25 : 0), y + 1, cs * 0.17, c.color, false, !!c.polished, null);
        }
        if (it.perfect) {
          ctx.fillStyle = `rgba(255,230,120,${0.5 + 0.5 * Math.sin(this.t * 12 + s.d)})`;
          const sx2 = x + w * 0.85, sy2 = y + 1;
          ctx.beginPath();
          ctx.moveTo(sx2, sy2 - 4 * u); ctx.lineTo(sx2 + 1.2 * u, sy2 - 1.2 * u); ctx.lineTo(sx2 + 4 * u, sy2);
          ctx.lineTo(sx2 + 1.2 * u, sy2 + 1.2 * u); ctx.lineTo(sx2, sy2 + 4 * u); ctx.lineTo(sx2 - 1.2 * u, sy2 + 1.2 * u);
          ctx.lineTo(sx2 - 4 * u, sy2); ctx.lineTo(sx2 - 1.2 * u, sy2 - 1.2 * u);
          ctx.fill();
        }
      }
    }
  }

  _drawParticles() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      const t = p.age / p.life;
      const a = 1 - t;
      switch (p.type) {
        case "smoke":
        case "steam":
        case "dust": {
          ctx.globalAlpha = p.type === "dust" ? a : a * (p.type === "steam" ? 0.8 : 1);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size + (p.grow || 0) * t, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case "spark": {
          ctx.globalAlpha = a;
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
          break;
        }
        case "star": {
          ctx.globalAlpha = a;
          ctx.fillStyle = p.color;
          const s = p.size * (1 - t * 0.5);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s * 0.3, p.y - s * 0.3); ctx.lineTo(p.x + s, p.y);
          ctx.lineTo(p.x + s * 0.3, p.y + s * 0.3); ctx.lineTo(p.x, p.y + s); ctx.lineTo(p.x - s * 0.3, p.y + s * 0.3);
          ctx.lineTo(p.x - s, p.y); ctx.lineTo(p.x - s * 0.3, p.y - s * 0.3);
          ctx.fill();
          break;
        }
        case "confetti": {
          ctx.globalAlpha = Math.min(1, a * 2);
          ctx.fillStyle = p.color;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * (0.4 + 0.6 * Math.abs(Math.sin(p.rot * 2))));
          ctx.restore();
          break;
        }
        case "gem": {
          ctx.globalAlpha = p.target ? 1 : Math.min(1, a * 2);
          this._gem(p.x, p.y, p.size, GEM[p.color] ? p.color : "red", false, false, null);
          break;
        }
        case "crate": {
          ctx.globalAlpha = p.target ? 1 : Math.min(1, a * 2);
          ctx.drawImage(this._crateImg(p.size, false), p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawStampBox(text, x, y, color, fs, rot, scale, alpha) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    ctx.font = `900 ${fs}px "Arial Black", system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    const pw = tw + fs * 0.9, ph = fs * 1.55;
    ctx.fillStyle = "rgba(20,6,14,0.55)";
    roundRect(ctx, -pw / 2, -ph / 2, pw, ph, fs * 0.2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, fs * 0.13);
    roundRect(ctx, -pw / 2, -ph / 2, pw, ph, fs * 0.2);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, fs * 0.05);
    roundRect(ctx, -pw / 2 + fs * 0.2, -ph / 2 + fs * 0.2, pw - fs * 0.4, ph - fs * 0.4, fs * 0.12);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, fs * 0.04);
    ctx.restore();
  }

  _stampFont(text, maxW, base) {
    const ctx = this.ctx;
    ctx.font = `900 ${base}px "Arial Black", system-ui, sans-serif`;
    const w = ctx.measureText(text).width + base * 0.9;
    return w > maxW ? Math.max(8, Math.floor(base * (maxW / w))) : base;
  }

  _drawBottleneckStamp() {
    if (!this.bn) return;
    const L = this.L;
    const pos = this._stampPos(this.bn);
    const col = L.cols[this.bn];
    const base = Math.max(10, Math.round(15 * L.u));
    const fs = this._stampFont("BOTTLENECK", Math.max(col.w * 1.12, 64), base);
    const t = clamp(this.slamT / 0.16, 0, 1);
    const scale = 1 + 1.6 * (1 - easeOutCubic(t));
    const pulse = 0.85 + 0.15 * Math.sin(this.t * 5.5);
    this.ctx.font = `900 ${fs}px "Arial Black", system-ui, sans-serif`;
    const half = (this.ctx.measureText("BOTTLENECK").width + fs * 0.9) / 2;
    const x = clamp(pos.x, half + 3, L.W - half - 3);
    this._drawStampBox("BOTTLENECK", x, pos.y, C.red, fs, -0.12, scale, t * pulse);
  }

  _drawStamps() {
    const L = this.L;
    for (const s of this.stamps) {
      const pos = this._stampPos(s.stage);
      const col = L.cols[s.stage];
      const fs = this._stampFont(s.text, Math.max(col.w * 1.2, 70), Math.max(11, Math.round(17 * L.u)));
      const t = clamp(s.age / 0.14, 0, 1);
      const scale = 1 + 1.4 * (1 - easeOutCubic(t));
      const alpha = s.age > s.life - 0.4 ? (s.life - s.age) / 0.4 : t;
      this.ctx.font = `900 ${fs}px "Arial Black", system-ui, sans-serif`;
      const half = (this.ctx.measureText(s.text).width + fs * 0.9) / 2;
      const x = clamp(pos.x, half + 3, L.W - half - 3);
      this._drawStampBox(s.text, x, pos.y + fs * 1.9, s.color, fs, 0.1, scale, alpha);
    }
  }

  _drawGenerator(v) {
    if (v.vmProgress === null) return;
    const ctx = this.ctx, L = this.L, r = L.ref, u = L.u;
    const pct = Math.round(v.vmProgress * 100);
    const bw = r.bx1 - r.bx0;
    const bh = Math.max(5, 6 * u);
    const y = r.chTop - bh - Math.max(4, 6 * u);
    ctx.fillStyle = "#1a1530";
    roundRect(ctx, r.bx0, y, bw, bh, bh / 2);
    ctx.fill();
    const g = ctx.createLinearGradient(r.bx0, 0, r.bx0 + bw, 0);
    g.addColorStop(0, C.ruby);
    g.addColorStop(1, C.gold);
    ctx.fillStyle = g;
    roundRect(ctx, r.bx0, y, Math.max(bh, bw * v.vmProgress), bh, bh / 2);
    ctx.fill();
    const sx = r.bx0 + ((this.t * 60) % Math.max(1, bw * v.vmProgress));
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(sx, y, 6 * u, bh);
    const fs = Math.max(10, Math.round(11 * u));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "center";
    const long = `発電機を組み立て中… Ruby VM ${pct}%`;
    const short = `Ruby VM ${pct}%`;
    const room = Math.min(L.W - 8, bw * 2.2);
    const text = ctx.measureText(long).width <= room ? long : short;
    const half = ctx.measureText(text).width / 2;
    const cx = clamp((r.bx0 + r.bx1) / 2, half + 4, L.W - half - 4);
    this._outlined(text, cx, y - 2, C.gold);
  }

  _drawLabels(v) {
    const ctx = this.ctx, L = this.L, u = L.u;
    const fs = L.font;
    for (const s of STAGES) {
      const col = L.cols[s];
      const x0 = col.x0 + Math.max(3, 5 * u), x1 = (s === "dock" ? col.x1 : col.x1) - Math.max(3, 5 * u);
      const w = x1 - x0;
      const util = v.util[s];
      const isBn = this.bn === s;
      const cap = v.caps[s];
      ctx.fillStyle = "#120d22";
      roundRect(ctx, x0, L.barY, w, L.barH, L.barH / 2);
      ctx.fill();
      if (cap !== Infinity && util > 0) {
        const pulse = 0.5 + 0.5 * Math.sin(this.t * 5.5);
        ctx.fillStyle = isBn ? `rgb(255,${Math.round(40 + 40 * pulse)},${Math.round(70 + 30 * pulse)})` : util > 0.85 ? C.warn : desat(C.ok, this.k[s] * 0.8);
        roundRect(ctx, x0, L.barY, Math.max(L.barH, w * util), L.barH, L.barH / 2);
        ctx.fill();
      }
      // 名前と容量、右に使用率（上流は待機率）。狭いときは 2 行に分け、入らなければ率を省く
      const small = Math.max(9, fs - 1);
      const nameFont = `700 ${fs}px system-ui, sans-serif`;
      const capFont = `600 ${small}px ui-monospace, Menlo, monospace`;
      const rightFont = `700 ${small}px system-ui, sans-serif`;
      const name = STAGE_LABEL[s];
      const capText = fmtRate(cap);
      const waiting = !!this.bn && STAGES.indexOf(s) < STAGES.indexOf(this.bn) && cap !== Infinity;
      const pct = Math.round((waiting ? 1 - util : util) * 100);
      let right = cap === Infinity ? "" : waiting ? `待機 ${pct}%` : `${pct}%`;
      ctx.font = nameFont;
      const nameW = ctx.measureText(name).width;
      ctx.font = capFont;
      const capW = ctx.measureText(capText).width;
      ctx.font = rightFont;
      let rightW = ctx.measureText(right).width;
      const line2 = L.labelY + small + 2;
      const oneLine = nameW + capW + rightW + 14 <= w;
      let capPos = [x0 + nameW + 5, L.labelY];
      let rightY = L.labelY;
      if (!oneLine) {
        capPos = [x0, line2];
        if (right && nameW + rightW + 6 > w) {
          right = waiting ? `待機${pct}%` : right;
          ctx.font = rightFont;
          rightW = ctx.measureText(right).width;
          if (nameW + rightW + 4 > w) right = "";
        }
      }
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.font = nameFont;
      ctx.fillStyle = isBn ? "#ff8095" : C.ink;
      ctx.fillText(name, x0, L.labelY);
      if (capPos[1] <= L.H - 1) {
        ctx.font = capFont;
        ctx.fillStyle = C.dim;
        ctx.fillText(capText, capPos[0], capPos[1]);
      }
      if (right) {
        ctx.font = rightFont;
        ctx.textAlign = "right";
        ctx.fillStyle = waiting ? C.faint : isBn ? "#ff8095" : C.dim;
        ctx.fillText(right, x1, rightY);
      }
    }
  }

  _drawPops() {
    const ctx = this.ctx, L = this.L;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of this.pops) {
      const t = p.age / p.life;
      const sIn = easeOutBack(clamp(p.age / 0.22, 0, 1));
      const scale = 0.35 + 0.65 * sIn;
      const rise = (1 - (1 - t) ** 2) * 40 * Math.max(0.7, L.u) * (p.agg ? 0.6 : 1);
      const alpha = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
      const fs = p.size * scale;
      ctx.font = `900 ${fs.toFixed(1)}px system-ui, sans-serif`;
      const half = ctx.measureText(p.text).width / 2;
      const x = clamp(p.x + p.vx * t, half + 3, L.W - half - 3);
      const y = Math.max(fs / 2 + 2, p.y - rise);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = Math.max(2.5, fs * 0.2);
      ctx.strokeStyle = "rgba(12,6,24,0.92)";
      ctx.lineJoin = "round";
      ctx.strokeText(p.text, x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  _drawHint(v) {
    // dug は保存されないので、リロード後の終盤に出し続けないよう素通し中（序盤）に限る
    if (this.dug || this.t < 3 || !v.passthrough) return;
    const ctx = this.ctx, L = this.L, m = L.mine, u = L.u;
    const fs = Math.max(10, Math.round(11.5 * u));
    // タッチの端末では、案内の吹き出し（main.js の tapWord）と同じく「タップ」と書く
    const text = `${globalThis.matchMedia?.("(pointer: coarse)")?.matches ? "タップ" : "クリック"}で掘る`;
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    const bob = Math.sin(this.t * 4) * 2.5 * u;
    const w = tw + 12, h = fs + 9;
    const x = clamp(m.x0 + m.w * 0.38 - w / 2, 3, L.W - w - 3);
    // 鉱山に BOTTLENECK の判子があるときは、判子と重ならないよう山の中腹に下げる
    const y = (this.bn === "mine" ? m.peakY + (L.floorY - m.peakY) * 0.22 : Math.max(3, m.peakY - h - 9 * u)) + bob;
    ctx.fillStyle = "#fff6d6";
    roundRect(ctx, x, y, w, h, 5);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + w * 0.45, y + h);
    ctx.lineTo(x + w * 0.55, y + h);
    ctx.lineTo(m.x0 + m.w * 0.38, y + h + 6 * u);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#2a1a00";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 6, y + h / 2 + 0.5);
  }

  _drawCelebrate() {
    const c = this.cele;
    if (!c) return;
    const ctx = this.ctx, L = this.L, u = L.u;
    const tin = clamp(c.age / 0.35, 0, 1);
    const tout = clamp((c.age - (c.life - 0.35)) / 0.35, 0, 1);
    const off = (1 - easeOutBack(tin)) * -L.W + easeInCubic(tout) * L.W;
    const y = L.H * 0.36;
    const h = Math.max(26, 38 * u);
    ctx.save();
    ctx.translate(L.W / 2 + off, y);
    ctx.rotate(-0.05);
    const g = ctx.createLinearGradient(-L.W / 2, 0, L.W / 2, 0);
    g.addColorStop(0, "rgba(224,17,95,0)");
    g.addColorStop(0.15, "rgba(224,17,95,0.95)");
    g.addColorStop(0.85, "rgba(224,17,95,0.95)");
    g.addColorStop(1, "rgba(224,17,95,0)");
    ctx.fillStyle = g;
    ctx.fillRect(-L.W * 0.6, -h / 2, L.W * 1.2, h);
    ctx.fillStyle = C.gold;
    ctx.fillRect(-L.W * 0.6, -h / 2, L.W * 1.2, Math.max(1.5, 2 * u));
    ctx.fillRect(-L.W * 0.6, h / 2 - Math.max(1.5, 2 * u), L.W * 1.2, Math.max(1.5, 2 * u));
    const sx = ((c.age * 1.4) % 1.4 - 0.2) * L.W - L.W / 2;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.moveTo(sx, -h / 2); ctx.lineTo(sx + 30 * u, -h / 2); ctx.lineTo(sx + 10 * u, h / 2); ctx.lineTo(sx - 20 * u, h / 2);
    ctx.fill();
    let fs = Math.max(13, Math.round(22 * u));
    ctx.font = `900 ${fs}px system-ui, sans-serif`;
    const tw = ctx.measureText(c.text).width;
    if (tw > L.W - 20) { fs = Math.floor(fs * ((L.W - 20) / tw)); ctx.font = `900 ${fs}px system-ui, sans-serif`; }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const pulse = 1 + 0.06 * Math.sin(c.age * 14) * (1 - tin * 0.5);
    ctx.scale(pulse, pulse);
    ctx.lineWidth = Math.max(3, fs * 0.18);
    ctx.strokeStyle = "#3a0018";
    ctx.lineJoin = "round";
    ctx.strokeText(c.text, 0, 1);
    ctx.fillStyle = "#fff4c2";
    ctx.fillText(c.text, 0, 1);
    ctx.restore();
  }


  _gem(x, y, r, color, flaw, polished, carat) {
    const img = this._gemImg(color, r, flaw, polished);
    const s = img.width / this.dpr;
    this.ctx.drawImage(img, x - s / 2, y - s / 2, s, s);
    if (carat != null) {
      const ctx = this.ctx;
      ctx.font = `800 ${Math.max(7, r * 1.15).toFixed(0)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillText(String(carat), x, y + r * 0.08);
    }
  }

  _gemImg(color, r, flaw, polished) {
    const rp = Math.max(2, Math.round(r * this.dpr * 2) / 2);
    const key = `g${color}|${rp}|${flaw ? 1 : 0}|${polished ? 1 : 0}`;
    let c = this.imgCache.get(key);
    if (c) return c;
    const pal = GEM[color] || GEM.red;
    const R = rp;
    const size = Math.ceil(R * 2 + 4);
    c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    g.translate(size / 2, size / 2);
    const P = (pts) => { g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px * R, py * R) : g.moveTo(px * R, py * R))); g.closePath(); };
    P([[-0.6, -0.68], [0.6, -0.68], [1, -0.18], [0, 1], [-1, -0.18]]);
    g.fillStyle = pal[2];
    g.fill();
    P([[-1, -0.18], [0, -0.18], [0, 1]]);
    g.fillStyle = pal[1];
    g.fill();
    P([[-0.6, -0.68], [0.6, -0.68], [1, -0.18], [-1, -0.18]]);
    g.fillStyle = pal[1];
    g.fill();
    P([[-0.32, -0.68], [0.32, -0.68], [0.5, -0.18], [-0.5, -0.18]]);
    g.fillStyle = pal[0];
    g.fill();
    P([[-0.55, -0.6], [-0.3, -0.6], [-0.62, -0.25]]);
    g.fillStyle = "rgba(255,255,255,0.8)";
    g.fill();
    P([[-0.6, -0.68], [0.6, -0.68], [1, -0.18], [0, 1], [-1, -0.18]]);
    g.strokeStyle = "rgba(10,0,10,0.55)";
    g.lineWidth = Math.max(0.8, R * 0.09);
    g.stroke();
    if (flaw) {
      g.strokeStyle = "rgba(255,255,255,0.9)";
      g.lineWidth = Math.max(0.8, R * 0.11);
      g.beginPath();
      g.moveTo(-0.15 * R, -0.62 * R); g.lineTo(0.08 * R, -0.25 * R); g.lineTo(-0.1 * R, 0.1 * R); g.lineTo(0.12 * R, 0.5 * R);
      g.stroke();
    }
    if (polished) {
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.arc(0.55 * R, -0.75 * R, Math.max(0.8, R * 0.16), 0, Math.PI * 2);
      g.fill();
    }
    this.imgCache.set(key, c);
    return c;
  }

  _crateImg(s, perfect, xmas = false) {
    const sp = Math.max(4, Math.round(s * this.dpr));
    const key = `c${sp}|${perfect ? 1 : 0}|${xmas ? 1 : 0}`;
    let c = this.imgCache.get(key);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = sp;
    const g = c.getContext("2d");
    const b = Math.max(1, sp * 0.1);
    g.fillStyle = C.woodLo;
    g.fillRect(0, 0, sp, sp);
    g.fillStyle = C.wood;
    g.fillRect(b, b, sp - b * 2, sp - b * 2);
    g.strokeStyle = C.woodLo;
    g.lineWidth = Math.max(1, sp * 0.06);
    for (const f of [0.38, 0.62]) { g.beginPath(); g.moveTo(b, sp * f); g.lineTo(sp - b, sp * f); g.stroke(); }
    g.lineWidth = Math.max(1, sp * 0.1);
    g.beginPath(); g.moveTo(b, sp - b); g.lineTo(sp - b, b); g.stroke();
    g.fillStyle = C.woodHi;
    g.fillRect(0, 0, sp, Math.max(1, sp * 0.1));
    // クリスマス便（carat の合計 25）の箱は、緑のリボンを十字に掛けて赤い結び目を付ける
    if (xmas) {
      const rw = Math.max(1.5, sp * 0.16);
      g.fillStyle = "#1fbf75";
      g.fillRect((sp - rw) / 2, 0, rw, sp);
      g.fillRect(0, (sp - rw) / 2, sp, rw);
      g.fillStyle = "#e0115f";
      g.beginPath();
      g.arc(sp / 2, sp / 2, rw * 0.9, 0, Math.PI * 2);
      g.fill();
    }
    if (perfect) {
      g.strokeStyle = C.gold;
      g.lineWidth = Math.max(1.5, sp * 0.12);
      g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, sp - g.lineWidth, sp - g.lineWidth);
    }
    this.imgCache.set(key, c);
    return c;
  }
}
