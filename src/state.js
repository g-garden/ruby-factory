import { BACKDOOR, BELTS, CPUS, DOCKS, INITIAL_CODE, MINES, NOTEBOOK, PASSTHROUGH_VALUE, UNKNOWN_TECHNIQUE } from "../data/balance.js";

export const SAVE_KEY = "yield-factory/v1";
const VERSION = 1;

function counts(list) {
  return Object.fromEntries(list.map((x) => [x.key, x.initial ?? 0]));
}

export function initialState(now = Date.now()) {
  return {
    v: VERSION,
    money: 0,
    totalEarned: 0,
    record: 0,
    clicksPending: 0,
    clickRate: 0,
    mines: counts(MINES),
    belt: 0,
    cpus: counts(CPUS),
    docks: counts(DOCKS),
    research: [],
    deployed: false,
    code: INITIAL_CODE,
    lastGoodCode: null,
    /** ベンチを通ったコードの履歴（「前のコードに戻す」と例外が続いたときの戻り先）。新しいものが末尾 */
    codeHistory: [],
    ema: { valuePerOre: PASSTHROUGH_VALUE, opsPerOre: 0, cratesPerOre: 0 },
    lastCrates: [],
    stats: { deploys: 0, restarts: 0, shipped: 0, bestDeploy: null, startedAt: now, clearedAt: null, recordAtClear: null },
    achievements: [],
    /** 新しく始めたときは音を出さない（オフィスで開いても急に鳴らないように）。HUD の「音」で切り替える */
    muted: true,
    savedAt: null,
    // ---- 裏口ノート・監査（SPEC-rubyist 4.8） ----
    /** 見つけた裏口ノートのページの key（見つけた順） */
    notebook: [],
    /** ページを見つけたときの Ruby の機能名（当てた技など）。{ [key]: string }。無いページは NOTEBOOK の feature を出す */
    notebookFeatures: {},
    /** 直近の本番の報告を丸めたもの（economy.clampBackdoor）。リロード直後の容量に使う */
    backdoor: { lanes: 1, night: false, overtime: 0 },
    /** 監査報告を出した回数（成績表） */
    audits: 0,
    /** 終盤のナッジ（SPEC-rubyist 2.5）を出したか。リロードしても出直さない */
    nudged: false,
  };
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function save(state, storage = defaultStorage()) {
  if (!storage) return false;
  try {
    const data = { ...state, savedAt: Date.now() };
    storage.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const num = (x, d) => (typeof x === "number" && Number.isFinite(x) ? x : d);
/** 0 以上の有限の数。それ以外は d */
const nonNeg = (x, d) => (num(x, -1) >= 0 ? x : d);
/** 回数や個数。数字だけの文字列も数として読む（"3" は 3）。空文字・true・配列などは d */
const count = (x, d) => {
  const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
  return nonNeg(n, d);
};

/** 保存データを初期状態に重ねる。欠けた項目や壊れた値は初期値のまま */
export function load(storage = defaultStorage()) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(data) || data.v !== VERSION) return null;

  const s = initialState(num(data.stats?.startedAt, Date.now()));
  for (const k of ["money", "totalEarned", "record"]) s[k] = num(data[k], s[k]);
  // ベルトは BELTS の添字。範囲の外や小数だと capacities が BELTS[n].cap を読めずに落ちる
  s.belt = Math.min(BELTS.length - 1, Math.max(0, Math.floor(num(data.belt, 0))));
  // 台数は整数で、初期値（つるはしは最初の 1 本）より減らさない。負の台数だと収入が負になる
  for (const field of ["mines", "cpus", "docks"]) {
    if (!isObj(data[field])) continue;
    for (const key of Object.keys(s[field])) s[field][key] = Math.max(s[field][key], Math.floor(num(data[field][key], s[field][key])));
  }
  if (Array.isArray(data.research)) s.research = data.research.filter((x) => typeof x === "string");
  s.deployed = data.deployed === true;
  if (typeof data.code === "string") s.code = data.code;
  if (typeof data.lastGoodCode === "string") s.lastGoodCode = data.lastGoodCode;
  if (Array.isArray(data.codeHistory)) s.codeHistory = data.codeHistory.filter((x) => typeof x === "string").slice(-10);
  if (isObj(data.ema)) {
    s.ema = {
      valuePerOre: nonNeg(data.ema.valuePerOre, s.ema.valuePerOre),
      opsPerOre: nonNeg(data.ema.opsPerOre, s.ema.opsPerOre),
      cratesPerOre: nonNeg(data.ema.cratesPerOre, s.ema.cratesPerOre),
    };
    if (num(data.ema.shippedPerOre, null) != null) s.ema.shippedPerOre = data.ema.shippedPerOre;
  }
  // 箱の表示（crateFeed）と研究の効き目の判定が cells と bonuses の中身を読むので、形の合う箱だけ残す
  if (Array.isArray(data.lastCrates)) {
    s.lastCrates = data.lastCrates
      .slice(0, 64)
      .filter((c) => isObj(c) && Array.isArray(c.cells) && c.cells.every(isObj) && Array.isArray(c.bonuses) && c.bonuses.every(isObj));
  }
  if (isObj(data.stats)) loadStats(s.stats, data.stats);
  // 実績の key は名前を変えたものがある（perfect_crime → unknown_technique、night_shift → night_line）。古いセーブは読み替える
  if (Array.isArray(data.achievements)) s.achievements = data.achievements.filter((x) => typeof x === "string").map((x) => RENAMED_ACHIEVEMENTS[x] ?? x);
  // いまのセーブは音の設定をそのまま引き継ぐ
  if (typeof data.muted === "boolean") s.muted = data.muted;
  s.savedAt = num(data.savedAt, null);
  if (typeof data.ema?.floorPerOre === "number" && Number.isFinite(data.ema.floorPerOre)) s.ema.floorPerOre = data.ema.floorPerOre;
  loadRubyist(s, data);
  return s;
}

/**
 * 成績表の項目を 1 つずつ丸めて読む。startedAt は initialState に渡した確認済みの値のまま。
 * 型の違う値をそのまま入れると、restarts の文字列連結やクリアタイムの NaN、エンディングの例外になる
 */
function loadStats(stats, raw) {
  stats.deploys = Math.floor(count(raw.deploys, 0));
  stats.restarts = Math.floor(count(raw.restarts, 0));
  stats.shipped = count(raw.shipped, 0);
  stats.clearedAt = num(raw.clearedAt, null);
  // クリアした時点の最高単価。成績表と X の投稿で使う。古いセーブには無いので、そのときはいまの記録を出す
  const rc = num(raw.recordAtClear, null);
  stats.recordAtClear = stats.clearedAt != null && rc != null && rc >= 0 ? rc : null;
  const b = raw.bestDeploy;
  if (isObj(b) && typeof b.before === "string" && typeof b.after === "string" && num(b.ratio, null) != null) {
    stats.bestDeploy = { before: b.before, after: b.after, ratio: b.ratio };
  }
}

const NOTEBOOK_KEYS = new Set(NOTEBOOK.map((p) => p.key));
/** 技を当てられなかったときの、前の版の機能名。古いセーブだけに残っている */
const OLD_UNKNOWN_TECHNIQUE = "不明（監査が負けました）";
const RENAMED_ACHIEVEMENTS = { perfect_crime: "unknown_technique", night_shift: "night_line" };

/** 追補の項目（古いセーブには無いので初期値のまま）。値は読み込み時にも丸める */
function loadRubyist(s, data) {
  if (Array.isArray(data.notebook)) s.notebook = [...new Set(data.notebook.filter((k) => NOTEBOOK_KEYS.has(k)))];
  if (isObj(data.notebookFeatures)) {
    for (const [k, v] of Object.entries(data.notebookFeatures)) {
      // 技を当てられなかったときの古い文言は、いまの「正体不明」に読み替える
      if (NOTEBOOK_KEYS.has(k) && typeof v === "string" && v.length > 0) s.notebookFeatures[k] = v === OLD_UNKNOWN_TECHNIQUE ? UNKNOWN_TECHNIQUE : v.slice(0, 60);
    }
  }
  if (isObj(data.backdoor)) {
    const lanes = Math.floor(num(data.backdoor.lanes, 1));
    s.backdoor = {
      lanes: Math.min(BACKDOOR.lanesMax, Math.max(1, lanes)),
      night: data.backdoor.night === true,
      overtime: Math.max(0, Math.floor(num(data.backdoor.overtime, 0))),
    };
  }
  s.audits = Math.max(0, Math.floor(num(data.audits, 0)));
  s.nudged = data.nudged === true;
}
