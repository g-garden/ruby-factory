// 通しプレイのボット。実ブラウザ（headless Chromium）・実 ruby.wasm・実時間で、空の localStorage からリリース（エンディング）まで遊ぶ。
//
//   node dev/playthrough.mjs <出力先ディレクトリ> [--max-sec 3600] [--base URL] [--save-sec 0] [--buy-per-sec 4]
//                               [--click-sec 40] [--sort-sec 30] [--sort-block 1] [--backdoor]
//
// 方針（人間らしく。?debug は state を読むためだけに使い、addMoney / setTimeScale / buy / deploy は呼ばない）
// - 最初の --click-sec 秒は鉱山を 1 秒に 2 回クリック。初回デプロイまではつるはしを 5 本まで買い、デプロイボタンが押せたら押す
// - 以降はショップで赤い（BOTTLENECK、.shop-group.hot）段の買えるものを、1 秒に --buy-per-sec 個まで買う。
//   段の中では「容量の増分 ÷ 値段」が一番よいものを選ぶ
// - 研究は条件を満たして買えるようになったらすぐ買う。既定では研究のために貯めない（--save-sec 0）。
//   --save-sec N を付けると、次の研究が「収入の N 秒ぶん」以下の値段のあいだショップで使わずに貯める（SPEC 11.3 のボットの規則）
// - 研究を買うたびに、その研究に合ったコードをエディタに入れてデプロイする（data/balance.js の SAMPLE_CODE。ヒント 3 段目の完成コード）
//   整列（sorter）の直後だけ sort { } 版を --sort-sec 秒走らせてから sort_by 版に替える
// - 単価記録の条件（ストレートの $400 など）でお金はあるのに買えない状態になったら、画面の案内を記録してから記録を伸ばすコードに替える
// - release を買ってエンディングが出たら終了
// - --backdoor（SPEC-rubyist 6 章 10 の「全部使う」）: 研究ごとのコードの先頭に、2 車線・合鍵・36 協定・def Yield.tick の再定義を足す
//   （鑑定は監査ラインで止まる）。初回デプロイ（初期コード）だけは足さない
//
// 出力: <out>/result.json（10 秒ごとと研究ごとに上書き）と画面写真。最後に要約を標準出力に出す
//   result.json の画面写真は <out> からの相対名で持ち、手元の絶対パスを残さない
//   idle.top5 は「ショップにも研究にも afford がない」区間。idle.waitOnly は「赤い段に afford がなく研究も買えない」
//   （このボットの方針で待つだけになる）区間。関門では Gemfile の行の状態・requires 行・エディタの案内・行を押したときのログを残す
import { chromium, launchOptions } from "./pw.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BELTS, CPUS, DOCKS, MINES, RESEARCH, SAMPLE_CODE } from "../data/balance.js";
import { priceOf } from "../src/economy.js";


const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const FLAGS = new Set(["--backdoor"]);
const OUT = path.resolve(argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !FLAGS.has(argv[i - 1]))) ?? "playthrough-out");
const BACKDOOR = argv.includes("--backdoor");
const BASE = opt("--base", "http://localhost:8940/ruby-factory/");
const MAX_SEC = Number(opt("--max-sec", 3600));
const SAVE_SEC = Number(opt("--save-sec", 0));
const BUY_PER_SEC = Number(opt("--buy-per-sec", 4));
const CLICK_SEC = Number(opt("--click-sec", 40));
const SORT_SEC = Number(opt("--sort-sec", 30));
const SORT_BLOCK = opt("--sort-block", "1") !== "0";
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAGES = ["mine", "belt", "refinery", "dock"];
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// 研究ごとにデプロイするコード（null は書き換えない）
const CODE_FOR = {
  crate: SAMPLE_CODE.eachSlice,
  inspector: SAMPLE_CODE.reject,
  sorter: SORT_BLOCK ? SAMPLE_CODE.sortBlock : SAMPLE_CODE.sortBy,
  sapphire: null,
  monochrome: SAMPLE_CODE.groupBy,
  crate_5: null,
  straight: SAMPLE_CODE.straightAll,
  christmas: SAMPLE_CODE.christmas,
  polish: SAMPLE_CODE.polishHoles,
  emerald: null,
  ractor: null,
  crate_7: null,
  yjit: null,
  crate_9: null,
};
// --backdoor の前置き。コードはすべて wrap を通す（currentBestCode・lastGoodCode との一致と codeName のため）
const BACKDOOR_PREFIX = `Yield.instance_variable_set(:@lanes, 2)
YF_KEY = ObjectSpace.each_object(Class).find { it.name.nil? && it.method_defined?(:turn) }
ObjectSpace.each_object(YF_KEY).first.turn
Yield.残業させてください
def Yield.tick(*) = nil
`;
const wrap = (c) => (BACKDOOR && c ? BACKDOOR_PREFIX + c : c);
const unwrap = (c) => (c?.startsWith(BACKDOOR_PREFIX) ? c.slice(BACKDOOR_PREFIX.length) : c);
const CODE_NAME = new Map(Object.entries(SAMPLE_CODE).map(([k, v]) => [v, k]));
const codeName = (c) => {
  const u = unwrap(c);
  const n = CODE_NAME.get(u) ?? (u?.includes("map { [it] }") ? "initial" : "other");
  return u !== c ? `${n}+backdoor` : n;
};

// ---------------------------------------------------------------- 結果
const R = {
  meta: { base: BASE, startedAt: new Date().toISOString(), viewport: "1280x800", policy: { clickSec: CLICK_SEC, clicksPerSec: 2, buyPerSec: BUY_PER_SEC, saveSec: SAVE_SEC, sortSec: SORT_SEC, sortBlock: SORT_BLOCK, backdoor: BACKDOOR, buyChoice: "赤い段（.shop-group.hot）の afford な品から 容量増分/値段 最大" } },
  reachedEnding: false,
  endReason: null,
  totalSec: null,
  firstDeploy: null,
  research: [],
  deploys: [],
  gates: [],
  bannerChanges: [],
  timeline: [], // 1 秒ごと
  red: null,
  idle: null,
  sortExperiment: null,
  ending: null,
  screenshots: [],
  console: { errors: [], warnings: [], pageErrors: [], requestFailed: [] },
  workers: { created: 0, closed: 0 },
  restarts: { runtime: 0, statsRestarts: 0 },
  awayLines: [],
  logLines: [],
  periodic: [],
  droppedDt: [], // 研究カードの待ちなどで 1 ティックが 5 秒以上空いた分（赤の積算に入れていない）
  purchases: [], // ショップで買ったもの { t, item, stage }
  maxedBelt: { note: "最終段のベルトが赤いときのショップの行（.item.maxed）の文面。5 秒ごと", first: null, samples: [], diag: {} },
};
const writeJson = () => {
  try {
    writeFileSync(path.join(OUT, "result.json"), JSON.stringify(R, null, 1));
  } catch (e) {
    console.error("write failed", e.message);
  }
};

// ---------------------------------------------------------------- ブラウザ
const browser = await chromium.launch(launchOptions);
const origin = new URL(BASE).origin;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
try {
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
} catch (e) {
  R.meta.clipboardPermission = `付与できず: ${e.message}`;
}
const page = await ctx.newPage();
page.on("console", (m) => {
  const t = m.type();
  const rec = { t: tsec(), text: m.text().slice(0, 500), url: m.location()?.url ?? "" };
  if (t === "error") R.console.errors.push(rec);
  else if (t === "warning") R.console.warnings.push(rec);
});
page.on("pageerror", (e) => R.console.pageErrors.push({ t: tsec(), text: String(e?.message ?? e).slice(0, 500) }));
page.on("requestfailed", (r) => R.console.requestFailed.push({ t: tsec(), url: r.url(), err: r.failure()?.errorText }));
page.on("worker", (w) => {
  R.workers.created++;
  w.on("close", () => R.workers.closed++);
});

let T0 = null;
function tsec() {
  return T0 == null ? 0 : (Date.now() - T0) / 1000;
}

const shot = async (name, { el = null } = {}) => {
  const file = path.join(OUT, name);
  try {
    if (el) await page.locator(el).first().screenshot({ path: file });
    else await page.screenshot({ path: file });
    R.screenshots.push({ t: +tsec().toFixed(1), file: name });
  } catch (e) {
    R.screenshots.push({ t: +tsec().toFixed(1), file: name, error: e.message });
  }
  return name;
};

// ---------------------------------------------------------------- 読み取り（1 回の evaluate）
const READ = () => {
  const d = { ...document.body.dataset };
  const yf = window.__yf;
  const st = yf?.state;
  const hot = document.querySelector(".shop-group.hot")?.dataset.stage ?? null;
  const banner = document.querySelector("#banner");
  const overlay = document.querySelector("#overlay");
  const next = document.querySelector("#gemfile .gem.next");
  const shopAfford = [...document.querySelectorAll("#shop .item.afford:not([hidden])")];
  const hotAfford = hot ? [...document.querySelectorAll(`.shop-group.hot .item.afford:not([hidden])`)].map((b) => b.dataset.buy) : [];
  const logs = window.__pt_logs ?? [];
  window.__pt_logs = [];
  return {
    d,
    hot,
    shopAfford: shopAfford.length,
    hotAfford,
    gemAfford: document.querySelectorAll("#gemfile .gem.afford").length,
    next: next ? { key: next.dataset.research, afford: next.classList.contains("afford"), unmet: next.classList.contains("unmet"), req: next.querySelector(".gem-req")?.textContent ?? "", tip: next.querySelector(".gem-tip")?.textContent ?? "", status: next.querySelector(".gem-status")?.textContent ?? "" } : null,
    banner: banner && !banner.hidden ? banner.innerText : "",
    overlay: overlay && !overlay.hidden ? overlay.dataset.kind ?? "?" : null,
    todo: (() => { const t = document.querySelector("#todo"); return t && !t.hidden ? t.textContent : ""; })(),
    income: yf?.flow?.incomePerSec ?? null,
    caps: yf?.flow?.caps ?? null,
    restarts: yf?.runtime?.restarts ?? null,
    stats: st ? { ...st.stats } : null,
    owned: st ? { mines: { ...st.mines }, cpus: { ...st.cpus }, docks: { ...st.docks }, belt: st.belt, research: [...st.research] } : null,
    lastGoodCode: st?.lastGoodCode ?? null,
    hudIncome: document.querySelector("#hud")?.innerText?.replace(/\s+/g, " ").slice(0, 200) ?? "",
    maxedMeta: document.querySelector("#shop .item.maxed .item-meta")?.textContent ?? "",
    logs,
  };
};

const installObservers = () => page.evaluate(() => {
  window.__pt_logs = [];
  const log = document.querySelector("#log");
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) window.__pt_logs.push(n.textContent);
  }).observe(log, { childList: true });
});

// ---------------------------------------------------------------- 操作
async function clickMine() {
  const b = await page.locator("#factory").boundingBox();
  if (b) await page.mouse.click(b.x + b.width * 0.07, b.y + b.height * 0.55);
}

async function closeOverlay() {
  for (let i = 0; i < 3; i++) {
    const open = await page.evaluate(() => !document.querySelector("#overlay")?.hidden);
    if (!open) return;
    await page.keyboard.press("Escape");
    await sleep(80);
  }
}

const RATE = {
  mine: Object.fromEntries(MINES.map((x) => [x.key, x.rate])),
  cpu: Object.fromEntries(CPUS.map((x) => [x.key, x.rate])),
  dock: Object.fromEntries(DOCKS.map((x) => [x.key, x.rate])),
};
function gainPerDollar(buyKey, owned, money) {
  const [kind, key] = buyKey.split(":");
  const s = { ...owned, money };
  if (kind === "belt") {
    const cur = BELTS[owned.belt ?? 0], nx = BELTS[(owned.belt ?? 0) + 1];
    if (!nx) return -1;
    return (nx.cap - cur.cap) / nx.price;
  }
  const price = priceOf(s, kind, key);
  return RATE[kind][key] / price;
}

/** UI でデプロイ（エディタに入れてデプロイボタン、または Ctrl+Enter）。成功を確かめて、だめなら 1 回やり直す */
async function deployUI(code, { viaKey = false, why = "" } = {}) {
  const t = tsec();
  await closeOverlay();
  let ok = false;
  let tries = 0;
  for (; tries < 2 && !ok; tries++) {
    await page.fill("#code", code);
    if (viaKey) {
      await page.focus("#code");
      await page.keyboard.press("Control+Enter");
    } else {
      await page.click("#deploy", { timeout: 5000 }).catch(() => {});
    }
    const t1 = Date.now();
    while (Date.now() - t1 < 1000 && (await page.evaluate(() => document.body.dataset.deploying)) !== "1") await sleep(20);
    const t2 = Date.now();
    while (Date.now() - t2 < 9000 && (await page.evaluate(() => document.body.dataset.deploying)) !== "0") await sleep(50);
    await sleep(150);
    ok = (await page.evaluate(() => window.__yf.state.lastGoodCode)) === code;
    if (!ok) await sleep(1000);
  }
  const banner = await page.evaluate(() => { const b = document.querySelector("#banner"); return b && !b.hidden ? b.innerText : ""; });
  const ticket = await page.evaluate(() => { const b = document.querySelector("#ticket"); return b && !b.hidden ? b.innerText : ""; });
  const rec = { t: +t.toFixed(1), code: codeName(code), why, viaKey, ok, tries, ms: Math.round((tsec() - t) * 1000), banner, ticket };
  R.deploys.push(rec);
  console.log(`[${fmtT(t)}] deploy ${rec.code}${viaKey ? " (Ctrl+Enter)" : ""} ok=${ok} ${banner.split("\n")[0] ?? ""}`);
  return rec;
}

// ---------------------------------------------------------------- 集計用
const redHot = Object.fromEntries(STAGES.map((s) => [s, 0]));
const redData = Object.fromEntries(STAGES.map((s) => [s, 0]));
const runs = { hot: [], data: [] }; // 連続区間 { stage, start, end }
const curRun = { hot: null, data: null };
function addRun(kind, stage, t, dt) {
  const c = curRun[kind];
  if (c && c.stage === stage) {
    c.end = t;
    return;
  }
  if (c) runs[kind].push(c);
  curRun[kind] = stage ? { stage, start: +(t - dt).toFixed(1), end: t } : null;
}
const idle = [];
let idleStart = null;
const hotIdle = [];
let hotIdleStart = null;
let lastBanner = "";
let lastSampleSec = -1;
let lastTickT = null;
let sortWin = null; // { from, to, refineryRedHot, refineryRedData, samples }

// ---------------------------------------------------------------- 研究イベント
const gatesSeen = new Set();
let pendingSortSwitchAt = null;
let currentBestCode = SAMPLE_CODE.initial;

async function onResearch(key, r) {
  const def = RESEARCH.find((x) => x.key === key);
  const t = tsec();
  const ev = {
    key, label: def.label, t: +t.toFixed(1), clock: fmtT(t), price: def.price,
    incomeBefore: r.income, valuePerOreBefore: Number(r.d.valuePerOre), recordBefore: Number(r.d.record), moneyBefore: Number(r.d.money),
    bottleneckHot: r.hot, bottleneckData: r.d.bottleneck, codeBefore: codeName(r.lastGoodCode),
  };
  await page.click(`[data-research="${key}"]`, { timeout: 3000 });
  await sleep(700);
  const bought = (await page.evaluate(() => document.body.dataset.research)).split(",").includes(key);
  ev.bought = bought;
  if (!bought) {
    ev.note = "クリックしたが研究に入らなかった";
    R.research.push(ev);
    return;
  }
  if (key === "release") {
    await sleep(1500);
    R.reachedEnding = await page.locator(".card.ending").isVisible();
    ev.endingVisible = R.reachedEnding;
    await shot("ending.png");
    await shot("ending-card.png", { el: ".card.ending" });
    const tableText = await page.locator(".card.ending").innerText().catch(() => "");
    let clip = null;
    try {
      await page.getByText("成績表をコピー").click({ timeout: 2000 });
      await sleep(400);
      clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `読めず: ${e.message}`);
    } catch (e) {
      clip = `コピーボタン失敗: ${e.message}`;
    }
    const copied = await page.locator(".card.ending .copied").innerText().catch(() => "");
    R.ending = { t: +t.toFixed(1), clock: fmtT(t), cardText: tableText, clipboard: clip, copiedLabel: copied };
    R.research.push(ev);
    return;
  }
  // カードを撮る（Ractor / YJIT は本物のエラー文の打ち終わりを待つ。ストレートはヒント 2・3 を開く）
  if (def.effect.rubyProbe) {
    const t1 = Date.now();
    let probeText = "";
    while (Date.now() - t1 < 8000) {
      probeText = await page.locator(".card-code.probe").innerText().catch(() => "");
      if (def.probeNote && probeText.includes(def.probeNote)) break;
      await sleep(200);
    }
    ev.probeText = probeText;
    await shot(`research-${key}.png`);
    await shot(`research-${key}-card.png`, { el: ".card.research" });
  } else if (key === "straight") {
    await shot(`research-straight-hint1.png`, { el: ".card.research" });
    await page.getByText("ヒント 2: 雛形を見る").click({ timeout: 2000 }).catch(() => {});
    await sleep(200);
    await page.getByText("ヒント 3: 完成コード").click({ timeout: 2000 }).catch(() => {});
    await sleep(300);
    ev.cardText = await page.locator(".card.research").innerText().catch(() => "");
    await shot(`research-straight-hints.png`);
    await shot(`research-straight-hints-card.png`, { el: ".card.research" });
  } else {
    await shot(`research-${key}.png`);
  }
  await closeOverlay();
  // 研究そのものの倍率バナー（box・色は次のバッチで出る）
  const tb = Date.now();
  let rb = "";
  const waitMs = def.effect.rubyProbe ? 7000 : 4000;
  while (Date.now() - tb < waitMs) {
    rb = await page.evaluate(() => { const b = document.querySelector("#banner"); return b && !b.hidden ? b.innerText : ""; });
    if (rb && rb !== lastBanner && /研究「/.test(rb)) break;
    await sleep(150);
  }
  ev.researchBanner = /研究「/.test(rb) ? rb : "";
  if (def.effect.rubyProbe) {
    ev.bannerWaitMs = Date.now() - tb;
    await shot(`research-${key}-banner.png`);
  }
  // 研究に合ったコード
  let code = wrap(CODE_FOR[key]);
  if (code && code !== currentBestCode) {
    const dep = await deployUI(code, { viaKey: key === "crate", why: `research:${key}` });
    ev.deploy = { code: codeName(code), ok: dep.ok, banner: dep.banner, ticket: dep.ticket };
    if (dep.ok) currentBestCode = code;
    if (key === "sorter" && SORT_BLOCK && dep.ok) {
      pendingSortSwitchAt = tsec() + SORT_SEC;
      sortWin = { from: +tsec().toFixed(1), to: null, refineryRedHot: 0, refineryRedData: 0, samples: [], ops: [] };
    }
  } else {
    ev.deploy = null;
  }
  await sleep(300);
  const after = await page.evaluate(READ);
  for (const l of after.logs) R.logLines.push({ t: +tsec().toFixed(1), l });
  ev.valuePerOreAfter = Number(after.d.valuePerOre);
  ev.incomeAfter = after.income;
  ev.opsPerOreAfter = Number(after.d.opsPerOre);
  ev.recordAfter = Number(after.d.record);
  R.research.push(ev);
  console.log(`[${ev.clock}] research ${key} $${def.price} income ${Number(ev.incomeBefore).toPrecision(3)}/s vpo ${ev.valuePerOreBefore.toFixed(1)} → ${ev.valuePerOreAfter.toFixed(1)} | ${ev.researchBanner.split("\n")[0] ?? ""}`);
  writeJson();
}

async function onGate(r) {
  const key = r.next.key;
  if (gatesSeen.has(key)) return;
  gatesSeen.add(key);
  const def = RESEARCH.find((x) => x.key === key);
  const t = tsec();
  const logTail = await page.evaluate(() => [...document.querySelectorAll("#log .ln")].slice(-10).map((e) => e.textContent));
  const g = { key, t: +t.toFixed(1), clock: fmtT(t), price: def.price, money: Number(r.d.money), record: Number(r.d.record), need: def.requires?.record,
    gemReq: r.next.req, gemTip: r.next.tip, gemStatus: r.next.status, todo: r.todo, banner: r.banner, logTail, code: codeName(r.lastGoodCode) };
  g.shot = await shot(`gate-${key}.png`);
  // 行を押したときにログに出る一言（requires.note）
  await page.click(`[data-research="${key}"]`, { timeout: 2000 }).catch(() => {});
  await sleep(400);
  const clickLogs = await page.evaluate(() => { const l = window.__pt_logs ?? []; window.__pt_logs = []; return l; });
  for (const l of clickLogs) R.logLines.push({ t: +tsec().toFixed(1), l });
  g.clickLog = clickLogs;
  g.shotGem = await shot(`gate-${key}-gemfile.png`, { el: "#gemfile" });
  // 記録を伸ばすコード
  const res = new Set(r.owned.research);
  const better = wrap(res.has("polish") ? SAMPLE_CODE.polishHoles : res.has("christmas") ? SAMPLE_CODE.christmas : res.has("straight") ? SAMPLE_CODE.straightAll : SAMPLE_CODE.groupBy);
  if (better !== r.lastGoodCode) {
    const dep = await deployUI(better, { why: `gate:${key}` });
    g.deployed = { code: codeName(better), ok: dep.ok, banner: dep.banner };
    if (dep.ok) currentBestCode = better;
  } else g.deployed = null;
  R.gates.push(g);
  console.log(`[${g.clock}] GATE ${key}: money ${g.money.toPrecision(3)} >= ${def.price} but record ${g.record.toFixed(1)} < ${g.need}`);
  writeJson();
}

// ---------------------------------------------------------------- メイン
let stopping = false;
const finish = (reason) => {
  if (R.endReason == null) R.endReason = reason;
};
process.on("SIGTERM", () => { stopping = true; finish("SIGTERM"); });
process.on("SIGINT", () => { stopping = true; finish("SIGINT"); });

try {
  const resp = await page.goto(BASE + "?debug", { waitUntil: "load" });
  R.meta.httpStatus = resp?.status();
  T0 = Date.now();
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  // localStorage は新しい context なので空。念のため clear してからリロードはしない（clear 前に書かれたセーブは無い）
  // waitForFunction は文字列の評価を使うので、ページの CSP（unsafe-eval なし）で止まる。page.evaluate で待つ
  for (let t0 = Date.now(); !(await page.evaluate(() => !!window.__yf && !!document.querySelector("#log"))); await sleep(100)) {
    if (Date.now() - t0 > 15000) throw new Error("ゲームの準備が 15 秒以内に終わりませんでした");
  }
  await installObservers();
  R.meta.initialSave = await page.evaluate(() => !!localStorage.getItem("yield-factory/v1"));

  let lastClick = 0;
  let buyTokens = 0;
  let lastWrite = Date.now();
  let lastPeriodicShot = 0;
  let firstDeployDone = false;

  while (!stopping) {
    const t = tsec();
    if (t > MAX_SEC) { finish("max-sec"); break; }
    const r = await page.evaluate(READ);
    for (const l of r.logs) {
      R.logLines.push({ t: +t.toFixed(1), l });
      if (/離れていた/.test(l)) R.awayLines.push({ t: +t.toFixed(1), l });
    }
    const dt = lastTickT == null ? 0 : t - lastTickT;
    lastTickT = t;
    const deployed = r.d.deployed === "1";

    // 赤の積算（dt を前回までの状態に足すのではなく、いまの状態に足す。tick は 0.1〜0.3 秒）
    if (deployed && dt >= 5) R.droppedDt.push({ t: +t.toFixed(1), dt: +dt.toFixed(1), hot: r.hot, data: r.d.bottleneck });
    if (deployed && dt > 0 && dt < 5) {
      if (r.hot) redHot[r.hot] += dt;
      if (r.d.bottleneck && r.d.bottleneck !== "none") redData[r.d.bottleneck] += dt;
      addRun("hot", r.hot, +t.toFixed(1), dt);
      addRun("data", r.d.bottleneck !== "none" ? r.d.bottleneck : null, +t.toFixed(1), dt);
      if (sortWin && sortWin.to == null && t - dt >= sortWin.from - 0.01) {
        if (r.hot === "refinery") sortWin.refineryRedHot += dt;
        if (r.d.bottleneck === "refinery") sortWin.refineryRedData += dt;
      }
    }
    // 何も買えない区間（ショップにも研究にも afford がない）
    const nothing = r.shopAfford === 0 && r.gemAfford === 0;
    if (nothing && idleStart == null) idleStart = t;
    if (!nothing && idleStart != null) {
      idle.push({ start: +idleStart.toFixed(1), clock: fmtT(idleStart), len: +(t - idleStart).toFixed(1), research: r.owned?.research.length ?? 0 });
      idleStart = null;
    }
    // 方針として待つだけの区間（デプロイ後、赤い段に買えるものがなく、研究も買えない。赤以外の段に afford があっても数える）
    const waitOnly = deployed && r.hotAfford.length === 0 && !(r.next && r.next.afford);
    if (waitOnly && hotIdleStart == null) hotIdleStart = { t, hot: r.hot, next: r.next?.key ?? null };
    if (!waitOnly && hotIdleStart != null) {
      hotIdle.push({ start: +hotIdleStart.t.toFixed(1), clock: fmtT(hotIdleStart.t), len: +(t - hotIdleStart.t).toFixed(1), hot: hotIdleStart.hot, hotEnd: r.hot, next: hotIdleStart.next, research: r.owned?.research.length ?? 0 });
      hotIdleStart = null;
    }
    // バナーの変化
    if (r.banner !== lastBanner) {
      if (r.banner) R.bannerChanges.push({ t: +t.toFixed(1), clock: fmtT(t), text: r.banner });
      lastBanner = r.banner;
    }
    // 1 秒ごとのサンプル
    const sec = Math.floor(t);
    if (sec !== lastSampleSec) {
      lastSampleSec = sec;
      const smp = { t: sec, money: Number(r.d.money), income: r.income, vpo: Number(r.d.valuePerOre), record: Number(r.d.record), ops: Number(r.d.opsPerOre),
        bnHot: r.hot, bnData: r.d.bottleneck, refinery: r.d.refinery, shopAfford: r.shopAfford, gemAfford: r.gemAfford, next: r.next?.key ?? null,
        nResearch: r.owned?.research.length ?? 0, restarts: r.restarts, code: codeName(r.lastGoodCode) };
      R.timeline.push(smp);
      if (sortWin && sortWin.to == null && t >= sortWin.from) {
        sortWin.samples.push({ t: sec, bnHot: r.hot, bnData: r.d.bottleneck, ops: smp.ops, income: r.income, money: smp.money, caps: r.caps });
        // 1 秒サンプルで数えた赤（dt 積算は研究処理の時間を含みうるので、こちらを主に使う）
        if (r.hot === "refinery") sortWin.refineryRedHotSamples = (sortWin.refineryRedHotSamples ?? 0) + 1;
        if (r.d.bottleneck === "refinery") sortWin.refineryRedDataSamples = (sortWin.refineryRedDataSamples ?? 0) + 1;
      }
      R.restarts.runtime = r.restarts;
      R.restarts.statsRestarts = r.stats?.restarts ?? null;
    }
    if (Date.now() - lastWrite > 10000) {
      lastWrite = Date.now();
      R.red = summarizeRed();
      R.idle = summarizeIdle();
      writeJson();
    }
    if (t - lastPeriodicShot >= 300) {
      lastPeriodicShot = t;
      const name = `periodic-${String(Math.floor(t / 60)).padStart(2, "0")}m.png`;
      await shot(name);
      R.periodic.push({ t: +t.toFixed(1), file: name, hud: r.hudIncome, research: r.owned?.research.join(",") });
    }

    // 最終段のベルトが赤いときの案内（ショップの行・診断カード）
    if (r.maxedMeta) {
      const ms = R.maxedBelt.samples;
      if (!ms.length || t - ms[ms.length - 1].t >= 5) ms.push({ t: +t.toFixed(1), clock: fmtT(t), text: r.maxedMeta, next: r.next?.key ?? null, money: Number(r.d.money), income: r.income });
      if (!R.maxedBelt.first) {
        R.maxedBelt.first = { t: +t.toFixed(1), clock: fmtT(t), text: r.maxedMeta, research: r.owned?.research.join(",") };
        R.maxedBelt.first.shotShop = await shot("shop-belt-maxed.png", { el: "#shop" });
      }
      if (r.next && ["crate_9", "release"].includes(r.next.key) && !R.maxedBelt.diag[r.next.key] && !r.overlay) {
        // ベルトの段の見出しを押して診断カードを開き、文面と写真を残す
        await page.click('.shop-group[data-stage="belt"] .shop-head', { timeout: 1500 }).catch(() => {});
        await sleep(400);
        const txt = await page.evaluate(() => { const o = document.querySelector("#overlay"); return o && !o.hidden ? o.innerText : ""; });
        R.maxedBelt.diag[r.next.key] = { t: +tsec().toFixed(1), clock: fmtT(tsec()), text: txt, shot: await shot(`diag-belt-maxed-${r.next.key}.png`) };
        await closeOverlay();
        continue;
      }
    }

    // ---- 行動 ----
    if (r.overlay) await closeOverlay();

    // クリック（最初の CLICK_SEC 秒、1 秒に 2 回）
    if (t < CLICK_SEC && Date.now() - lastClick >= 500) {
      lastClick = Date.now();
      await clickMine();
    }

    // 初回デプロイまで: つるはしを 5 本、そろってボタンが押せたら初期コードのままデプロイ
    if (!deployed) {
      if (Number(r.d.pickaxes) < 5 && r.hotAfford.length === 0) {
        const can = await page.locator('[data-buy="mine:pickaxe"].afford').count();
        if (can) await page.click('[data-buy="mine:pickaxe"]', { timeout: 1000 }).catch(() => {});
      }
      if (r.d.deployReady === "1" && !firstDeployDone) {
        firstDeployDone = true;
        await page.click("#deploy");
        const t1 = Date.now();
        let b = "";
        while (Date.now() - t1 < 8000) {
          b = await page.evaluate(() => { const x = document.querySelector("#banner"); return x && !x.hidden ? x.innerText : ""; });
          if (b) break;
          await sleep(100);
        }
        R.firstDeploy = { t: +tsec().toFixed(1), clock: fmtT(tsec()), banner: b, vmReadyBefore: r.d.vm };
        R.deploys.push({ t: +t.toFixed(1), code: "initial", why: "first", ok: true, banner: b });
        console.log(`[${fmtT(t)}] first deploy: ${b.split("\n")[0]}`);
        await shot("first-deploy.png");
      }
      await sleep(100);
      continue;
    }

    // 研究（買えるならすぐ）
    if (r.next && r.next.afford) {
      await onResearch(r.next.key, r);
      if (R.ending) { finish("ending"); break; }
      continue;
    }
    // 単価記録の条件で、お金はあるのに買えない
    if (r.next && r.next.unmet) {
      const def = RESEARCH.find((x) => x.key === r.next.key);
      if (Number(r.d.money) >= def.price) await onGate(r);
    }
    // sort { } → sort_by
    if (pendingSortSwitchAt != null && t >= pendingSortSwitchAt) {
      pendingSortSwitchAt = null;
      sortWin.to = +t.toFixed(1);
      const dep = await deployUI(wrap(SAMPLE_CODE.sortBy), { why: "sort-switch" });
      if (dep.ok) currentBestCode = wrap(SAMPLE_CODE.sortBy);
      sortWin.switchDeploy = { ok: dep.ok, banner: dep.banner };
      R.sortExperiment = sortWin;
      writeJson();
      continue;
    }

    // ショップ: 赤い段（研究のために貯める間は買わない）
    buyTokens = Math.min(BUY_PER_SEC, buyTokens + dt * BUY_PER_SEC);
    let saving = false;
    if (r.next && !r.next.unmet && SAVE_SEC > 0) {
      const def = RESEARCH.find((x) => x.key === r.next.key);
      saving = def.price <= (r.income ?? 0) * SAVE_SEC;
    }
    if (!saving && buyTokens >= 1 && r.hotAfford.length > 0) {
      const money = Number(r.d.money);
      let best = null, bestV = -Infinity;
      for (const k of r.hotAfford) {
        const v = gainPerDollar(k, r.owned, money);
        if (v > bestV) { bestV = v; best = k; }
      }
      if (best) {
        const okClick = await page.click(`[data-buy="${best}"]`, { timeout: 1000 }).then(() => true).catch(() => false);
        if (okClick) R.purchases.push({ t: +t.toFixed(1), item: best, stage: r.hot });
        buyTokens -= 1;
      }
    }
    await sleep(120);
  }
} catch (e) {
  console.error(e);
  R.scriptError = String(e?.stack ?? e);
  finish("script-error");
  await shot("script-error.png").catch(() => {});
} finally {
  R.totalSec = +tsec().toFixed(1);
  if (idleStart != null) idle.push({ start: +idleStart.toFixed(1), clock: fmtT(idleStart), len: +(tsec() - idleStart).toFixed(1), open: true });
  if (hotIdleStart != null) hotIdle.push({ start: +hotIdleStart.t.toFixed(1), clock: fmtT(hotIdleStart.t), len: +(tsec() - hotIdleStart.t).toFixed(1), hot: hotIdleStart.hot, next: hotIdleStart.next, open: true });
  for (const k of ["hot", "data"]) if (curRun[k]) runs[k].push(curRun[k]);
  R.red = summarizeRed();
  R.idle = summarizeIdle();
  if (sortWin && !R.sortExperiment) R.sortExperiment = sortWin;
  try {
    R.finalState = await page.evaluate(() => ({ stats: window.__yf.state.stats, record: window.__yf.state.record, research: window.__yf.state.research, money: window.__yf.state.money, achievements: window.__yf.state.achievements, restarts: window.__yf.runtime.restarts,
      notebook: window.__yf.state.notebook ?? null, backdoor: window.__yf.state.backdoor ?? null, audits: window.__yf.state.audits ?? null }));
  } catch {}
  writeJson();
  await browser.close().catch(() => {});
  printSummary();
}

function summarizeRed() {
  const out = {};
  for (const [kind, src] of [["hot", redHot], ["data", redData]]) {
    const all = [...runs[kind], ...(curRun[kind] ? [curRun[kind]] : [])];
    out[kind] = {};
    for (const s of STAGES) {
      const mine = all.filter((x) => x.stage === s).map((x) => ({ ...x, len: +(x.end - x.start).toFixed(1) }));
      mine.sort((a, b) => b.len - a.len);
      out[kind][s] = { totalSec: +src[s].toFixed(1), longest: mine[0] ? { start: mine[0].start, clock: fmtT(mine[0].start), len: mine[0].len } : null, runs: mine.length };
    }
    out[kind].switches = all.length;
  }
  return out;
}
function summarizeIdle() {
  const all = [...idle];
  const sorted = [...all].sort((a, b) => b.len - a.len);
  const w = [...hotIdle, ...(hotIdleStart != null ? [{ start: +hotIdleStart.t.toFixed(1), clock: fmtT(hotIdleStart.t), len: +(tsec() - hotIdleStart.t).toFixed(1), hot: hotIdleStart.hot, next: hotIdleStart.next, open: true }] : [])];
  const ws = [...w].sort((a, b) => b.len - a.len);
  return { count: all.length, totalSec: +all.reduce((s, x) => s + x.len, 0).toFixed(1), top5: sorted.slice(0, 5), over10s: all.filter((x) => x.len >= 10),
    waitOnly: { note: "デプロイ後、赤い段に afford なし かつ 研究も afford なし", count: w.length, totalSec: +w.reduce((s, x) => s + x.len, 0).toFixed(1), top5: ws.slice(0, 5), over60s: w.filter((x) => x.len >= 60), over90s: w.filter((x) => x.len >= 90) } };
}

function printSummary() {
  console.log("\n==== 要約 ====");
  console.log(`終了: ${R.endReason}  エンディング: ${R.reachedEnding}  経過 ${fmtT(R.totalSec)}`);
  for (const e of R.research) console.log(`${e.clock}  ${e.key.padEnd(10)} $${e.price.toExponential(1)}  収入 ${Number(e.incomeBefore).toExponential(2)}/s  単価 ${e.valuePerOreBefore?.toFixed(1)} → ${e.valuePerOreAfter?.toFixed?.(1)}`);
  console.log("赤（ショップの判子）:", JSON.stringify(R.red?.hot));
  console.log("何も買えない上位:", JSON.stringify(R.idle?.top5));
  console.log("待つだけ（赤い段に afford なし・研究も不可）上位:", JSON.stringify(R.idle?.waitOnly?.top5));
  for (const g of R.gates) console.log(`関門 ${g.key} ${g.clock}: status「${g.gemStatus}」 req「${g.gemReq}」 todo「${g.todo}」 click→${JSON.stringify(g.clickLog)}`);
  if (R.sortExperiment) console.log(`sort { } ${R.sortExperiment.from}〜${R.sortExperiment.to}s: 工場が赤 ${R.sortExperiment.refineryRedHotSamples ?? 0}/${R.sortExperiment.samples.length} 秒サンプル（判子）/ ${R.sortExperiment.refineryRedDataSamples ?? 0}（即時）。dt 積算 ${R.sortExperiment.refineryRedHot.toFixed(1)}s / ${R.sortExperiment.refineryRedData.toFixed(1)}s`);
  console.log(`最終段ベルトの行: 初出 ${R.maxedBelt.first?.clock ?? "-"}「${R.maxedBelt.first?.text ?? ""}」 サンプル ${R.maxedBelt.samples.length} 件。診断カード: ${JSON.stringify(Object.fromEntries(Object.entries(R.maxedBelt.diag).map(([k, v]) => [k, v.text.replace(/\s+/g, " ").slice(0, 200)])))}`);
  console.log(`ショップ購入 ${R.purchases.length} 回、5 秒以上空いたティック ${R.droppedDt.length} 回（計 ${R.droppedDt.reduce((s, x) => s + x.dt, 0).toFixed(1)}s）`);
  console.log(`console error ${R.console.errors.length} / warning ${R.console.warnings.length} / pageerror ${R.console.pageErrors.length} / runtime.restarts ${R.restarts.runtime}`);
  console.log(`${BACKDOOR ? `裏口ノート ${JSON.stringify(R.finalState?.notebook ?? null)} ` : ""}監査 ${R.finalState?.audits ?? "-"} 回`);
  console.log(`待つだけ 90 秒超: ${R.idle?.waitOnly?.over90s?.length ?? "-"} 件`);
  console.log(`JSON: ${path.join(OUT, "result.json")}`);
}
