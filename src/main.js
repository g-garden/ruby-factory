import {
  BACKDOOR, BATCH_INTERVAL_MS, BELTS, BENCH_SEEDS, EMA_WINDOW, FIRST_DEPLOY_PICKAXES, INITIAL_CODE, MEMO_MARK, NOTEBOOK, OPS_LIMIT, RESEARCH,
} from "../data/balance.js";
import { sfx } from "./audio.js";
import { auditPriced, auditReport, auditVerdict, guessTechnique, stripCode, techWord, UNKNOWN_TECHNIQUE } from "./audit.js";
import { createBurstCounter } from "./burst.js";
import * as eco from "./economy.js";
import { FactoryView } from "./factory.js";
import { extractMethods, fullwidthHint, suggestFromError, unappliedResearch } from "./methods.js";
import { crateViews, priceBatch } from "./price.js";
import { riText } from "./ri.js";
import { beltToRubyLiteral, makeBelt } from "./rng.js";
import { RubyRuntime } from "./ruby/runtime.js";
import { elapsed, intentUrl, pageUrl, shareText } from "./share.js";
import { SAVE_KEY, initialState, load, save } from "./state.js";
import { createCallout } from "./ui/callout.js";
import { createCards } from "./ui/cards.js";
import { createConsole } from "./ui/console.js";
import { fmtPerOre, fmtRatio, h, $ } from "./ui/dom.js";
import { createEditor } from "./ui/editor.js";
import { createGemfile } from "./ui/gemfile.js";
import { createHud } from "./ui/hud.js";
import { createNotebook } from "./ui/notebook.js";
import { tipSentence } from "./ui/notice-queue.js";
import { createShop } from "./ui/shop.js";

const DEBUG = new URLSearchParams(location.search).has("debug");
// SPEC 10.4 の見張りは 5 秒。打ち切りの通知が 5,001ms 前後になるので、「5 秒以内に再開」を守れるよう少し短くする
const DEPLOY_WATCH_MS = 4500;
const SAVE_INTERVAL_MS = 5000;
const ERR_WINDOW_MS = 10_000;
const ERR_LIMIT = 3;
// 本番 VM が落ちて作り直すのがこの間に続いたら、前のコードに戻す。JS 側で資源を使い切るコードは
// バッチの例外にならず、作り直しのたびに読み直されるので、例外の数だけでは止まらない
const CRASH_WINDOW_MS = 30_000;
const CRASH_LIMIT = 3;
const STRAIGHT_INDEX = RESEARCH.findIndex((r) => r.key === "straight");
/** effectShows: 直近の箱のうち、このボーナスが付いた割合がこれ以上なら「コードに取り入れた」とみなす */
const EFFECT_SHARE = { straight: 0.25, christmas: 0.3 };
/** 箱の研究の見せ場で、帯（celebrate、2.4 秒）が抜けてから判子を押すまでの時間 */
const BOX_STAMP_DELAY_MS = 2100;
/** 監査の吹き出しは、AUDITED の判子（2.2 秒）が消えてから出す */
const AUDIT_CALLOUT_DELAY_MS = 2400;
// 成績表の「一番伸ばしたデプロイ」で、前のコードがまだなかったとき。```ruby の中に出すので Ruby のコメントにする
const NO_PACK_YET = "# まだ pack がなく、素通しでした";
/** クリスマス便の金色のトラックを続けて出さない間隔 */
const XMAS_TRUCK_GAP_MS = 20_000;
const fmtOre = (v) => fmtPerOre(v, eco.formatNumber);
const RELEASE_LABEL = RESEARCH.find((r) => r.effect?.ending)?.label ?? "12/25 リリース";
/** スマホ幅（ログ欄がエディタの下にあって、最初は見えない） */
const isPhone = () => !!globalThis.matchMedia?.("(max-width: 899px)")?.matches;
const tapWord = () => (globalThis.matchMedia?.("(pointer: coarse)")?.matches ? "タップ" : "クリック");
/** 研究の一覧の呼び名に助詞を付けたもの。PC では右下の「Gemfile」、スマホでは「研究」のタブ（英字の後ろは空白を入れる） */
const researchPlace = (particle) => (isPhone() ? `研究のタブ${particle}` : `右下の Gemfile ${particle}`);

// ---------------------------------------------------------------- 状態

const loaded = load();
let state = loaded ?? initialState();
const resumed = !!loaded;
const baseRestarts = state.stats.restarts ?? 0;
/** VMCrash（exit! やメモリ枯渇）での作り直し。「無限ループからの生還」には数えない */
let crashRestarts = 0;
const restartsNow = () => baseRestarts + Math.max(0, runtime.restarts - crashRestarts);
/** 最後に自分で書いた（または読み込んだ）セーブの時刻。ほかのタブの書き込みを見分ける */
let knownSavedAt = state.savedAt ?? null;
let saveBlocked = false; // いま別タブの方が進んでいて保存を見送っているか（通知を 1 回にするため）
sfx.setMuted(state.muted);

/** 直近のバッチ（値付けし直し用）。belt と box は送った時点のものを持つ。セーブには入れない */
let recent = [];
/** 研究で値付けが変わる直前の単価。次にコードを書き換えたデプロイのバナーで「研究前から」の倍率に使う */
let researchBase = null; // { value, labels, code }
/** 研究直後の「コードはそのまま」バナー待ち。箱・色の研究は次のバッチで単価が出る */
let pendingResearch = null; // { label, before, tip, rlen }
let saveWarned = false;
let resetting = false; // 最初からやり直す途中。リロード前の pagehide で今の状態を保存し直さないようにする
let eff = eco.derive(state);
let fi = eco.flowInfo(state);
let machines = state.deployed ? extractMethods(state.lastGoodCode ?? "") : [];

const vm = { phase: "download", progress: 0, ready: false, description: null, version: null };
let deploying = false;
let gen = 0; // デプロイのたびに進める。古いコードのバッチ結果を捨てるため
let batchBusy = false;
let wantBatch = false;
let nextBatchAt = performance.now() + BATCH_INTERVAL_MS;
let seedSeq = 1000 + Math.floor(Math.random() * 1e6);
const batchErrors = createBurstCounter({ limit: ERR_LIMIT, windowMs: ERR_WINDOW_MS });
const vmCrashes = createBurstCounter({ limit: CRASH_LIMIT, windowMs: CRASH_WINDOW_MS });
let fault = null; // { status, label, until }
let backlog = 0;
let lastBn = null;
let timeScale = 1;
let clickStreak = 0;
let lastClickAt = 0;
let lastPerfectSfx = 0;
let lastCelebrate = 0;
let lastLogText = "";
let feedIdx = 0;

// ---- 裏口ノート・監査（SPEC-rubyist 4.9） ----
/** 直近の監査の判定（auditVerdict）。__yf.lastAudit と工場の常設の判子に使う */
let lastAudit = null;
/** いまのデプロイで監査報告を出したか（報告と判子は 1 デプロイ 1 回） */
let auditReported = false;
/** いまのデプロイの丸めの一言（同じ文面は 1 デプロイ 1 回） */
const backdoorNotes = new Set();
/** いまのデプロイで見た残業の回数（増えたら残業灯を点け直す） */
let lastOvertime = 0;
/** 残業灯が消える時刻（performance.now() のミリ秒）。経済の効き目はない */
let overtimeUntil = null;
/** 終盤のナッジ（2.5 節）の条件が続いている秒数（ゲーム内の秒）。出したかどうかは state.nudged に保存する */
let nudgeHold = 0;
/** 技のうち、tick（鑑定を数えるところ）を書き換えるもの。ページ 4 にする */
const TICK_TECHNIQUES = new Set(["tick", "define_singleton_method", "tick_alias"]);

/** 本番の定常バッチを受け取った回数（受け入れ確認用。recent は 5 本で頭打ちなので） */
let batchCount = 0;

// ---------------------------------------------------------------- 画面

const app = $("#app");
const cards = createCards(document.body);
const hud = createHud($("#hud"), { onMute: toggleMute, onReset: resetGame, onShare: shareOnX });
const con = createConsole($("#console"));
// 工場の上の吹き出し。研究カードを開いているあいだは時間を止める
const callout = createCallout($(".factory"), {
  held: () => !!cards.open,
  compact: isPhone,
  // 最後まで出した・押した案内は読んだものとして、「新しい案内」の数から外す。PC ではログのその行も光らせる
  onClose: (item, how) => {
    con.markRead(item.el);
    if (how === "close" && !isPhone() && item.el?.isConnected) con.focusLine(item.el, { scroll: false });
  },
  // 新しい案内に差し替えた古い案内（はじめの案内など）も、もう数えない
  onDrop: (item) => con.markRead(item.el),
  // 「ログ」を押したときだけログへ行く。スマホではログ欄がコードのタブの下にあるので、タブを切り替えてからその行まで送る
  onLog: (item) => {
    if (isPhone()) setTab("code");
    requestAnimationFrame(() => {
      con.focusLine(item.el);
      focusLogLine(item.el);
    });
  },
  focusAway: (item) => {
    if (isPhone()) document.querySelector(".tab.on")?.focus({ preventScroll: true });
    else focusLogLine(item.el);
  },
});
function focusLogLine(el) {
  if (!el?.isConnected || el.offsetParent == null) return;
  el.tabIndex = -1;
  el.focus({ preventScroll: true });
}

/** 同じ案内をログに何行も積まないよう、key ごとに最後に書いた時刻を覚えておく */
const guideLoggedAt = new Map();
const GUIDE_LOG_GAP_MS = 8000;
/**
 * 案内。ログに全文を残し、工場の上の吹き出しにも短い文で出す。
 * opts = { cls: ログの色, kind: guide・goal・warn・notebook, kicker: 吹き出しの見出し, short: 吹き出しの文, sp: スマホの吹き出しの文（2 行に収めたいとき）, key, group, urgent, action }
 */
function guide(text, { cls = "note", kind = "guide", kicker, short, sp, key, group, urgent, action } = {}) {
  const now = performance.now();
  if (key && now - (guideLoggedAt.get(key) ?? -Infinity) < GUIDE_LOG_GAP_MS) return null;
  if (key) guideLoggedAt.set(key, now);
  const el = con.guide(text, cls, kind);
  callout.push({ text: short ?? text.replace(/^#\s*/, ""), sp, kicker, kind, key, group, urgent: urgent ?? kind === "warn", el, action });
  return el;
}
/** はじめの案内（デプロイできるまで）を一度出したか */
let readyGuided = false;
const shop = createShop($("#shop"), { onBuy: buyItem, onDiagnose: openDiagnose });
const gemfile = createGemfile($("#gemfile"), { onBuy: buyResearch, onOpen: openResearchCard });
const notebook = createNotebook(gemfile.notebookRoot);
const editor = createEditor($("#editor"), {
  initial: state.code,
  onChange: (code) => { state.code = code; },
  onDeploy: () => deploy(editor.value),
  onRevert: revertToPrevious,
  onHint: () => {
    // 買ったのにまだ書いていない研究があれば、そのカードを開く
    const def = (state.deployed ? refresh.todo : null) ?? latestResearch() ?? eff.nextResearch;
    if (def) openResearchCard(def.key);
  },
  onSolution: () => {
    const def = latestResearch();
    if (def?.hint?.solution) {
      editor.replace(def.hint.solution); // Cmd/Ctrl+Z で自分のコードに戻せる
      con.line(`# 「${def.label}」の完成コードを入れました。デプロイで反映されます`, "note");
    }
  },
  onRi: openRi,
});

const view = new FactoryView($("#factory"), {
  onMineClick: onMineClick,
  onStageClick: openDiagnose,
  onShip: (cv) => {
    const rate = state.deployed ? fi.flow * Math.max(0.001, state.ema.cratesPerOre) : fi.flow;
    sfx.ship(rate);
    if (cv?.perfect && performance.now() - lastPerfectSfx > 2500) {
      lastPerfectSfx = performance.now();
      sfx.perfect();
    }
  },
});

setupTabs();

// ---------------------------------------------------------------- Ruby

const runtime = new RubyRuntime({ onStatus, deployTimeoutMs: DEPLOY_WATCH_MS });
runtime.ready.catch((e) => {
  guide(`Ruby VM を起動できませんでした: ${e?.message ?? e}。工場は素通しのまま動きます`, {
    cls: "err", kind: "warn", kicker: "注意", short: "Ruby VM を起動できませんでした。工場は素通しのまま動きます",
  });
});

function onStatus(s) {
  switch (s.phase) {
    case "download":
      vm.phase = "download";
      if (typeof s.progress === "number") vm.progress = s.progress;
      break;
    case "compile":
    case "boot":
      vm.phase = s.phase;
      break;
    case "ready": {
      const first = !vm.ready;
      vm.ready = true;
      vm.phase = "ready";
      vm.description = s.description;
      vm.version = s.version;
      if (first) onVmReady();
      break;
    }
    case "restart":
      vm.phase = "restart";
      setFault("restarting", "", 1500);
      // 見張り切れ（無限ループ）はバッチの例外として数える。ここでは VM が落ちたときだけ数える
      if (s.reason !== "timeout") noteVmCrash();
      break;
    case "error":
      vm.phase = "error";
      break;
  }
}

function onVmReady() {
  con.line(vm.description ?? `ruby ${vm.version}`, "ok");
  if (state.deployed) {
    // リロード復帰: 最後に動いたコードを黙って入れ直す（バナーは出さない）
    deploy(state.lastGoodCode ?? INITIAL_CODE, { silent: true, restore: true });
  } else {
    // 本数は出さない（買うたびに変わるので、吹き出しに出すとデプロイボタンの「あと N 本」と食い違う）
    const left = eco.canDeploy(state, true).remaining ?? 0;
    if (left === 0) readyGuided = true;
    guide(`# Ruby VM の準備ができました。つるはしが ${FIRST_DEPLOY_PICKAXES} 本そろうとデプロイできます`, {
      kicker: "Ruby 準備完了", group: "onboarding", key: "vm-ready",
      // はじめの案内（鉱山を掘る）を差し替えるので、掘ることもここで言い直す
      short: left > 0 ? `鉱山を${tapWord()}して稼ぎ、つるはしを ${FIRST_DEPLOY_PICKAXES} 本にするとデプロイできます` : deployReadyShort(),
    });
  }
}

function vmProgress() {
  if (vm.ready) return null;
  if (vm.phase === "download") return 0.85 * vm.progress;
  if (vm.phase === "compile") return 0.9;
  if (vm.phase === "boot") return 0.96;
  return 0.02;
}

function vmText() {
  if (vm.phase === "error") return "Ruby VM 停止";
  if (vm.phase === "restart") return "Ruby VM 再起動中";
  if (vm.ready) return `Ruby ${vm.version ?? ""}`.trim();
  return `Ruby VM ${Math.round((vmProgress() ?? 0) * 100)}%`;
}

// ---------------------------------------------------------------- バッチ

function requestBatch() {
  if (batchBusy) wantBatch = true;
  else runBatch();
}

async function runBatch() {
  if (batchBusy || deploying || !vm.ready || !state.deployed || runtime.lastGoodSrc == null) return;
  batchBusy = true;
  const myGen = gen;
  const box = eff.box;
  const colors = eff.colors;
  const rlen = state.research.length;
  const belt = makeBelt(seedSeq++, { colors });
  let r;
  try {
    r = await runtime.batch(beltToRubyLiteral(belt, box, OPS_LIMIT));
  } catch (e) {
    r = { ok: false, ops: 0, errClass: "VMCrash", message: String(e?.message ?? e), line: null, log: "", local: true };
  }
  batchBusy = false;
  if (myGen === gen) handleBatch(belt, box, r, rlen, colors);
  if (wantBatch) {
    wantBatch = false;
    runBatch();
  }
}

function handleBatch(belt, box, r, rlen, colors = eff.colors) {
  if (!r.ok) {
    if (r.errClass === "NotDeployed" || r.errClass === "Superseded") return;
    rubyFailure(r, "batch");
    return;
  }
  batchCount++;
  if (r.log && r.log !== lastLogText) {
    lastLogText = r.log;
    con.output(r.log);
  }
  checkMemo(r.log);
  if (r.monkeyPatched) {
    achieve("monkeypatcher", "実績「モンキーパッチャー」: Yield の鑑定の数え方を書き換えました");
    findPage("monkeypatch");
  }
  // 裏口の報告は本番のバッチのものだけを使う（SPEC-rubyist 4.3）
  applyBackdoor(r.backdoor);
  const priced = priceAudited(belt, r, box, colors);
  if (priced.validCrates === 0) {
    // 全部スクラップのバッチは例外と同じ扱い。直近の結果で工場を回し続け、続くようなら前のコードに戻す
    inspect(priced);
    noteBatchError();
    return;
  }
  recent.push({ belt, result: r, box, colors, priced });
  if (recent.length > EMA_WINDOW) recent.shift();
  applyRecent();
  checkAudit();
  if (pendingResearch && rlen >= pendingResearch.rlen) showResearchGain(priced.valuePerOre);
  inspect(priced);
}

/** 直近のバッチから単価・鑑定・箱数の移動平均と再生用の箱を作る */
function applyRecent() {
  if (recent.length === 0) return;
  // Ruby は成功したが配列の配列でなかったバッチは「全部スクラップ」として平均に入れる
  const list = recent.map((b) => (b.priced.ok ? b.priced : { ...b.priced, ok: true }));
  const ema = eco.emaFromBatches(list);
  if (ema) state.ema = ema;
  const prevRecord = state.record ?? 0;
  if (eco.updateRecord(state)) onRecord(prevRecord, state.record);
  state.lastCrates = crateViews(recent[recent.length - 1].priced);
  fi = eco.flowInfo(state);
}

/** 値付けしてから監査ラインを通す（工場の計算に使う鑑定は max(実測, 監査ライン)） */
function priceAudited(belt, r, box, colors) {
  return auditPriced(priceBatch(belt, r, { box, research: state.research }), r.polished, { colors, box, cooled: r.heatCooled === true });
}

/**
 * いまのデプロイのバッチ（recent）で監査の判定をする。見抜かれたら、そのデプロイで 1 回だけ監査報告・AUDITED 判子・ページ 3 か 4。
 * silent（リロード復帰・自動の戻し）では報告を出さず、回数にも数えない
 */
function checkAudit({ silent = false } = {}) {
  const v = auditVerdict(recent.map((b) => b.priced));
  const last = recent.at(-1)?.priced;
  lastAudit = { ...v, opsPerOre: last?.opsPerOre ?? null, measuredOpsPerOre: last?.measuredOpsPerOre ?? null };
  if (!v.caught || auditReported) return v;
  auditReported = true;
  const patched = recent.some((b) => b.result?.monkeyPatched);
  let tech = guessTechnique(state.lastGoodCode ?? "");
  // 研磨機を冷やしたことは Ruby 側で分かっている。コードから技を当てられなかったときだけ、冷やしたこととして報告する
  // （Yield.polished の直呼びや bind_call と一緒に冷やしたときは、当てた技のまま）
  if (!tech && recent.some((b) => b.result?.heatCooled)) tech = { key: "heat", label: "@heat の書き換え", line: 1 };
  if (!silent) {
    state.audits = (state.audits ?? 0) + 1;
    const el = con.warning(auditReport({ audited: v, technique: tech, file: "pack.rb", opsMul: eff.opsMul }));
    // AUDITED の判子（2.2 秒）を吹き出しで隠さないよう、判子が消えてから出す
    setTimeout(() => callout.push({
      kind: "audit", kicker: "鑑定長", el, key: `audit:${state.audits}`,
      // 見出しが「鑑定長」なので、本文では主語を繰り返さない
      text: tech ? `${techWord(tech.label)}を見抜かれました。鑑定は数え直しです` : "箱の出来がよすぎて気づかれました。鑑定は数え直しです",
      // スマホは 2 行に収める。技の名前はログの監査報告に出ている
      sp: tech ? "技を見抜かれました。鑑定は数え直しです" : "箱の出来がよすぎて気づかれました。鑑定は数え直しです",
    }), AUDIT_CALLOUT_DELAY_MS);
    view.stamp("AUDITED", "refinery");
    sfx.audited();
    if (!tech) achieve("unknown_technique", "実績「正体不明の技」: 鑑定長にも、どうやったのか分かりませんでした");
  }
  // ページ 3 は patched? が false のまま見抜かれたとき。tick の再定義などで patched? が true ならページ 4。
  // patched? は source_location が pack.rb の tick しか見ないので、alias_method(:tick, ...) のように prelude のメソッドで
  // tick を潰したときも、技が tick の書き換えならページ 4 にする
  if (patched || TICK_TECHNIQUES.has(tech?.key)) {
    if (!patched) achieve("monkeypatcher", "実績「モンキーパッチャー」: Yield の鑑定の数え方を書き換えました");
    findPage("monkeypatch", { feature: tech?.label });
  }
  // 技を当てられなかったときは、ノートにも報告と同じ「正体不明」を出す
  else findPage("audit", { feature: tech?.label ?? UNKNOWN_TECHNIQUE });
  return v;
}

/**
 * 裏口ノートのページを埋める。feature はそのページを見つけた Ruby の機能名（当てた技など）。
 * 見つけたときの名前を state.notebookFeatures に保存し、あとから別のコードで同じページを踏んでも書き換えない
 */
function findPage(key, { feature } = {}) {
  if (!Array.isArray(state.notebook)) state.notebook = [];
  if (state.notebook.includes(key)) return false;
  state.notebook.push(key);
  const def = NOTEBOOK.find((p) => p.key === key);
  const name = feature ?? featureFromCode(key, state.lastGoodCode) ?? def?.feature ?? "";
  if (!state.notebookFeatures || typeof state.notebookFeatures !== "object") state.notebookFeatures = {};
  if (name) state.notebookFeatures[key] = name;
  const n = state.notebook.length;
  // 技の名前は英字（instance_variable_get など）のときだけ前に空白を入れる。正体不明のときは名前を出さない
  const how = name && name !== UNKNOWN_TECHNIQUE ? `。使った技は${/^[\x21-\x7e]/.test(name) ? " " : ""}${name}` : "";
  guide(`# 裏口ノート ${n}/${NOTEBOOK.length}「${def?.label ?? key}」を見つけました${how}`, {
    cls: "ok", kind: "notebook", kicker: "裏口ノート", key: `page:${key}`, sp: `${n}/${NOTEBOOK.length}「${def?.label ?? key}」を見つけました`,
  });
  sfx.perfect();
  return true;
}

/**
 * ページ 1・2・5・6 を、いまのコードの書き方から名前を当てる（演出だけ。コメントと文字列は見ない）。
 * 報告（REPORT）を差し替えて 2 車線・夜間ライン・残業を名乗った場合は const_set(:REPORT) と出す。当たらなければ null（NOTEBOOK の既定の名前）
 */
function featureFromCode(key, code) {
  const raw = String(code ?? "");
  if (key === "monkeypatch") {
    const tech = guessTechnique(raw);
    return TICK_TECHNIQUES.has(tech?.key) || tech?.key === "prepend" ? tech.label : null;
  }
  const src = stripCode(raw);
  const forged = /\b(?:const_set|remove_const)\b/.test(src) && /\bREPORT\b/.test(src);
  const rules = {
    memo: [[/\binstance_variable_get\b/, "instance_variable_get"], [/\binstance_variables\b/, "instance_variables"]],
    lanes: [[/\binstance_variable_set\s*\(?\s*:@lanes\b/, "instance_variable_set"], [forged, "const_set(:REPORT)"], [/\binstance_variable_set\b/, "instance_variable_set"]],
    keyring: [[/\bObjectSpace\b/, "ObjectSpace"], [/\bKEYRING\b/, "const_get(:KEYRING)"], [forged, "const_set(:REPORT)"]],
    overtime: [[/残業させてください/, "method_missing", raw], [forged, "const_set(:REPORT)"], [/\b(?:method_missing|disasm)\b/, "method_missing"]],
  }[key];
  for (const [re, name, text = src] of rules ?? []) {
    if (re === true || (re instanceof RegExp && re.test(text))) return name;
  }
  return null;
}

/** デプロイかバッチのログに工場長のメモの本文が出たら、ページ 1 */
function checkMemo(text) {
  if (text && String(text).includes(MEMO_MARK)) findPage("memo");
}

/**
 * Ruby の報告（BatchResult.backdoor。生の値か null）を丸めて state.backdoor に入れる。丸めの一言は 1 デプロイ 1 回。
 * 読めない・形が違うときは clampBackdoor が「裏口なし」にする
 */
function applyBackdoor(raw) {
  const c = eco.clampBackdoor(raw, state);
  state.backdoor = { lanes: c.lanes, night: c.night, overtime: c.overtime };
  for (const n of c.notes) {
    if (backdoorNotes.has(n)) continue;
    backdoorNotes.add(n);
    con.boss(`工場長「${n}」`);
  }
  // 2.5 のような整数でない値は 1 車線に丸めるので、3 以上の整数を試したときだけ
  if (raw && Number.isInteger(raw.lanes) && raw.lanes > BACKDOOR.lanesMax) achieve("floor", "実績「床は抜けませんでした」: 3 車線以上を試しました");
  if (c.lanes >= 2) findPage("lanes");
  if (c.night) {
    findPage("keyring");
    achieve("night_line", "実績「眠らない工場」: 合鍵で夜間ラインを動かしました。惑星コアと軌道エレベータが 1.5 倍になります");
  }
  if (c.overtime >= 1) {
    findPage("overtime");
    if (c.overtime > lastOvertime) {
      if (overtimeUntil == null || performance.now() > overtimeUntil) con.boss(`# 工場の窓に ${BACKDOOR.overtimeSecs} 秒の残業灯がつきました。灯りがつくだけで、稼ぎは増えません`);
      overtimeUntil = performance.now() + BACKDOOR.overtimeSecs * 1000;
    }
  }
  lastOvertime = c.overtime;
}

function inspect(priced) {
  if (priced.ok && priced.issues.length === 0) {
    // 消すのは検品エラーの札（期限なし）だけ。デプロイ失敗の「詰まり」「オーバーヒート」は 4.5 秒出し切る
    if (fault && fault.until === Infinity) fault = null;
    return;
  }
  const counts = {};
  for (const c of priced.crates) if (!c.valid) counts[c.reason] = (counts[c.reason] ?? 0) + 1;
  const label = !priced.ok ? "配列の配列ではない"
    : counts.duplicate ? `複製 ${counts.duplicate} 箱`
    : counts.overflow ? `はみ出し ${counts.overflow} 箱`
    : counts["not-ore"] ? `Ore 以外 ${counts["not-ore"]} 箱`
    : counts.empty ? `空箱 ${counts.empty}` : "検品エラー";
  const key = label + priced.issues.join("|");
  setFault(priced.ok ? "inspect-error" : "jam", label, Infinity);
  if (key !== inspect.lastKey) {
    inspect.lastKey = key;
    sfx.error();
    con.ticket({
      kind: "inspect", tag: "検品エラー", title: priced.ok ? `有効な箱 ${priced.validCrates} ／ 返した箱 ${priced.crates.length}` : "そのバッチは全部スクラップ",
      rows: priced.issues.map((s, i) => [i === 0 ? "差分" : "", s]),
      hint: "値段は JS が id から付けます。同じ原石は 1 回しか売れません",
    });
    for (const s of priced.issues) con.line(`検品: ${s}`, "warn");
  }
}

function setFault(status, label, ms) {
  fault = { status, label, until: performance.now() + ms };
}

const OPS_LIMIT_TEXT = OPS_LIMIT.toLocaleString("en-US");
/** Ruby 側の失敗（例外・Overheat・見張り切れ）を工場の札と故障票にする */
function rubyFailure(r, where, code = state.lastGoodCode) {
  sfx.error();
  const cls = r.errClass || "(無名の例外)";
  const at = r.line ? `pack.rb:${r.line} ` : "";
  if (/Overheat/.test(cls)) {
    setFault("overheat", cls, 4500);
    const ops = Number.isFinite(r.ops) && r.ops > 0 ? [["鑑定", `${eco.formatNumber(r.ops)} 回`]] : [];
    con.ticket({ kind: "overheat", tag: "故障票", title: `${at}${cls}`, rows: [...ops, ["症状", `鑑定が ${OPS_LIMIT_TEXT} 回を超えました。原石を読み続けるループになっていませんか`]], hint: "Yield::Overheat は Exception の子なので rescue => e では捕まりません" });
    con.line(`${at}${cls}: 鑑定が ${OPS_LIMIT_TEXT} 回を超えました`, "err");
  } else if (cls === "SystemStackError" && r.crashed) {
    // ブロックを通した深い再帰は JS のスタックが先に溢れ、VM ごと作り直している。行番号は取れない
    setFault("jam", cls, 4500);
    if (!r.local) crashRestarts++;
    con.ticket({ kind: "jam", tag: "故障票", title: cls, rows: [["メッセージ", r.message ?? ""], ["対応", where === "deploy" ? `デプロイを中止しました。${runningOn()}` : "VM を作り直して再開しました"]],
      hint: "再帰が深すぎます。each や sort のブロックの中から pack など自分自身を呼んでいないか確かめてください" });
    con.line(`${cls}: ${r.message}`, "err");
  } else if (cls === "TimeoutError" || cls === "VMCrash") {
    setFault("restarting", cls, 1800);
    const crash = cls === "VMCrash";
    if (crash && !r.local) crashRestarts++;
    const where2 = r.poisoned ? "このコードは読み直せないので、工場は直前の結果を使い回して動いています"
      : where !== "deploy" ? "VM を作り直して再開しました" : state.deployed ? "前のコードで再開しました" : "素通しのまま動いています";
    const rows = [["対応", r.poisoned ? where2 : `Worker を terminate → 新しい VM → ${where2}`]];
    if (!crash && !r.poisoned) rows.push(["再起動", `${restartsNow()} 回目`]);
    con.ticket({ kind: "timeout", tag: "故障票", title: `${cls}: ${r.message}`, rows,
      hint: r.poisoned ? "def の外に書いたループを消して、デプロイし直してください"
        : crash ? "exit! やメモリの使いすぎなどで VM ごと落ちました。新しい VM で動かしています"
        : "loop {} や while true; end は Ruby の中からは止められないので、VM ごと作り直します" });
    con.line(`${cls}: ${r.message}`, "err");
    con.line(`→ ${where2}`, "ok");
  } else {
    setFault("jam", cls, 4500);
    const fw = fullwidthHint(code ?? "", r.message ?? "");
    const guess = fw ? null : suggestFromError(r.message);
    con.ticket({ kind: "jam", tag: "故障票", title: `${at}${cls}`, rows: [["メッセージ", r.message ?? ""], ...(r.line ? [["行", `pack.rb:${r.line}`]] : [])], hint: fw ?? (guess ? `もしかして: ${guess}` : null) });
    con.line(`${at}${cls}: ${r.message}`, "err");
    if (fw) con.line(`  ${fw}`, "warn");
    if (guess) con.line(`  Did you mean?  ${guess}`, "note");
    if (r.log) con.output(r.log);
  }
  if (where === "batch") noteBatchError();
}

/** 定常バッチの失敗を数え、10 秒に 3 回で最後にベンチを通った前のコードに戻す（SPEC 10.5） */
function noteBatchError() {
  // デプロイ中はそのデプロイが本番のコードを決めるので、戻しの案内は出さない
  if (deploying) return;
  if (batchErrors.note(performance.now())) {
    const prev = state.codeHistory.at(-1);
    guide(prev
      ? `例外が ${ERR_WINDOW_MS / 1000} 秒に ${ERR_LIMIT} 回出たので、前のコードに戻します。エディタのコードはそのままです`
      : `例外が ${ERR_WINDOW_MS / 1000} 秒に ${ERR_LIMIT} 回出ました。前のコードがないので初期コードに戻します。エディタのコードはそのままです`, {
      cls: "warn", kind: "warn", kicker: "注意", key: "revert",
      short: `例外が続いたので、${prev ? "前のコード" : "初期コード"}に戻しました。エディタはそのままです`,
    });
    deploy(prev ?? INITIAL_CODE, { silent: true, revert: true, toInitial: !prev, chain: true });
  }
}

/** 本番 VM の作り直しを数え、30 秒に 3 回で前のコード（なければ初期コード）に戻す。リロード直後の入れ直しでも同じ */
async function noteVmCrash() {
  if (!state.deployed || runtime.lastGoodSrc == null || runtime.lastGoodSrc === INITIAL_CODE) return;
  // デプロイ中に落ちた分は、そのデプロイの失敗として扱う。ここで戻すと「前のコードに戻します」の案内だけが出て、戻しは busy で捨てられる
  if (deploying) return;
  if (!vmCrashes.note(performance.now())) return;
  const prev = state.codeHistory.at(-1);
  guide(`Ruby VM が ${CRASH_WINDOW_MS / 1000} 秒に ${CRASH_LIMIT} 回落ちたので、${prev ? "前のコード" : "初期コード"}に戻します。エディタのコードはそのままです`, {
    cls: "warn", kind: "warn", kicker: "注意", key: "revert-crash",
    short: `VM が何度も落ちたので、${prev ? "前のコード" : "初期コード"}に戻しました。エディタはそのままです`,
  });
  const res = await deploy(prev ?? INITIAL_CODE, { silent: true, revert: true, toInitial: !prev, chain: true });
  // すぐ保存する。リロードしたときに落ちるコードを読み直さないように
  if (res?.ok) persist();
}

/**
 * 戻し先のコードがいまの研究ではベンチを通らなかった。そのコードを履歴から外し、さらに前（最後は初期コード）を試す。
 * 自動の戻し（chain）とリロード復帰で使う。初期コードでも通らなければそこで止める
 */
function fallBack(failed, { revert, restore = false }) {
  if (failed === INITIAL_CODE) return false;
  if (revert && state.codeHistory.at(-1) === failed) state.codeHistory.pop();
  const next = state.codeHistory.at(-1);
  con.line(restore
    ? `# 前回のコードはいまはベンチを通らないので、${next ? "その前のコード" : "初期コード"}で再開します`
    : `# そのコードもいまはベンチを通らないので、${next ? "さらに 1 つ前のコード" : "初期コード"}を試します`, "note");
  deploy(next ?? INITIAL_CODE, { silent: true, revert: true, toInitial: !next, chain: true });
  return true;
}

/** 工場がいま何で動いているか（故障票・ログの文言用） */
const runningOn = () => (!state.deployed ? "工場は素通しのまま動いています"
  : runtime.lastGoodSrc == null ? "工場は直前の結果を使い回して動いています" : "工場は前のコードで動いています");

// ---------------------------------------------------------------- デプロイ

let deployingCode = null;
let queuedDeploy = null;

/** デプロイ中に押されたデプロイ（Cmd/Ctrl+Enter）は捨てずに、終わったあと最後の 1 つだけ続けて流す */
async function deploy(code, opts = {}) {
  if (deploying) {
    if (!opts.silent && code !== deployingCode) {
      if (queuedDeploy == null && !opts.fromQueue) con.line("# デプロイ中です。終わったら、いまのエディタのコードを続けてデプロイします", "note");
      queuedDeploy = code;
    }
    return { ok: false, busy: true };
  }
  deployingCode = code;
  let res;
  try {
    res = await deployNow(code, opts);
  } finally {
    deployingCode = null;
  }
  if (!opts.silent) editor.home();
  if (queuedDeploy != null && !deploying) {
    const q = queuedDeploy;
    queuedDeploy = null;
    deploy(q, { fromQueue: true });
  }
  return res;
}

async function deployNow(code, { silent = false, revert = false, toInitial = false, chain = false, restore = false } = {}) {
  const chk = eco.canDeploy(state, vm.ready);
  if (!chk.ok) {
    if (!silent) con.line(`# ${chk.reason}`, "note");
    return { ok: false, reason: chk.reason };
  }
  deploying = true;
  gen++;
  eff = eco.derive(state);
  const box = eff.box;
  const colors = eff.colors;
  const belts = BENCH_SEEDS.map((s) => makeBelt(s, { colors }));
  const lits = belts.map((b) => beltToRubyLiteral(b, box, OPS_LIMIT));
  if (!silent) con.line(`$ deploy pack.rb  # 新旧を並べて、固定シード ${BENCH_SEEDS.join(", ")} × 512 個でベンチ`, "cmd");
  // 新旧のベンチにも監査ラインを掛ける（鑑定 0 のコードでバナーが「工場 ∞」にならないように）
  const price = (r, i) => priceAudited(belts[i], r, box, colors);
  let rejected = null;
  // 有効な箱が 1 つもないコードは本番にしない。工場を $0 で止めてしまうので
  const accept = (results) => {
    const priced = results.map(price);
    if (!priced.every((p) => p.validCrates === 0)) return null;
    rejected = priced;
    return "有効な箱が 1 つもありません";
  };
  // 履歴に積むのは、このセッションで実際に動いていたコードだけ（リロード後に読み直せなかったコードは積まない）
  const runningBefore = runtime.lastGoodSrc;
  let res;
  try {
    res = await runtime.deploy(code, lits, { accept, box });
  } catch (e) {
    res = { ok: false, stage: "timeout", errClass: "VMCrash", message: String(e?.message ?? e), line: null, local: true };
  }
  if (res.rejected) res.priced = rejected;
  deploying = false;
  gen++;
  if (!res.ok) {
    deployFailed(res, code, { silent, revert, chain, restore });
    return res;
  }

  const newPriced = res.newResults.map(price);
  const oldPriced = res.oldResults?.every((r) => r?.ok) ? res.oldResults.map(price) : null;
  const avg = (arr, k) => arr.reduce((s, p) => s + p[k], 0) / arr.length;
  const before = oldPriced ? avg(oldPriced, "valuePerOre") : eco.effectiveEma(state).valuePerOre;
  const opsBefore = oldPriced ? avg(oldPriced, "opsPerOre") : eco.effectiveEma(state).opsPerOre;
  const after = avg(newPriced, "valuePerOre");
  const opsAfter = avg(newPriced, "opsPerOre");
  const cratesBefore = oldPriced ? avg(oldPriced, "cratesPerOre") : eco.effectiveEma(state).cratesPerOre;
  const cratesAfter = avg(newPriced, "cratesPerOre");
  // クリスマス便の箱の数（1 バッチあたり）。研究前は数えない
  const xmasOf = (list) => list.reduce((s, p) => s + christmasCrates(p), 0) / list.length;
  const xmas = eff.bonuses.has("christmas") ? { before: oldPriced ? xmasOf(oldPriced) : null, after: xmasOf(newPriced) } : null;

  const prevCode = state.lastGoodCode;
  const hist = state.codeHistory;
  if (runningBefore != null && runningBefore !== code && !revert) {
    hist.push(runningBefore);
    if (hist.length > 10) hist.shift();
  }
  if (revert && !toInitial) hist.pop();
  // 研究のあとの最初の書き換えだけ、研究前の単価からの倍率も見せる
  const base = researchBase && researchBase.code === prevCode && prevCode !== code && !silent && !revert
    && after > before && researchBase.value > 0 && researchBase.value < before * 0.98 ? researchBase : null;
  if (prevCode !== code) researchBase = null;
  pendingResearch = null;
  const recordBefore = state.record ?? 0;
  const firstDeploy = !state.deployed;
  state.deployed = true;
  state.lastGoodCode = code;
  machines = extractMethods(code);
  recent = newPriced.map((priced, i) => ({ belt: belts[i], result: res.newResults[i], box, colors, priced }));
  // 監査・裏口はデプロイごとに数え直す（新しい VM なので、トップレベルで入れた 2 車線や合鍵もここで決まり直す）
  auditReported = false;
  lastAudit = null;
  backdoorNotes.clear();
  lastOvertime = 0;
  batchErrors.reset();
  vmCrashes.reset();
  fault = null;
  inspect.lastKey = null;
  applyRecent();
  nextBatchAt = performance.now() + BATCH_INTERVAL_MS;
  // デプロイ時のトップレベルの出力（p Yield.instance_variables など）。リロード復帰の入れ直しでは出さない
  if (!silent && res.log) con.output(res.log);
  checkMemo(res.log);
  applyBackdoor(res.newResults[0]?.backdoor);

  if (!silent) {
    // 研究カードの裏で待たせていた見せ場は、前のコードの話なので捨てる
    cards.dropAfterClose();
    state.stats.deploys = (state.stats.deploys ?? 0) + 1;
    const jamPrev = { value: before, ops: opsBefore, crates: cratesBefore };
    const jamNext = { value: after, ops: opsAfter, crates: cratesAfter };
    const jam = !firstDeploy && after > before ? jamNote(jamPrev, jamNext) : "";
    const { head, ratio, faster } = con.bench({ before, after, opsBefore, opsAfter, refinery: refineryChange(opsBefore, opsAfter),
      base: base && { value: base.value, label: base.labels.map((l) => `「${l}」`).join("") }, xmas, jam });
    con.line(head, ratio >= 1 || faster ? "ok" : "warn");
    if (jam) {
      const j = jamCheck(jamPrev, jamNext);
      guide(`# ${jam}`, {
        cls: "warn", kind: "warn", kicker: "注意", key: `jam:${jam}`, short: jamShort(j), sp: jamShort(j, { sp: true }),
        // スマホでショップ以外のタブにいたら、ショップへのボタンを付ける
        action: j?.bn === "refinery" || j?.bn === "dock"
          ? { label: "ショップへ", run: () => setTab("shop"), show: () => isPhone() && app.dataset.tab !== "shop" } : undefined,
      });
    }
    // 書き換えでクリスマス便が増えたら、金色のトラックで知らせる
    if (xmas && xmas.after >= 1 && xmas.after > (xmas.before ?? 0) * 1.5) christmasTruck(xmas.after);
    if (prevCode && /\bsort\s*(\{|do\b)/.test(prevCode) && /\bsort_by\b/.test(code) && opsAfter < opsBefore * 0.9) {
      achieve("schwartzian", `実績「シュワルツ変換」: sort { } を sort_by に直して、鑑定が ${opsBefore.toFixed(2)} → ${opsAfter.toFixed(2)} 回に減りました`);
    }
    con.ticket(null);
    editor.clearError();
    sfx.deploy();
    if (firstDeploy) {
      // 吹き出しには出さない行なので、「新しい案内」には数えない（ゴールの方で知らせる）
      con.markRead(con.guide("# 工場が動き出しました。出てくるものが原石から木箱に変わります"));
      // どこまで行けばクリアか、次に何をするかがどこに出るかを、最初に 1 回だけ伝える
      guide(`# 研究を進めて、最後の「${RELEASE_LABEL}」を入れたらクリアです。次にやることは${researchPlace("に")}出ます`, {
        kind: "goal", kicker: "ゴール", group: "onboarding", key: "goal",
        // 「12/25 リリース」を 2 行に分けない
        short: `研究を進めて、最後の「${RELEASE_LABEL.replace(/ /g, "\u00a0")}」を入れたらクリアです`,
      });
    }
    // わざと壊したコードの直後を分母にしないよう、これまでの単価記録とも比べる
    const best = state.stats.bestDeploy;
    const gain = after / Math.max(before, recordBefore);
    if (Number.isFinite(gain) && gain > 1 && (!best || gain > best.ratio)) {
      state.stats.bestDeploy = { before: prevCode ?? NO_PACK_YET, after: code, ratio: gain };
    }
    if (!eff.polish && res.newResults.some((r) => r.polished?.length > 0)) {
      con.line("# 研究「研磨機」を買うまでは、polish しても傷は消えません。いまは磨くたびに研磨機が熱くなり、鑑定が 1 回、2 回、3 回…と増えるだけです", "warn");
    }
    if (/\.with\s*\(/.test(code) && after <= before * 1.02) {
      con.line("# with で作った Ore も id は同じなので、JS は元のデータで値段を付けます。carat を書き換えても単価は上がらず、with の鑑定 3 回ぶんかかるだけです", "warn");
    }
    if (res.newResults[0]?.log) con.output(res.newResults[0].log);
    checkMemo(res.newResults[0]?.log);
    // 監査はベンチ 3 本で最初に判定する。捕まればバナーと一緒に報告を出す
    checkAudit();
    con.reveal("banner");
  } else if (revert) {
    con.line(`→ ${toInitial ? "初期コード" : "前のコード"}に戻しました。単価 ${fmtOre(after)}/ore`, "ok");
  } else {
    con.line(`# 前回のコードを入れ直しました。単価 ${fmtOre(after)}/ore`, "note");
  }
  if (silent) checkAudit({ silent: true });
  if (res.newResults.some((r) => r.monkeyPatched)) {
    achieve("monkeypatcher", "実績「モンキーパッチャー」: Yield の鑑定の数え方を書き換えました");
    findPage("monkeypatch");
  }
  inspect(newPriced[0]);
  return { ok: true, before, after };
}

function deployFailed(res, code, { silent, revert, chain, restore }) {
  if (res.rejected) {
    sfx.error();
    const p = res.priced?.[0];
    const issues = p?.issues ?? [];
    setFault(p?.ok === false ? "jam" : "inspect-error", "有効な箱 0", 4500);
    inspect.lastKey = null;
    con.ticket({ kind: "inspect", tag: "デプロイ中止", title: "有効な箱が 1 つもなく、全部スクラップです",
      rows: issues.map((s, i) => [i === 0 ? "差分" : "", s]), hint: `値段は有効な箱にしか付きません。${runningOn()}` });
    for (const s of issues) con.line(`検品: ${s}`, "warn");
    if (res.log) con.output(res.log);
    con.line(`→ 有効な箱が 1 つもないのでデプロイしませんでした。${runningOn()}`, "ok");
  } else if (res.stage === "compile") {
    sfx.error();
    const cls = res.errClass || "(無名の例外)";
    const fw = fullwidthHint(code, res.message ?? "");
    editor.markError(res.line, `${cls}: ${res.message}`);
    con.ticket({ kind: "syntax", tag: "デプロイ中止", title: `${res.line ? `pack.rb:${res.line} ` : ""}${cls}`, rows: [["メッセージ", res.message ?? ""]],
      hint: [fw, runningOn()].filter(Boolean).join("。") });
    con.line(`${cls}: ${res.message}`, "err");
    if (fw) con.line(`  ${fw}`, "warn");
    // エラーの前までに出たトップレベルの出力
    if (res.log) con.output(res.log);
    checkMemo(res.log);
    con.line(`→ デプロイを中止しました。${runningOn()}`, "ok");
  } else if (res.stage === "bench") {
    rubyFailure(res, "deploy", code);
    if (res.line) editor.markError(res.line, `${res.errClass}: ${res.message}`);
    con.line(`→ ベンチで止まったのでデプロイしませんでした。${runningOn()}`, "ok");
  } else {
    rubyFailure(res, "deploy", code);
  }
  // 行番号つきのエラーはエディタの下に出ていて見える。送るとコードの赤線が画面外に出るので、行のないものだけ送る
  if (!silent && res.stage !== "compile" && !(res.stage === "bench" && res.line)) con.reveal("ticket");
  if (res.busy || res.reason) return;
  // 自動の戻し・リロード復帰の入れ直しが通らなかったら、履歴をさかのぼる（最後は初期コード）
  if (chain || (restore && runtime.lastGoodSrc == null)) {
    fallBack(code, { revert: chain && revert, restore: restore && !chain });
    return;
  }
  // 「前のコードに戻す」ボタンで選んだコードが通らなかった。履歴から外して、次に押せばさらに前へ戻れるようにする
  if (revert && state.codeHistory.at(-1) === code) {
    state.codeHistory.pop();
    con.line(state.codeHistory.length
      ? "# このコードはいまはベンチを通らないので履歴から外しました。もう一度押すと、さらに前のコードに戻ります"
      : "# このコードはいまはベンチを通らないので履歴から外しました", "note");
  }
}

/** 鑑定回数が変わったときの工場の処理量（個/秒）と、いまのボトルネックから見た一言 */
function refineryChange(opsBefore, opsAfter) {
  if (!(opsBefore > 0) || !(opsAfter > 0)) return null;
  const { opsMul } = eco.derive(state);
  const cpu = eco.cpuRate(state);
  const before = cpu / (opsBefore * opsMul);
  const after = cpu / (opsAfter * opsMul);
  const caps = eco.capacities(state);
  const upstream = Math.min(caps.mine, caps.belt);
  const note = before < upstream && after >= upstream ? "工場の赤が消えます"
    : before < upstream ? "工場はまだ赤ですが、そのぶん出荷が増えます" : "";
  return { before, after, note };
}

/**
 * 単価は上がったのに、いまの設備のまま流すと収入が下がるときの一言（研磨で鑑定が増えて工場が詰まる、余りの箱でドックが詰まるなど）。
 * 下がらなければ空文字。x = { value, ops, crates }（1 鉱石あたりの単価・鑑定・箱）
 */
function jamNote(prev, next) {
  const j = jamCheck(prev, next);
  if (!j) return "";
  return [
    `ただし、いまの設備だと${j.stage}が詰まります。${j.stage} ${eco.formatNumber(j.capFrom)} → ${eco.formatNumber(j.capTo)} 個/秒で、収入は ${eco.formatMoney(j.incomeFrom)}/s → ${eco.formatMoney(j.incomeTo)}/s に下がります`,
    j.fix,
  ].filter(Boolean).join("。");
}

/** 吹き出し用の短い文 */
function jamShort(j, { sp = false } = {}) {
  if (!j) return undefined;
  // 金額は丸めると前後が同じに見えることがあるので、吹き出しには出さない（ログとバナーには出ている）。
  // スマホは「ショップへ」のボタンを横に付けるので、どこで買うかは書かない
  const fix = j.bn === "refinery" ? (sp ? "コアを足してください" : "ショップで工場のコアを足してください")
    : j.bn === "dock" ? (sp ? "ドックを足してください" : "ショップでドックを足してください") : "";
  return [`${sp ? "" : "このままだと"}${j.stage}が詰まって収入が下がります`, fix].filter(Boolean).join("。");
}

/** jamNote の中身。収入が下がらなければ null */
function jamCheck(prev, next) {
  const { opsMul } = eco.derive(state);
  const caps0 = eco.capacities(state);
  const flowOf = (x) => {
    const caps = {
      mine: caps0.mine,
      belt: caps0.belt,
      refinery: x.ops > 0 ? eco.cpuRate(state) / (x.ops * opsMul) : Infinity,
      dock: x.crates > 0 ? eco.dockRate(state) / x.crates : Infinity,
    };
    // 同じ値なら下流をボトルネックにする（flowInfo と同じ）
    let bn = eco.STAGES[0];
    for (const s of eco.STAGES) if (caps[s] <= caps[bn]) bn = s;
    return { caps, bn, income: caps[bn] * x.value };
  };
  const a = flowOf(prev);
  const b = flowOf(next);
  if (!(a.income > 0) || !(b.income < a.income * 0.97)) return null;
  const fix = b.bn === "refinery" ? "ショップで工場のコアを足すと、単価の伸びがそのまま収入に出ます"
    : b.bn === "dock" ? "ドックを足すか、余りの箱を減らすと、単価の伸びがそのまま収入に出ます" : "";
  return {
    bn: b.bn, stage: eco.STAGE_LABEL[b.bn], fix,
    capFrom: a.caps[b.bn], capTo: b.caps[b.bn], incomeFrom: a.income, incomeTo: b.income,
  };
}

function revertToPrevious() {
  const prev = state.codeHistory.at(-1);
  if (!prev) return;
  editor.set(prev);
  con.line("# 前のコードをエディタに戻してデプロイします", "note");
  deploy(prev, { revert: true });
}

// ---------------------------------------------------------------- 買い物と研究

function buyItem(kind, key) {
  const r = eco.buy(state, kind, key);
  if (!r.ok) return;
  sfx.click(7);
  refresh();
}

function latestResearch() {
  const key = state.research.at(-1);
  return key ? RESEARCH.find((r) => r.key === key) : null;
}

function openResearchCard(key) {
  const def = RESEARCH.find((r) => r.key === key);
  if (!def) return;
  cards.research(def, { onInsert: insertPack });
}

/** 研究カードの「エディタに入れる」 */
function insertPack(code) {
  editor.set(code);
}

/** 買えなかった研究の理由を、ログに続けて積まないための記録 */
const lastRefusal = { msg: "", at: -Infinity };

function buyResearch(key) {
  const before = new Set(state.research);
  const priceBefore = eco.effectiveEma(state).valuePerOre;
  const refBefore = eco.flowInfo(state).caps.refinery;
  const def = RESEARCH.find((x) => x.key === key);
  const r = eco.buy(state, "research", key);
  if (!r.ok) {
    // 単価記録が足りないときは、どのコードを書けば届くかも出す
    const gated = def?.requires?.note && (state.record ?? 0) < (def.requires.record ?? 0);
    // 押した行のそばで理由を見せる。ログには同じ行を続けて積まない
    gemfile.refuse(key, r.reason);
    const msg = `# ${r.reason}${gated ? `。${def.requires.note}` : ""}`;
    const now = performance.now();
    if (msg !== lastRefusal.msg || now - lastRefusal.at > 5000) con.line(msg, "note");
    lastRefusal.msg = msg;
    lastRefusal.at = now;
    return;
  }
  // 直後の即時バッチ（box・色の変更）が新しい研究の効果で回るよう、ここで導き直す
  eff = eco.derive(state);
  fi = eco.flowInfo(state);
  sfx.bundle();
  con.line("$ bundle install", "cmd");
  con.line(`Fetching ${def.gem} ${def.version ?? "1.0.0"} / Installing ${def.gem} ${def.version ?? "1.0.0"}`, "dim");
  const deps = before.size + 1;
  con.line(`Bundle complete! ${deps} Gemfile ${deps === 1 ? "dependency" : "dependencies"}. ${def.label}: ${def.summary}`, "ok");
  const e = def.effect;
  refresh();
  if (e.ending) {
    state.stats.clearedAt = state.stats.clearedAt ?? Date.now();
    // 成績表と、そのカードからの X の投稿で同じ最高単価を出す。クリアのあとも単価記録は伸びるので、ここで残しておく
    state.stats.recordAtClear = state.stats.recordAtClear ?? state.record;
    showEnding();
    return;
  }
  let probe = null;
  if (e.rubyProbe) {
    probe = runtime.ready.then(() => runtime.probe(e.rubyProbe)).catch((err) => ({ ok: false, errClass: "VMDown", message: String(err?.message ?? err) }));
    probe.then((p) => {
      con.type(`irb> ${e.rubyProbe}\n${p.ok ? `=> ${p.value}` : `${p.errClass}: ${p.message}`}`, "err");
      if (def.probeNote) setTimeout(() => {
        con.line(def.probeNote, "ok");
        // 単価が変わらない研究なので、工場の処理量の伸びをバナーで見せる
        const now = eco.flowInfo(state);
        const refAfter = now.caps.refinery;
        if (state.deployed && refBefore > 0 && Number.isFinite(refBefore) && refAfter > refBefore * 1.05) {
          // 最終段のベルトはもう強化できないので、「強化すると伸びます」とは言わずに次の研究を指す
          const maxedBelt = now.bottleneck === "belt" && !Number.isFinite(eco.priceOf(state, "belt"));
          const note = now.bottleneck === "refinery" ? "まだ工場が赤です。CPU を足すか、鑑定の少ないコードにすると伸びます"
            : maxedBelt ? `いまの赤は最終段階のベルトです。${eco.maxedBeltNote(state)}`
            : `いまの赤は${eco.STAGE_LABEL[now.bottleneck]}です。工場に余裕ができたので、${eco.STAGE_LABEL[now.bottleneck]}を強化すると収入が伸びます`;
          const { head } = con.speed({ label: def.label, before: refBefore, after: refAfter, note });
          con.line(head, "ok");
        }
      }, 1600);
    });
  }
  cards.research(def, { onInsert: insertPack, probe });
  if (key === NOTEBOOK_HINT_AFTER) setTimeout(hintNotebook, NOTEBOOK_HINT_DELAY_MS);
  if (state.deployed && (e.box || e.color || e.bonus || e.polish)) {
    if (!researchBase || researchBase.code !== state.lastGoodCode) researchBase = { value: priceBefore, labels: [], code: state.lastGoodCode };
    researchBase.labels.push(def.label);
    pendingResearch = { label: def.label, before: priceBefore, tip: def.hint?.methods?.length ? def.hint.tip : "", rlen: state.research.length };
    // box を読むコードのまま箱の研究を買った。倍率は次のバッチで分かるので、showResearchGain で見せる
    if (e.box > 3 && readsBox(state.lastGoodCode)) pendingResearch.box = e.box;
  }
  // トップレベルで box を読んだ定数（SIZE = box）も新しい箱サイズで読み直すよう、次のバッチの前に VM を作り直す
  if (e.box) runtime.setBox(eff.box);
  if (e.box || e.color) requestBatch();
  else if (e.bonus || e.polish) {
    rePriceRecent();
    if (pendingResearch && recent.length > 0) showResearchGain(eco.effectiveEma(state).valuePerOre);
    // いまのコードでも合計 25 の箱が偶然できていれば、その場で見せる
    if (e.bonus === "christmas" && recent.length > 0) {
      const n = recent.reduce((s, b) => s + christmasCrates(b.priced), 0) / recent.length;
      if (n >= 1) cards.afterClose(() => christmasTruck(n, { truck: false }));
    }
  }
}

/** 研究だけで単価が上がった分を、コードの書き換えとは別のバナーで見せる */
function showResearchGain(after) {
  const p = pendingResearch;
  pendingResearch = null;
  if (!p || !(p.before > 0)) return;
  // 研究カードを開いたままだと、バナーも判子もカードの幕の裏で終わってしまう。閉じてから見せる
  cards.afterClose(() => researchGainShow(p, after));
}

/** スマホの吹き出し（2 行）に tip をそのまま入れる長さの上限 */
const TIP_SP_MAX = 26;

function researchGainShow(p, after) {
  if (!(after >= p.before * 1.05)) {
    // 箱の研究は、1 個ずつ詰めるコードのままだと単価が変わらない。何も出さないと次の一手が消えるので促す
    if (p.tip && unappliedResearch(state.research, state.lastGoodCode, RESEARCH, { shows: effectShows })?.label === p.label) {
      const { head } = con.nudge({ label: p.label, tip: p.tip });
      con.line(`# ${head}`, "note");
      const tip = tipSentence(p.tip);
      guide(`# 次の 1 行: ${p.tip}`, {
        kicker: "次にやること", key: `nudge:${p.label}`, short: `研究「${p.label}」は、いまのコードではまだ効いていません。${tip}`,
        sp: tip.length <= TIP_SP_MAX ? `${tip}。「${p.label}」が効きます` : `「${p.label}」はまだ効いていません。書き方はヒントで見られます`,
      });
    }
    return;
  }
  const { head, ratio } = con.research({ label: p.label, before: p.before, after, tip: p.tip, box: p.box });
  con.line(head, "ok");
  // まだコードに取り入れていないときだけ、書き換えの一手を出す
  if (p.tip && !p.box && unappliedResearch(state.research, state.lastGoodCode, RESEARCH, { shows: effectShows })?.label === p.label) {
    const tip = tipSentence(p.tip);
    guide(`# 次の 1 行: ${p.tip}`, {
      kicker: "次にやること", key: `gain:${p.label}`, short: `研究「${p.label}」で単価が ${fmtRatio(ratio)} 倍になりました。${tip}`,
      sp: `単価が ${fmtRatio(ratio)} 倍になりました。${tip.length <= TIP_SP_MAX ? tip : "書き換えるともっと伸びます"}`,
    });
  }
  if (p.box) boxUpShow(p.box, ratio);
}

/** コメントと文字列を除いたコードが box を読んでいるか（each_slice(box)・each_cons(box)・SIZE = box など） */
function readsBox(code) {
  return /\bbox\b/.test(stripCode(code ?? ""));
}

/**
 * box を読むコードが、箱の研究だけで跳ねた瞬間。判子と大きな帯で見せる。
 * 実績は 1 回きりだが、見せ場は箱 5・7・9 のたびに出す（実績を持っているセーブでも出す）
 */
function boxUpShow(box, ratio) {
  const r = fmtRatio(ratio);
  // 同じバッチで出た NEW RECORD の帯は、こちらで上書きする
  view.celebrate(`書き換えなしで ×${r}`);
  // 帯は判子の上に描くので、帯が抜けてから工場に判子を押す
  setTimeout(() => view.stamp(`BOX ${box} ×${r}`, "refinery"), BOX_STAMP_DELAY_MS);
  achieve("no_hardcode", `実績「ハードコードしなかった」: コードが box を読んでいたので、書き換えなしで箱 ${box} の単価が ${r} 倍になりました`);
}

/** 有効な箱のうち、クリスマス便が付いた箱の数 */
function christmasCrates(priced) {
  return (priced?.crates ?? []).filter((c) => c.valid && c.bonuses?.some((b) => b.key === "christmas")).length;
}

let lastXmasTruck = -Infinity;
/**
 * クリスマス便の見せ場。金色のトラックと判子。n は 1 バッチあたりの箱の数。
 * 研究を買った直後（偶然できた数箱）は判子だけにして、トラックは書き換えで箱が増えたときに取っておく
 */
function christmasTruck(n, { truck = true } = {}) {
  const t = performance.now();
  // 書き換えたときは NEW RECORD の帯がドックに重なるので、帯が抜けてから判子を押す
  if (truck) setTimeout(() => view.stamp("クリスマス便 ×4", "dock"), BOX_STAMP_DELAY_MS);
  else view.stamp("クリスマス便 ×4", "dock");
  if (!truck || t - lastXmasTruck < XMAS_TRUCK_GAP_MS) return;
  lastXmasTruck = t;
  view.specialDelivery(`クリスマス便  ${Math.round(n)} 箱/バッチ`);
  sfx.specialDelivery();
}

function rePriceRecent() {
  if (!state.deployed) return;
  if (recent.length === 0) {
    requestBatch();
    return;
  }
  // ボーナスが増えるとラインも上がるので、値付けし直すときも監査を通す
  for (const b of recent) b.priced = priceAudited(b.belt, b.result, b.box, b.colors ?? eff.colors);
  applyRecent();
  checkAudit();
}

function achieve(key, text) {
  if (state.achievements.includes(key)) return;
  state.achievements.push(key);
  con.line(text, "ok");
}

function onRecord(prev, now) {
  const t = performance.now();
  if (prev > 0 && now >= prev * 1.05 && t - lastCelebrate > 6000) {
    lastCelebrate = t;
    view.celebrate(`NEW RECORD  ${fmtOre(now)}/ore`);
    sfx.record();
  }
  for (const r of RESEARCH) {
    const need = r.requires?.record;
    if (need != null && prev < need && now >= need && !state.research.includes(r.key)) {
      guide(`# 単価記録 ${eco.formatMoney(need)} に届きました。研究「${r.label}」の条件クリア`, {
        cls: "ok", kicker: "研究", key: `gate:${r.key}`, short: `単価記録が ${eco.formatMoney(need)} に届きました。「${r.label}」を入れられます`,
      });
    }
  }
}

// ---------------------------------------------------------------- 手掘り・診断

function onMineClick() {
  const { earned } = eco.clickMine(state);
  const t = performance.now();
  clickStreak = t - lastClickAt < 700 ? clickStreak + 1 : 0;
  lastClickAt = t;
  sfx.click(clickStreak);
  view.popMoney(earned, "mine");
}

function openDiagnose(stage) {
  cards.diagnose(stage, () => ({ ...eco.diagnose(state, stage), moneyNow: state.money }), {
    onBuy: (kind, key) => buyItem(kind, key),
  });
}

/** pack.rb の早見表。box の値・流れてくる色・研磨の有無は開いた時点の研究から作る */
function openRi() {
  cards.show("ri", h("div", { class: "card ri" },
    h("div", { class: "card-kicker" }, "$ ri pack"),
    h("h3", {}, "pack.rb の早見表"),
    h("pre", { class: "card-code" }, riText(eco.researchEffects(state.research)))));
}

function toggleMute() {
  state.muted = !state.muted;
  sfx.setMuted(state.muted);
  refresh();
}

// 整列（1:40 ごろ）のあとに、裏口ノートの場所を 1 行だけ出す。終盤のナッジ（8:40 以降）まで場所を知らないままにならないように。
// 研究の直後は sort_by の案内と単価のバナーが続くので、それが出終わってから出す
const NOTEBOOK_HINT_AFTER = "sorter";
const NOTEBOOK_HINT_DELAY_MS = 6000;
function hintNotebook() {
  if (!state.deployed) return; // ノートは初回デプロイまで出ていない
  const n = state.notebook?.length ?? 0;
  if (n >= NOTEBOOK.length) return;
  guide(`# ところで、この工場にはドキュメントにない扉があるらしい。${researchPlace("の")}いちばん下に「裏口ノート」があります。いまは ${n}/${NOTEBOOK.length}。Ruby 好き向けの寄り道なので、見つけなくてもクリアできます`, {
    kind: "notebook", kicker: "裏口ノート", key: "notebook-hint",
    short: `${researchPlace("の")}いちばん下に裏口ノートがあります。見つけなくてもクリアできます`,
    sp: "研究のタブのいちばん下に、寄り道用の裏口ノートがあります",
  });
}

const NUDGE_MIN_WAIT = 30;
// 条件がこの秒数続いてから出す。研究を買った直後は、収入が新しい単価に追いつく前の値なので、残り秒数を長く見積もる
// （待たずに出すと、定量梱包 III を買った同じティックに出て、研究のログに流されてしまう）
const NUDGE_HOLD_SEC = 6;
/** 終盤のナッジ（SPEC-rubyist 2.5）。最終段のベルトが赤く、次の研究まで待つだけのときに 1 回だけ（リロードしても出直さない） */
function maybeNudge(dt) {
  if (state.nudged || !nudgeReady()) {
    nudgeHold = 0;
    return;
  }
  nudgeHold += dt;
  if (nudgeHold < NUDGE_HOLD_SEC) return;
  state.nudged = true;
  const n = state.notebook?.length ?? 0;
  guide(`# 待っている間に、工場の中を覗いてみませんか。この工場には、ドキュメントにない扉があるらしい。裏口ノートはいま ${n}/${NOTEBOOK.length}`, {
    kind: "notebook", kicker: "裏口ノート", key: "notebook-nudge",
    short: `次の研究まで少しかかります。裏口ノートを探してみませんか。いま ${n}/${NOTEBOOK.length}`,
  });
}

function nudgeReady() {
  if (!state.deployed || fi.passthrough || fi.bottleneck !== "belt") return false;
  if ((state.belt ?? 0) < BELTS.length - 1) return false;
  const next = eff.nextResearch;
  if (!next || state.money >= next.price) return false;
  if (next.requires?.record != null && (state.record ?? 0) < next.requires.record) return false;
  if ((state.notebook?.length ?? 0) >= NOTEBOOK.length) return false;
  // 研究の直前に出すと、すぐ研究のログに流される。次の研究まで NUDGE_MIN_WAIT 秒以上待つときだけ
  const income = fi.incomePerSec ?? 0;
  return income > 0 && (next.price - state.money) / income >= NUDGE_MIN_WAIT;
}

// ---------------------------------------------------------------- エンディング

/** 離れていた時間。時刻と読み違えないよう「5 分 30 秒」「1 時間 5 分」の形にする */
function duration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h) return `${h} 時間${m ? ` ${m} 分` : ""}`;
  return m ? `${m} 分${ss ? ` ${ss} 秒` : ""}` : `${ss} 秒`;
}

function showEnding() {
  const st = state.stats;
  const code = state.lastGoodCode ?? "";
  const lines = code.replace(/\n$/, "").split("\n").length;
  const best = st.bestDeploy;
  const nb = state.notebook?.length ?? 0;
  const desc = vm.description ?? "ruby (wasm32-wasi)";
  // 6/6 なら RUBY_DESCRIPTION の [ の前に +BACKDOOR（SPEC-rubyist 3.3）
  const heading = nb >= NOTEBOOK.length ? (/ \[[^\]]*\]\s*$/.test(desc) ? desc.replace(/ (\[[^\]]*\])\s*$/, " +BACKDOOR $1") : `${desc} +BACKDOOR`) : desc;
  const rows = [
    ["総出荷数", `${eco.formatNumber(Math.floor(st.shipped))} 個`],
    ["最高単価", `${fmtOre(st.recordAtClear ?? state.record)}/ore`],
    ["デプロイ回数", `${st.deploys} 回`],
    ["最後のコード", `${lines} 行`],
    // バナーの見出しは研究前の単価との比のことがあるので、成績表は「それまでの単価記録との比」だと書いておく
    ["単価記録を一番伸ばしたデプロイ", best ? `${fmtRatio(best.ratio)}x` : "-"],
    ["無限ループから生還", `${st.restarts} 回`],
    ["クリアタイム", elapsed((st.clearedAt ?? Date.now()) - st.startedAt)],
    ["裏口ノート", `${nb}/${NOTEBOOK.length}`],
    ["鑑定長に見抜かれた", `${state.audits ?? 0} 回`],
  ];
  const text = [
    "# def pack(belt) 12/25 Release Notes",
    heading,
    "",
    ...rows.map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## 最後の pack.rb",
    "```ruby",
    code.replace(/\n$/, ""),
    "```",
    ...(best ? ["", `## 単価記録を ${fmtRatio(best.ratio)} 倍にしたデプロイ`, "```ruby", "# before", (best.before === "（素通し）" ? NO_PACK_YET : best.before).replace(/\n$/, ""), "# after", best.after.replace(/\n$/, ""), "```"] : []),
  ].join("\n");
  sfx.record();
  view.celebrate("RELEASED  12/25");
  cards.ending({ heading, rows, text, onCopy: copyText, onShare: () => shareOnX({ atClear: true }) });
}

/**
 * X の投稿画面を新しいタブで開く。クリア前は研究の進み具合、クリア後はクリアタイムを載せる。コードは載せない。
 * atClear は成績表のカードから押したとき。最高単価をカードと同じクリア時点の値にする
 */
function shareOnX({ atClear = false } = {}) {
  const text = shareText(state, { url: pageUrl(location), notebookTotal: NOTEBOOK.length, atClear });
  // クリックの中で同期的に開く（await を挟むとポップアップとして止められる）
  window.open(intentUrl(text), "_blank", "noopener,noreferrer");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------- スマホのタブ

function setupTabs() {
  const saved = (() => { try { return localStorage.getItem("yield-factory/tab"); } catch { return null; } })();
  setTab(saved && ["code", "shop", "research"].includes(saved) ? saved : "code");
  for (const b of document.querySelectorAll(".tab")) b.addEventListener("click", () => setTab(b.dataset.tab));
  // タブを出すのは 900px 未満だけ。広い画面では 3 つのパネルが全部見えているので、タブパネルとして読み上げさせない
  const narrow = globalThis.matchMedia?.("(max-width: 899px)");
  const applyRoles = () => {
    for (const b of document.querySelectorAll(".tab")) {
      const panel = document.getElementById(b.getAttribute("aria-controls"));
      if (!panel) continue;
      if (narrow?.matches) {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", b.id);
      } else {
        panel.removeAttribute("role");
        panel.removeAttribute("aria-labelledby");
      }
    }
  };
  applyRoles();
  narrow?.addEventListener?.("change", applyRoles);
}

function setTab(tab) {
  app.dataset.tab = tab;
  for (const b of document.querySelectorAll(".tab")) {
    const on = b.dataset.tab === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  try { localStorage.setItem("yield-factory/tab", tab); } catch { /* 設定を覚えないだけ */ }
}

// ---------------------------------------------------------------- ループ

/** デプロイできるようになったときの吹き出しの文。スマホで別のタブを見ていたら、コードのタブに戻るよう添える */
function deployReadyShort() {
  const where = isPhone() && app.dataset.tab !== "code" ? "コードのタブで" : "";
  return `${where}デプロイを押すと工場が動きます`;
}

function refineryStatus() {
  // 素通し中でも初回デプロイの失敗は札で見せる
  if (fault && performance.now() < fault.until) return fault.status;
  if (!state.deployed) return vm.ready ? "passthrough" : "booting";
  return "running";
}

function crateFeed() {
  if (!state.deployed) {
    const c = eff.colors[Math.floor(Math.random() * eff.colors.length)];
    return { raw: true, value: 1, cells: [{ color: c, carat: 1 + Math.floor(Math.random() * 9), flaw: Math.random() < 0.25, polished: false }], bonuses: [], perfect: false };
  }
  const list = state.lastCrates;
  if (!list?.length) return null;
  return list[feedIdx++ % list.length];
}

function viewModel() {
  const status = refineryStatus();
  return {
    flow: fi.flow,
    caps: fi.caps,
    util: fi.util,
    bottleneck: fi.passthrough ? null : fi.bottleneck,
    backlog,
    spill: backlog >= 200 ? fi.backlogRate : 0,
    passthrough: !state.deployed,
    refineryStatus: status,
    // 素通し・起動中の札は view が自分で書くので、2 行目は故障のときだけ
    refineryLabel: status === "running" || status === "passthrough" || status === "booting" ? "" : fault?.label ?? "",
    machines,
    // 研磨機の熱。直近のバッチで polish を呼んだ回数（同じ原石を 2 回磨けば 2 回）
    polishHeat: recent.at(-1)?.result?.polished?.length ?? 0,
    colors: eff.colors,
    beltTier: state.belt ?? 0,
    crateFeed,
    vmProgress: vmProgress(),
    incomePerSec: fi.incomePerSec,
    money: state.money,
    // 裏口ノート・監査の演出（SPEC-rubyist 4.11）。2 車線は view が最終段のベルトのときだけ 2 本で描く
    lanes: state.backdoor?.lanes ?? 1,
    // 夜間ラインが効くのは惑星コアと軌道エレベータだけなので、どちらかを持つまでは絵を出さない
    nightShift: eco.backdoorOf(state).night && ((state.mines?.[BACKDOOR.nightMine] ?? 0) > 0 || (state.docks?.[BACKDOOR.nightDock] ?? 0) > 0),
    overtimeUntil,
    audited: auditReported,
  };
}

let lastTick = performance.now();
function logicTick() {
  const now = performance.now();
  const raw = (now - lastTick) / 1000;
  const dt = Math.min(2, raw) * timeScale;
  lastTick = now;
  eff = eco.derive(state);
  fi = eco.tick(state, dt).flowInfo;
  if (raw > 2) creditAway(raw - 2);
  state.stats.restarts = restartsNow();

  if (fi.passthrough || fi.bottleneck !== lastBn) backlog = 0;
  lastBn = fi.passthrough ? null : fi.bottleneck;
  backlog = Math.min(200, backlog + fi.backlogRate * dt);

  if (now >= nextBatchAt) {
    nextBatchAt = Math.max(nextBatchAt + BATCH_INTERVAL_MS, now - BATCH_INTERVAL_MS / 2);
    runBatch();
  }
  maybeNudge(dt);
  refresh();
}

/** タブが裏でタイマーを間引かれた分。SPEC 10.7 のオフライン進行と同じく収入の半分、上限 8 時間 */
function creditAway(sec) {
  const s = Math.min(sec, 8 * 3600);
  const gain = fi.incomePerSec * s * 0.5;
  if (!(gain > 0)) return;
  state.money += gain;
  state.totalEarned = (state.totalEarned ?? 0) + gain;
  state.stats.shipped = (state.stats.shipped ?? 0) + fi.flow * s * 0.5;
  // 裏のタブではタイマーが 1 分に 1 回ほどに間引かれ、ここが何度も呼ばれる。戻ってきたときに合計で 1 回だけ知らせる
  away.sec += sec;
  away.gain += gain;
  if (!document.hidden && !away.timer) flushAway();
}

const away = { sec: 0, gain: 0, timer: null };
function flushAway() {
  away.timer = null;
  const { sec, gain } = away;
  away.sec = 0;
  away.gain = 0;
  if (sec < 30 || !(gain > 0)) return;
  guide(`# 離れていた ${duration(sec)}のあいだに ${eco.formatMoney(gain)} 稼ぎました。離れている間の収入は半分です`, {
    kicker: "おかえりなさい", short: `離れていた ${duration(sec)}のあいだに ${eco.formatMoney(gain)} 稼ぎました`,
  });
}
// 戻ってきた直後の取り戻し（次の logicTick）も足してから出す
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && away.sec > 0 && !away.timer) away.timer = setTimeout(flushAway, 400);
});

/** 研究の効果（ボーナスや大きい箱）が、直近に出荷した箱に出ているか */
function effectShows(def) {
  const crates = state.lastCrates ?? [];
  if (def.effect.bonus) {
    // 無傷・昇順・単色は偶然でも付くので、ほぼ全部の箱に付いているときだけ。ストレートは余りの箱が出るので 4 分の 1。
    // クリスマス便は、ストレートのままのコードでも先頭 64 箱の 1 割前後に偶然付き、窓を値段順に取ると 5 割を超える
    if (crates.length === 0) return false;
    const hit = crates.filter((c) => c.bonuses?.some((b) => b.key === def.effect.bonus)).length;
    return hit / crates.length >= (EFFECT_SHARE[def.effect.bonus] ?? 0.9);
  }
  if (def.effect.box) return crates.some((c) => (c.cells?.length ?? 0) > 1);
  if (def.effect.polish) return crates.some((c) => c.cells?.some((x) => x.polished));
  return false;
}

let refreshN = 0;
function refresh() {
  const chk = eco.canDeploy(state, vm.ready);
  const remaining = Math.max(0, 5 - (state.mines.pickaxe ?? 0));
  let label, note = "";
  if (deploying) label = "デプロイ中…";
  else if (!state.deployed && remaining > 0) {
    label = `つるはし 5 本で工場が動きます。あと ${remaining} 本`;
    if (!vm.ready) note = vmText();
  } else if (!vm.ready) label = `Ruby VM を準備中… ${Math.round((vmProgress() ?? 0) * 100)}%`;
  else label = state.deployed ? "デプロイ" : "デプロイして工場を動かす";
  editor.setDeploy({ label, ok: chk.ok && !deploying, busy: deploying, glow: chk.ok && !state.deployed && !deploying, note });
  // VM が先にできて、あとからつるはしが 5 本そろった。デプロイできるようになったことを 1 回だけ知らせる
  if (!state.deployed && chk.ok && !deploying && !readyGuided) {
    readyGuided = true;
    guide(`# つるはしが ${FIRST_DEPLOY_PICKAXES} 本そろいました。デプロイを押すと工場が動きます`, {
      kicker: "デプロイできます", group: "onboarding", key: "deploy-ready", short: deployReadyShort(),
    });
  }
  editor.setRevert(state.codeHistory.length > 0 && !deploying);
  const latest = latestResearch();
  const latestIdx = latest ? RESEARCH.indexOf(latest) : -1;
  editor.setSolution(!!latest?.hint?.solution && latestIdx < STRAIGHT_INDEX && !state.research.includes("straight"), latest ? `${latest.label} の完成コード` : "");

  const valuePerOre = eco.effectiveEma(state).valuePerOre;
  hud.update({
    incomePerSec: fi.incomePerSec + (state.clickRate ?? 0) * Math.max(1, valuePerOre),
    valuePerOre, record: state.record, muted: state.muted, vmText: vmText(), vmPhase: vm.phase,
  });
  // ショップの BOTTLENECK は工場の判子（1.5 秒留まってから移る）と揃える
  shop.update(state, !fi.passthrough && view.bn ? { ...fi, bottleneck: view.bn } : fi);
  // 字句だけだと find_all や自前の詰め方を「未使用」と言ってしまうので、出荷した箱に効果が出ていれば使っているとみなす
  const todo = refresh.todo = state.deployed ? unappliedResearch(state.research, state.lastGoodCode, RESEARCH, { shows: effectShows }) : null;
  gemfile.update(state, { pending: todo?.key ?? null });
  editor.setTodo(todo ? { text: `研究「${todo.label}」の次の 1 行: ${todo.hint.tip}`, methods: todo.hint.uses } : null);
  notebook.update({ visible: state.deployed, found: state.notebook ?? [], features: state.notebookFeatures ?? {} });
  if (++refreshN % 5 === 0) cards.tick();

  // スマホのタブに「押せるものがある」印を付ける
  const shopHot = !!document.querySelector("#shop .item.afford:not([hidden])");
  const resHot = !!document.querySelector("#gemfile .gem.afford");
  // コードのタブは、デプロイできるとき・ログ欄を見ていないあいだに案内が届いたときに印を付ける
  const codeHot = (chk.ok && !state.deployed) || (con.unread > 0 && isPhone());
  for (const [tab, hot] of [["shop", shopHot], ["research", resHot], ["code", codeHot]]) {
    document.querySelector(`.tab[data-tab="${tab}"]`)?.classList.toggle("hot", hot);
  }

  // 自動テスト・デバッグ用に生の値を出す（表示は補間・整形されているので）
  const d = document.body.dataset;
  d.money = String(state.money);
  d.valuePerOre = String(valuePerOre);
  d.record = String(state.record);
  d.bottleneck = fi.passthrough ? "none" : fi.bottleneck;
  d.vm = vm.phase;
  d.deployReady = chk.ok && !deploying ? "1" : "0";
  d.deploying = deploying ? "1" : "0";
  d.deployed = state.deployed ? "1" : "0";
  d.refinery = refineryStatus();
  d.box = String(eff.box);
  d.research = state.research.join(",");
  d.pickaxes = String(state.mines.pickaxe);
  d.cratesPerOre = String(state.ema.cratesPerOre);
  d.opsPerOre = String(state.ema.opsPerOre);
  d.notebook = String(state.notebook?.length ?? 0);
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  view.frame(dt, viewModel());
  hud.frame(dt, { money: state.money });
  requestAnimationFrame(frame);
}

const equipment = (s) => [s.mines, s.cpus, s.docks].reduce((n, o) => n + Object.values(o ?? {}).reduce((a, b) => a + (b || 0), 0), 0) + (s.belt ?? 0);
const progress = (s) => [s.research?.length ?? 0, s.deployed ? 1 : 0, equipment(s), s.totalEarned ?? 0];
function ahead(a, b) {
  const x = progress(a), y = progress(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** 同じゲームを 2 タブで開いたとき、古いタブの自動セーブが進んだ方を上書きしないようにする */
function persist() {
  if (resetting) return;
  const stored = load();
  if (stored && stored.savedAt !== knownSavedAt && ahead(stored, state)) {
    if (!saveBlocked) {
      guide("# 別のタブにもっと進んだセーブがあるので、上書きしないよう、ここでの保存を止めています。続きはそのタブで遊ぶか、このタブを再読み込みしてください。こちらが先に進めば保存を再開します", {
        cls: "warn", kind: "warn", kicker: "注意", short: "別のタブの方が進んでいるので、ここでは保存していません",
      });
    }
    saveBlocked = true;
    return;
  }
  if (saveBlocked) con.line("# このタブの方が進んだので、保存を再開しました", "note");
  saveBlocked = false;
  if (save(state)) knownSavedAt = load()?.savedAt ?? knownSavedAt;
  else if (!saveWarned) {
    saveWarned = true;
    guide("# ブラウザの保存領域が使えないか、いっぱいなのでセーブできません。リロードすると最初からになります", {
      cls: "warn", kind: "warn", kicker: "注意", short: "ブラウザに保存できません。リロードすると最初からになります",
    });
  }
}

/** HUD の「最初から」。セーブを消して読み込み直す（2 回押しの確認は HUD 側） */
function resetGame() {
  resetting = true;
  try { localStorage.removeItem(SAVE_KEY); } catch { /* 保存領域が使えないときは、読み込み直すだけで最初からになる */ }
  location.reload();
}

// ---------------------------------------------------------------- 起動

if (resumed) {
  const ago = state.savedAt ? new Date(state.savedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "";
  con.line(`# ${ago ? `${ago} の` : ""}セーブから再開しました。工場は Ruby の準備を待たずに動いています`, "note");
} else {
  guide("# 原石がベルトを流れています。鉱山をクリックして掘り、つるはしを買い足しましょう", {
    kicker: "はじめに", group: "onboarding", key: "start",
    short: `鉱山を${tapWord()}して稼ぎ、ショップでつるはしを買い足しましょう`,
  });
  con.line("# ruby.wasm で Ruby VM を組み立てています。準備ができるまで工場は素通しです", "dim");
}
refresh();
setInterval(logicTick, 100);
setInterval(persist, SAVE_INTERVAL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persist();
});
addEventListener("pagehide", persist);
// 別のタブで「最初から」を押した（セーブが消えた）ら、このタブも保存せずに読み込み直す。そうしないと次の自動セーブで古い進行が書き戻される
addEventListener("storage", (e) => {
  if ((e.key === SAVE_KEY || e.key === null) && e.newValue == null && !resetting) {
    resetting = true;
    location.reload();
  }
});
requestAnimationFrame(frame);

if (DEBUG) {
  window.__yf = {
    get state() { return state; },
    get runtime() { return runtime; },
    get vm() { return { ...vm }; },
    get flow() { return fi; },
    get callout() { return callout; },
    get recent() { return recent; },
    addMoney(n) { state.money += n; refresh(); },
    setTimeScale(k) { timeScale = Math.max(0, Number(k) || 1); },
    deploy(code, opts) {
      if (code != null) editor.set(code);
      return deploy(code ?? editor.value, opts);
    },
    // ---- SPEC-rubyist 4.9 ----
    get notebook() { return [...(state.notebook ?? [])]; },
    get backdoor() { return { ...state.backdoor }; },
    /** 直近の auditVerdict（caught・measuredPerOre・floorPerOre・worst・audit）と、直近のバッチの opsPerOre（置き換え後）・measuredOpsPerOre */
    get lastAudit() { return lastAudit; },
    /** 本番の定常バッチを受け取った回数 */
    get batches() { return batchCount; },
    get overtimeUntil() { return overtimeUntil; },
    /** 工場に渡している ViewModel（lanes・nightShift・overtimeUntil・audited の確認用）と、view の一回きりの判子 */
    get viewModel() { return viewModel(); },
    get stamps() { return (view.stamps ?? []).map((s) => s.text); },
    /** 設備 1 台あたりのいまの能力（夜間ライン込み） */
    unitRate(kind, key) { return eco.unitRate(state, kind, key); },
    buy(kind, key) { return kind === "research" ? buyResearch(key) : buyItem(kind, key); },
    batch() { requestBatch(); },
    save: persist,
    reset: resetGame,
  };
}
