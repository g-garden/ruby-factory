#!/usr/bin/env node
// ヘッドレス経済シミュレーション（SPEC 11.3）。data/balance.js と src/economy.js をそのまま回す。
//
//   node tools/econ.mjs                        既定（3 秒目からクリック 1/秒を 30 秒、VM 8 秒）
//   node tools/econ.mjs --vm 3 --click 0       VM 3 秒・クリックなし
//   node tools/econ.mjs --price release=1e14   研究価格を上書き（balance.js は変えない）
//   node tools/econ.mjs --scenarios            VM 3/8/25/60 秒・クリックなしの要約
//   node tools/econ.mjs --trace                1 秒ごとの状態を出す
//   node tools/econ.mjs --buy-cap 5            1 秒に買う設備の上限（既定 500）
//   node tools/econ.mjs --policy both          ボット方針と人間らしい方針の両方で、研究の間隔・単価記録の関門・sort { }・待つだけの区間を出す
//        --policy human / bot                  片方だけ
//        --set CPUS.server.base=7500,BELTS.8.cap=Infinity   表を上書き（balance.js は変えない。添字が表の長さちょうどなら行を足す）
//        --human-buy 3                         人間が 1 秒に買う設備の上限（既定 3）
//        --human-pick perDollar|biggest       人間が赤い工程で選ぶ設備: 買える中で 1 ドルあたり最大（既定）か、容量が最大
//        --human-save 30                       研究が収入の 30 秒分以内なら人間も設備を買わずに待つ（既定 0 = 貯めない）
//        --sort-secs 30                        整列のあと sort { } を動かす秒数（既定 30。大きくするとお金だけで直す時間を測れる）
//        --write-scale 0                       コードを書く時間の倍率（既定 1）。0 で書く時間なし。
//                                              --policy human --write-scale 0 --click 2,40 --human-buy 4 が通しプレイ（dev/playthrough.mjs）に近い
//        --backdoor lanes,night,audit          裏口を最初から使う（SPEC-rubyist 3.4）。lanes = 2 車線（無限ベルトだけ ×2）、
//                                              night = 合鍵（惑星コア・軌道エレベータ ×1.5。BACKDOOR.nightMul）、audit = 監査ラインまでのすり抜けを
//                                              「CPU ×2 相当」で（追補 3.4 の表と同じ大きめの見積もり）、auditfloor = すり抜けを
//                                              src/audit.js の監査ラインそのもの（コードごとに移植版の箱から計算）で
import { fileURLToPath } from "node:url";
import { BELTS, CPUS, DOCKS, MINES, RESEARCH } from "../data/balance.js";
import { auditFloor } from "../src/audit.js";
import { buy, canDeploy, canResearch, clickMine, derive, flowInfo, formatMoney, formatNumber, priceOf, tick, unitRate } from "../src/economy.js";
import { priceBatch } from "../src/price.js";
import { makeBelt } from "../src/rng.js";
import { initialState } from "../src/state.js";

// ---- SPEC 6.2 の pack を JS に移したもの（箱割りだけ。鑑定回数は数えない） ----

function groupBy(arr, f) {
  const m = new Map();
  for (const x of arr) {
    const k = f(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function eachSlice(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const sortByCarat = (arr) => [...arr].sort((a, b) => a.carat - b.carat);

function chunkWhile(arr, f) {
  const out = [];
  for (const x of arr) {
    const last = out[out.length - 1];
    if (last && f(last[last.length - 1], x)) last.push(x);
    else out.push([x]);
  }
  return out;
}

function straightsChunk(ores, box) {
  const pool = groupBy(ores, (o) => o.carat);
  const out = [];
  for (;;) {
    const run = [];
    for (let k = 1; k <= 9; k++) {
      const p = pool.get(k);
      if (p && p.length) run.push(p.pop());
    }
    if (run.length === 0) break;
    for (const c of chunkWhile(run, (a, b) => b.carat === a.carat + 1)) out.push(...eachSlice(c, box));
  }
  return out;
}

function straightsCons(ores, box) {
  const pool = groupBy(ores, (o) => o.carat);
  const out = [];
  for (let start = 1; start + box - 1 <= 9; start++) {
    const run = Array.from({ length: box }, (_, i) => start + i);
    const n = Math.min(...run.map((k) => pool.get(k)?.length ?? 0));
    for (let i = 0; i < n; i++) out.push(run.map((k) => pool.get(k).pop()));
  }
  return out;
}

const byColorThen = (ores, f, box) => [...groupBy(ores, (o) => o.color).values()].flatMap((g) => f(g, box));

// 長さ 3〜box の窓（1..9 の each_cons）。クリスマス便の手本と同じく、箱の値段の目安が高い順に並べる
const SPANS = new Map();
function windowsByWorth(box) {
  if (!SPANS.has(box)) {
    const runs = [];
    for (let n = 3; n <= box; n++) for (let s = 1; s + n - 1 <= 9; s++) runs.push(Array.from({ length: n }, (_, i) => s + i));
    const worth = (r) => {
      const sum = r.reduce((a, b) => a + b, 0);
      return sum * r.length * 2 ** (r.length - 1) * (sum === 25 ? 4 : 1);
    };
    SPANS.set(box, runs.map((r, i) => [r, worth(r), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([r]) => r));
  }
  return SPANS.get(box);
}

// SAMPLE_CODE.christmas の straights。窓を値段順に取り、そろう分だけ箱にする
function straightsByWorth(ores, box) {
  const pool = groupBy(ores, (o) => o.carat);
  const out = [];
  for (const run of windowsByWorth(box)) {
    const n = Math.min(...run.map((k) => pool.get(k)?.length ?? 0));
    for (let i = 0; i < n; i++) out.push(run.map((k) => pool.get(k).pop()));
  }
  return out;
}

// SAMPLE_CODE.polishHoles。傷のない原石で窓を埋め、箱いっぱいの窓だけ、足りない carat は傷物を磨いて埋める。余りは出さない
function packHoles(belt, box) {
  const groups = [...groupBy(belt, (o) => o.color).values()].map((ores) => [
    groupBy(ores.filter((o) => !o.flaw), (o) => o.carat),
    groupBy(ores.filter((o) => o.flaw), (o) => o.carat),
  ]);
  const crates = [];
  const polished = [];
  for (const [pool, spare] of groups) {
    for (const run of windowsByWorth(box)) {
      while (run.every((k) => pool.get(k)?.length || (run.length === box && spare.get(k)?.length))) {
        crates.push(run.map((k) => {
          if (pool.get(k)?.length) return pool.get(k).pop();
          const o = spare.get(k).pop();
          polished.push(o.id);
          return o;
        }));
      }
    }
  }
  return { crates, polished };
}

// SAMPLE_CODE.straightAll。chunk_while 版のストレートのあとに、傷物も色ごとに carat の順で詰めて出す
function packStraightAll(belt, box) {
  const good = belt.filter((o) => !o.flaw);
  const bad = belt.filter((o) => o.flaw);
  return {
    crates: [...byColorThen(good, straightsChunk, box), ...byColorThen(bad, (g) => eachSlice(sortByCarat(g), box), box)],
    polished: [],
  };
}

/** (belt, box) → { crates: Ore[][], polished: id[] } */
export const PACKERS = {
  initial: (belt) => ({ crates: belt.map((o) => [o]), polished: [] }),
  eachSlice: (belt, box) => ({ crates: eachSlice(belt, box), polished: [] }),
  reject: (belt, box) => ({ crates: eachSlice(belt.filter((o) => !o.flaw), box), polished: [] }),
  sortBy: (belt, box) => ({ crates: eachSlice(sortByCarat(belt.filter((o) => !o.flaw)), box), polished: [] }),
  sortBlock: (belt, box) => ({ crates: eachSlice(sortByCarat(belt.filter((o) => !o.flaw)), box), polished: [] }),
  groupBy: (belt, box) => ({
    crates: byColorThen(belt.filter((o) => !o.flaw), (g) => eachSlice(sortByCarat(g), box), box),
    polished: [],
  }),
  straightChunk: (belt, box) => ({ crates: byColorThen(belt.filter((o) => !o.flaw), straightsChunk, box), polished: [] }),
  straightCons: (belt, box) => ({ crates: byColorThen(belt.filter((o) => !o.flaw), straightsCons, box), polished: [] }),
  polishChunk: (belt, box) => ({ crates: byColorThen(belt, straightsChunk, box), polished: belt.filter((o) => o.flaw).map((o) => o.id) }),
  polishCons: (belt, box) => ({ crates: byColorThen(belt, straightsCons, box), polished: belt.filter((o) => o.flaw).map((o) => o.id) }),
  straightAll: packStraightAll,
  christmas: (belt, box) => ({ crates: byColorThen(belt.filter((o) => !o.flaw), straightsByWorth, box), polished: [] }),
  polishHoles: packHoles,
};

/** packer の結果を runtime.batch() と同じ形にする */
export function toRubyResult({ crates, polished }, ops = 0) {
  return { ok: true, ops, polished, crates: crates.map((c) => c.map((o) => o.id)), log: "" };
}

// ---- SPEC 5.9 の表（単価・鑑定は表の値を使う。箱数/鉱石は上の移植で測る） ----
// クリスマス便・研磨機の段の単価と鑑定は ruby.wasm の実測（箱 5 は 50 シード、ほかはシード 1〜3 か 1〜5）。
// 研磨ありのコードの鑑定は研磨機の発熱（n 回目の研磨は鑑定 n 回）を入れた値。
// 傷物を全部磨く polishChunk は 1 + 2 + … + 123 前後で 19.8 回/鉱石。polishHoles は箱いっぱいの窓だけ磨くので、箱が大きいほど磨く数が減る
const POLISH_OPS = { polishCons: 17.98, polishChunk: 19.82 };
const HOLES_OPS = { 5: 4.7, 7: 4.21, 9: 3.8 };

const RB = ["red", "blue"];
const RBG = ["red", "blue", "green"];
const B3 = ["flawless", "ascending"];
const ALL = ["flawless", "mono", "ascending", "straight"];
const ALLX = [...ALL, "christmas"];

export const CODES = [
  { key: "s1", text: "initial", box: 1, colors: ["red"], bonuses: [], value: 5.0, ops: 0 },
  { key: "s2", text: "eachSlice", box: 3, colors: ["red"], bonuses: [], value: 15.0, ops: 0 },
  { key: "s3", text: "reject", box: 3, colors: ["red"], bonuses: ["flawless"], value: 33.3, ops: 1.0 },
  { key: "s4", text: "sortBy", box: 3, colors: ["red"], bonuses: B3, value: 66.4, ops: 1.74 },
  { key: "s4b", text: "sortBy", box: 3, colors: RB, bonuses: B3, value: 99.6, ops: 1.74 },
  { key: "s6", text: "groupBy", box: 3, colors: RB, bonuses: ["flawless", "mono", "ascending"], value: 298.4, ops: 2.49 },
  { key: "s7", text: "groupBy", box: 5, colors: RB, bonuses: ["flawless", "mono", "ascending"], value: 495.4, ops: 2.49 },
  { key: "st_cons", text: "straightCons", box: 5, colors: RB, bonuses: ALL, value: 3032, ops: 2.49 },
  { key: "st_chunk", text: "straightChunk", box: 5, colors: RB, bonuses: ALL, value: 4086, ops: 3.76 },
  { key: "st_all", text: "straightAll", box: 5, colors: RB, bonuses: ALL, value: 4142, ops: 4.27 },
  // クリスマス便。ストレートのコードのままだと偶然の合計 25 の分だけ上がる。窓を値段順に取ると 3 倍を超える
  { key: "xm_chunk", text: "straightChunk", box: 5, colors: RB, bonuses: ALLX, value: 4388, ops: 3.76 },
  { key: "xm_all", text: "straightAll", box: 5, colors: RB, bonuses: ALLX, value: 4453, ops: 4.27 },
  { key: "xm_win", text: "christmas", box: 5, colors: RB, bonuses: ALLX, value: 14238, ops: 2.52 },
  // 研磨機。全部磨くと発熱で鑑定が 19.8 回になり、研磨なしの窓より安い。箱いっぱいの窓の穴だけ磨くと 1.4 倍
  { key: "po_chunk", text: "polishChunk", box: 5, colors: RB, bonuses: ALLX, polish: true, value: 5321, ops: POLISH_OPS.polishChunk },
  { key: "po_holes", text: "polishHoles", box: 5, colors: RB, bonuses: ALLX, polish: true, value: 20161, ops: 4.8 },
  { key: "em_win", text: "christmas", box: 5, colors: RBG, bonuses: ALLX, value: 21669, ops: 2.52 },
  { key: "em_holes", text: "polishHoles", box: 5, colors: RBG, bonuses: ALLX, polish: true, value: 30133, ops: 4.62 },
  // 箱 7・9 は書き換えずに越える。窓の手本は 7 連・9 連の窓が先に取られて合計 25 の箱がほぼなくなる（箱 7 の単価は移植版の 20 シード）
  { key: "b7_win", text: "christmas", box: 7, colors: RBG, bonuses: ALLX, value: 46852, ops: 2.52 },
  { key: "b7_holes", text: "polishHoles", box: 7, colors: RBG, bonuses: ALLX, polish: true, value: 66322, ops: 4.21 },
  { key: "b9_win", text: "christmas", box: 9, colors: RBG, bonuses: ALLX, value: 219249, ops: 2.52 },
  { key: "b9_holes", text: "polishHoles", box: 9, colors: RBG, bonuses: ALLX, polish: true, value: 329670, ops: 3.8 },
];

// 人間らしい方針のコードの鑑定回数/鉱石（5.9 の表。sort { } は SPEC 0 章の wasm の値）。
// 人間は研究のあともコードを書き換えるまで前のコードを動かし続けるので、単価と箱数は
// 「そのコード × いまの研究」を移植版の pack と priceBatch でその場で測る（codeStats）
const HUMAN_OPS = {
  initial: 0, eachSlice: 0, reject: 1.0, sortBlock: 6.92, sortBy: 1.74, groupBy: 2.49,
  straightCons: 2.49, straightChunk: 3.76, straightAll: 4.27, christmas: 2.52, ...POLISH_OPS,
};
const humanOps = (text, d) => (text === "polishHoles" ? (HOLES_OPS[d.box] ?? HOLES_OPS[5]) : HUMAN_OPS[text]);
const statsCache = new Map();
export function codeStats(text, d, seeds = [1, 2, 3, 4, 5]) {
  const bonuses = [...d.bonuses].sort();
  const k = `${text}|${d.box}|${d.colors.join("+")}|${bonuses.join("+")}|${d.polish}`;
  if (!statsCache.has(k)) {
    let cpo = 0;
    let vpo = 0;
    let fpo = 0;
    for (const seed of seeds) {
      const belt = makeBelt(seed, { colors: d.colors });
      const res = toRubyResult(PACKERS[text](belt, d.box));
      const p = priceBatch(belt, res, { box: d.box, bonuses, polish: !!d.polish });
      cpo += p.cratesPerOre;
      vpo += p.valuePerOre;
      fpo += auditFloor(p, res.polished, { colors: d.colors, box: d.box }).floorPerOre;
    }
    statsCache.set(k, { key: text, text, value: vpo / seeds.length, cratesPerOre: cpo / seeds.length, ops: humanOps(text, d), floor: fpo / seeds.length });
  }
  return statsCache.get(k);
}

// 研究 → そのとき書くコードと書く時間（秒）。writeScale を掛ける（0 なら通しプレイのボットのように書く時間なし）
const WRITES = {
  crate: { texts: ["eachSlice"], delay: 20 },
  inspector: { texts: ["reject"], delay: 30 },
  sorter: { texts: ["sortBy"], delay: 40 },
  monochrome: { texts: ["groupBy"], delay: 60 },
  straight: { texts: ["straightCons", "straightChunk", "straightAll"], delay: 120 },
  christmas: { texts: ["christmas"], delay: 60 },
  polish: { texts: ["polishChunk", "polishHoles"], delay: 60 },
};

// 人間らしい方針: 研究ごとに書くコード。ヒントの solution どおりに書き、
// 整列のあとは sort { } を書いて sortBlockSecs 秒動かしてから sort_by に直す
const HUMAN_WRITES = {
  crate: [["eachSlice", 20]],
  inspector: [["reject", 30]],
  sorter: [["sortBlock", 40]], // sort_by は sortBlock を出してから sortBlockSecs 秒後
  monochrome: [["groupBy", 60]],
  straight: [["straightAll", 120]],
  christmas: [["christmas", 60]],
  polish: [["polishHoles", 60]],
};

/** 各コードを移植版で 5 シード回し、箱数/鉱石と（表と比べる用の）単価を測る */
export function measureCodes(seeds = [1, 2, 3, 4, 5]) {
  const out = new Map();
  for (const c of CODES) {
    let cpo = 0;
    let vpo = 0;
    let fpo = 0;
    for (const seed of seeds) {
      const belt = makeBelt(seed, { colors: c.colors });
      const res = toRubyResult(PACKERS[c.text](belt, c.box));
      const p = priceBatch(belt, res, { box: c.box, bonuses: c.bonuses, polish: !!c.polish });
      cpo += p.cratesPerOre;
      vpo += p.valuePerOre;
      fpo += auditFloor(p, res.polished, { colors: c.colors, box: c.box }).floorPerOre;
    }
    out.set(c.key, { cratesPerOre: cpo / seeds.length, measuredValue: vpo / seeds.length, floorPerOre: fpo / seeds.length });
  }
  return out;
}

// ---- ボット ----

const sameSet = (a, b) => a.length === b.size && a.every((x) => b.has(x));

export function fmtTime(t) {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

// budget を渡すと、その額で買えるものの中から選ぶ（人間らしい方針: 貯めずに、いま買えるものを買う）。
// biggest なら 1 ドルあたりではなく、買える中で一番容量の増える設備（クリック数に限りがある人間の選び方）
function bestPurchase(st, stage, budget = Infinity, biggest = false) {
  if (stage === "belt") {
    const tier = (st.belt ?? 0) + 1;
    return tier < BELTS.length ? { kind: "belt", key: tier, cost: BELTS[tier].price } : null;
  }
  const kind = stage === "refinery" ? "cpu" : stage;
  const list = kind === "mine" ? MINES : kind === "cpu" ? CPUS : DOCKS;
  let best = null;
  for (const item of list) {
    const cost = priceOf(st, kind, item.key);
    if (cost > budget) continue;
    const rate = unitRate(st, kind, item.key); // 夜間ライン（合鍵）なら惑星コア・軌道エレベータは ×1.5（BACKDOOR.nightMul）
    const perDollar = rate / cost;
    const better = biggest ? !best || rate > best.rate : !best || perDollar > best.perDollar;
    if (better) best = { kind, key: item.key, cost, perDollar, rate };
  }
  return best;
}

const MARKS = [30, 60, 120, 180, 300, 480, 600, 900, 1200, 1500, 1800, 2400, 3000, 3600];

// ---- 表の上書き（balance.js は変えず、メモリ上の表だけ書き換えて元に戻す） ----

const TABLES = { MINES, BELTS, CPUS, DOCKS, RESEARCH };

/**
 * "TABLE.key.field=value" の配列を当てる。key は設備・研究の key か添字。
 * 添字が表の長さちょうどなら行を足す（例: BELTS.9.cap=2e7 と BELTS.9.price=1e13 で 10 段目のベルト）。
 * 戻り値の関数で元に戻す。
 */
export function applySets(sets = []) {
  // economy.js は研究の行を key で引く Map を持っているので、行のオブジェクトは差し替えずに中身を戻す
  const saved = Object.fromEntries(Object.entries(TABLES).map(([k, t]) => [k, t.map((row) => [row, { ...row }])]));
  for (const s of sets) {
    const m = /^(\w+)\.([\w+]+)\.(\w+)=(.+)$/.exec(s);
    if (!m || !TABLES[m[1]]) throw new Error(`--set の形が違います: ${s}（例: CPUS.server.base=6000）`);
    const [, tname, key, field, raw] = m;
    const table = TABLES[tname];
    let row = /^\d+$/.test(key) ? table[Number(key)] : table.find((x) => x.key === key);
    if (!row) {
      if (/^\d+$/.test(key) && Number(key) === table.length) row = { label: `追加${key}`, color: "#ffffff" };
      else if (!/^\d+$/.test(key) && tname !== "RESEARCH" && tname !== "BELTS") row = { key, label: key };
      else throw new Error(`--set: ${tname} に ${key} がありません`);
      table.push(row);
    }
    row[field] = Number(raw);
  }
  return () => {
    for (const [k, rows] of Object.entries(saved)) {
      const t = TABLES[k];
      t.length = rows.length;
      rows.forEach(([row, copy], i) => {
        for (const f of Object.keys(row)) if (!(f in copy)) delete row[f];
        Object.assign(row, copy);
        t[i] = row;
      });
    }
  };
}

/** 工場の流入（上流の最小）まで CPU を足すのに要る最小に近い額（1 ドルあたりの鑑定が大きい順に貪欲に買う） */
function refineryFixCost(st) {
  return refineryFix(st).cost;
}

/** refineryFixCost と同じ買い方で工場を直したときの額と、直したあとの収入/秒 */
function refineryFix(st) {
  const s2 = { ...st, cpus: { ...st.cpus }, research: [...st.research], ema: { ...st.ema }, money: Infinity };
  let cost = 0;
  for (let n = 0; n < 2000; n++) {
    const fi = flowInfo(s2);
    if (fi.bottleneck !== "refinery") return { cost, income: fi.incomePerSec };
    const opt = bestPurchase(s2, "refinery");
    cost += opt.cost;
    buy(s2, opt.kind, opt.key);
  }
  return { cost: Infinity, income: 0 };
}

// ボットがコードを選ぶとき、工場が赤くなるコードでも、手持ちと収入のこの秒数分で CPU を買い足せるなら、買い足したあとの収入で比べる
const FIX_LOOKAHEAD_SECS = 30;

/** --backdoor の監査すり抜けを「CPU ×2 相当」で入れる上書き（設計時の試作と同じ見積もり） */
export const AUDIT_CPU2_SETS = CPUS.map((c) => `CPUS.${c.key}.rate=${c.rate * 2}`);

export function simulate({
  vm = 8, clickRate = 1, clickSecs = 30, clickStart = 3, buyCap = 500, prices = {}, sets = [], maxSecs = 7200, trace = false,
  policy = "bot", humanBuyCap = 3, humanPick = "perDollar", humanSaveSecs = 0, sortBlockSecs = 30, measured = null,
  backdoor = [], writeScale = 1,
} = {}) {
  const bd = new Set(backdoor);
  const restore = applySets([...sets, ...(bd.has("audit") ? AUDIT_CPU2_SETS : [])]);
  if (!measured) measured = measureCodes();
  const human = policy === "human";
  const savedPrices = RESEARCH.map((r) => r.price);
  for (const r of RESEARCH) if (prices[r.key] != null) r.price = prices[r.key];
  try {
    const st = initialState(0);
    // 裏口は最初から開けた扱い（2 車線は無限ベルトになるまで、夜間ラインは惑星コア・軌道エレベータを買うまで効かない）
    st.backdoor = { lanes: bd.has("lanes") ? 2 : 1, night: bd.has("night"), overtime: 0 };
    const written = new Map([["initial", 0]]); // コード → 書き終わる時刻
    let code = null;
    const events = [];
    const switches = [];
    const buys = []; // 何かを買った時刻（設備・ベルト・研究）
    const waits = []; // 貯めてもいないのに何も買えなかった時刻（研究のお金待ち・ベルト上限など「待つだけ」）
    const gates = []; // 研究ごとの待ち: 次の研究になった時刻・単価記録が届いた時刻・買った時刻
    let gate = null;
    let writeEnd = 0; // 人間がいま書いているコードを書き終わる時刻
    let lastIncome = 0;
    let lastBn = null;
    let deployAt = null;
    let releaseAt = null;
    const marks = {};
    const sortInfo = { start: null, redSecs: 0, end: null, fixCost: null, incomeAtStart: null, sortByRedAtSwitch: null, sortByFlowRatio: null };

    const setCode = (c) => {
      code = c;
      // auditfloor: 鑑定を全部すり抜けて、監査ライン（移植版の箱から計算）まで戻された値で回す
      const ops = bd.has("auditfloor") ? (c.floor ?? measured.get(c.key)?.floorPerOre ?? c.ops) : c.ops;
      st.ema = { valuePerOre: c.value, opsPerOre: ops, cratesPerOre: c.cratesPerOre ?? measured.get(c.key).cratesPerOre };
    };
    const applicable = (t) => {
      const d = derive(st);
      return CODES.filter(
        (c) =>
          (written.get(c.text) ?? Infinity) <= t &&
          c.box === d.box &&
          c.colors.length === d.colors.length &&
          sameSet(c.bonuses, new Set(d.bonuses)) &&
          (!c.polish || d.polish),
      );
    };
    const chooseCode = (t) => {
      const d = derive(st);
      if (human) {
        // 人間は書き終えたコードのうち単価の高いものを使い続ける。ほぼ同じ単価なら後から書いた方（sort { } → sort_by）
        let best = null;
        for (const [text, at] of written) {
          if (at > t) continue;
          const c = codeStats(text, d);
          if (!best || c.value > best.value * 1.001 || (c.value >= best.value * 0.999 && at > written.get(best.text))) best = c;
        }
        setCode(best);
        return;
      }
      const rows = applicable(t);
      if (rows.length === 0) return; // 新しいコードを書いている間は前のコードのまま
      const gated = d.nextResearch?.requires?.record != null && st.record < d.nextResearch.requires.record;
      let best = null;
      let bestScore = -1;
      for (const c of rows) {
        setCode(c);
        let score = gated ? c.value : flowInfo(st).incomePerSec;
        if (!gated && flowInfo(st).bottleneck === "refinery") {
          const fix = refineryFix(st);
          if (fix.cost <= st.money + score * FIX_LOOKAHEAD_SECS) score = Math.max(score, fix.income);
        }
        if (score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
      setCode(best);
    };

    for (let t = 0; t < maxSecs; t++) {
      // SPEC 3.1: 「クリックで掘る」の吹き出しが出る 3 秒目からクリックし始める
      if (t >= clickStart && t < clickStart + clickSecs) for (let i = 0; i < clickRate; i++) clickMine(st);

      if (!st.deployed && canDeploy(st, t >= vm).ok) {
        st.deployed = true;
        deployAt = t;
        events.push({ t, label: "初回デプロイ", key: "deploy" });
      }
      const prevCode = code;
      if (st.deployed) chooseCode(t);
      if (human && code !== prevCode) {
        if (code?.text === "sortBlock" && sortInfo.start == null) {
          sortInfo.start = t;
          const f0 = flowInfo(st);
          sortInfo.incomeAtStart = f0.incomePerSec;
          sortInfo.fixCost = refineryFixCost(st);
          sortInfo.refAtStart = f0.caps.refinery;
          sortInfo.inflowAtStart = f0.inflow;
          // その瞬間に sort_by だったら: 同じ設備で鑑定だけ 1.74 にしたときの工場 / 上流
          const sb = { ...st, ema: { ...st.ema, opsPerOre: HUMAN_OPS.sortBy } };
          const fb = flowInfo(sb);
          sortInfo.sortByRedAtStart = fb.bottleneck === "refinery";
          sortInfo.sortByRatioAtStart = fb.caps.refinery / Math.min(fb.caps.mine, fb.caps.belt);
          sortInfo.incomeBefore = lastIncome;
        }
        if (prevCode?.text === "sortBlock" && code?.text !== "sortBlock") {
          sortInfo.end = t;
          const f1 = flowInfo(st);
          sortInfo.sortByRedAtSwitch = f1.bottleneck === "refinery";
          sortInfo.sortByFlowRatio = f1.caps.refinery / Math.min(f1.caps.mine, f1.caps.belt);
        }
      }

      const { flowInfo: fi } = tick(st, 1);
      lastIncome = fi.incomePerSec;
      if (st.deployed && code) st.record = Math.max(st.record, code.value);
      if (code?.text === "sortBlock") {
        if (fi.bottleneck === "refinery") sortInfo.redSecs++;
        else if (sortInfo.clearAt == null) sortInfo.clearAt = t;
      }
      if (fi.bottleneck !== lastBn) {
        if (st.deployed) switches.push({ t, to: fi.bottleneck });
        lastBn = fi.bottleneck;
      }
      if (MARKS.includes(t)) marks[t] = { income: fi.incomePerSec, bn: fi.bottleneck, code: code?.key ?? "pass" };
      if (trace) {
        console.log(
          `${fmtTime(t)} ${formatMoney(st.money).padStart(9)} +${formatNumber(fi.incomePerSec)}/s bn=${fi.bottleneck} code=${code?.key ?? "pass"} ` +
            `mine=${formatNumber(fi.caps.mine)} belt=${formatNumber(fi.caps.belt)} ref=${formatNumber(fi.caps.refinery)} dock=${formatNumber(fi.caps.dock)}`,
        );
      }

      const next = derive(st).nextResearch;
      if (next && st.deployed) {
        if (!gate || gate.key !== next.key) gate = { key: next.key, label: next.label, since: t, incomeSince: fi.incomePerSec, recordAt: null, moneyAt: null };
        const needRec = next.requires?.record;
        if (gate.recordAt == null && (needRec == null || st.record >= needRec)) gate.recordAt = t;
        if (gate.moneyAt == null && st.money >= next.price) gate.moneyAt = t;
      }

      // 研究はお金が貯まり次第。ボットは研究価格が収入 60 秒ぶん以下なら他を買わずに貯める。人間は貯めない
      let saving = false;
      if (next && st.deployed) {
        const chk = canResearch(st, next.key);
        if (chk.ok) {
          buy(st, "research", next.key);
          buys.push(t);
          gates.push({ ...gate, boughtAt: t, incomeAt: fi.incomePerSec });
          events.push({ t, label: next.label, key: next.key, price: next.price, income: fi.incomePerSec, bn: fi.bottleneck, code: code?.key });
          if (human) {
            // 人間は 1 本ずつ書く。前のコードを書いている間に研究を買ったら、書き終わってから次に取りかかる
            for (const [text, delay] of HUMAN_WRITES[next.key] ?? []) {
              if (written.has(text)) continue;
              writeEnd = Math.max(t, writeEnd) + delay * writeScale;
              written.set(text, writeEnd);
              if (text === "sortBlock") {
                writeEnd += sortBlockSecs;
                written.set("sortBy", writeEnd);
              }
            }
          } else {
            const w = WRITES[next.key];
            if (w) for (const text of w.texts) if (!written.has(text)) written.set(text, t + w.delay * writeScale);
          }
          if (next.effect.ending) {
            releaseAt = t;
            break;
          }
          continue;
        }
        // humanSaveSecs > 0 は「研究が収入の N 秒分以内なら設備を買わずに待つ」人間（既定 0 = 貯めない）
        const saveSecs = human ? humanSaveSecs : 60;
        saving = saveSecs > 0 && chk.missing === "money" && next.price <= fi.incomePerSec * saveSecs;
      }
      if (saving) continue;

      // それ以外は、ボトルネックの工程で 1 ドルあたりの容量増が最大の設備を買う
      const cap = human ? humanBuyCap : buyCap;
      let bought = false;
      for (let n = 0; n < cap; n++) {
        const opt = bestPurchase(st, flowInfo(st).bottleneck, human ? st.money : Infinity, human && humanPick === "biggest");
        if (!opt || st.money < opt.cost) break;
        buy(st, opt.kind, opt.key);
        bought = true;
      }
      if (bought) buys.push(t);
      else if (st.deployed) waits.push(t);
    }
    return { events, switches, deployAt, releaseAt, marks, final: flowInfo(st), state: st, buys, waits, gates, sortInfo, policy };
  } finally {
    RESEARCH.forEach((r, i) => (r.price = savedPrices[i]));
    restore();
  }
}

// ---- CLI ----

const width = (str) => [...str].reduce((w, ch) => w + (/[\u3000-\uffef]/.test(ch) ? 2 : 1), 0);
const padR = (str, n) => str + " ".repeat(Math.max(0, n - width(str)));

function parseArgs(argv) {
  const o = { vm: 8, clickRate: 1, clickSecs: 30, buyCap: 500, writeScale: 1, prices: {}, sets: [], backdoor: [], policy: null, humanBuyCap: 3, humanPick: "perDollar", humanSaveSecs: 0, sortBlockSecs: 30, trace: false, scenarios: false, maxSecs: 7200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vm") o.vm = Number(argv[++i]);
    else if (a === "--click") {
      const [r, s] = argv[++i].split(",").map(Number);
      o.clickRate = r;
      if (s != null && !Number.isNaN(s)) o.clickSecs = s;
      if (r === 0) o.clickSecs = 0;
    } else if (a === "--price") {
      for (const kv of argv[++i].split(",")) {
        const [k, v] = kv.split("=");
        o.prices[k] = Number(v);
      }
    } else if (a === "--set") o.sets.push(...argv[++i].split(",").filter(Boolean));
    else if (a === "--policy") o.policy = argv[++i];
    else if (a === "--human-buy") o.humanBuyCap = Number(argv[++i]);
    else if (a === "--human-pick") o.humanPick = argv[++i];
    else if (a === "--human-save") o.humanSaveSecs = Number(argv[++i]);
    else if (a === "--sort-secs") o.sortBlockSecs = Number(argv[++i]);
    else if (a === "--max") o.maxSecs = Number(argv[++i]);
    else if (a === "--write-scale") o.writeScale = Number(argv[++i]);
    else if (a === "--trace") o.trace = true;
    else if (a === "--backdoor") o.backdoor = argv[++i].split(",").filter(Boolean);
    else if (a === "--scenarios") o.scenarios = true;
  }
  return o;
}

function report(res, title) {
  console.log(`\n== ${title} ==`);
  console.log("時刻   研究                  価格   研究時の収入  ボトルネック コード");
  for (const e of res.events) {
    if (e.key === "deploy") {
      console.log(`${fmtTime(e.t).padStart(5)}  初回デプロイ`);
      continue;
    }
    console.log(
      `${fmtTime(e.t).padStart(5)}  ${padR(e.label, 16)} ${formatMoney(e.price).padStart(9)}  ${("$" + formatNumber(e.income) + "/s").padStart(12)}   ${e.bn.padEnd(9)} ${e.code}`,
    );
  }
  const end = res.releaseAt ?? Object.keys(res.marks).map(Number).pop();
  console.log("\n時刻   収入/秒       ボトルネック  コード");
  for (const [t, m] of Object.entries(res.marks)) {
    console.log(`${fmtTime(Number(t)).padStart(5)}  ${("$" + formatNumber(m.income) + "/s").padStart(12)}  ${m.bn.padEnd(9)} ${m.code}`);
  }
  const sw = res.switches;
  const span = (res.releaseAt ?? end) - (res.deployAt ?? 0);
  console.log(
    `\nボトルネックの入れ替わり: ${sw.length} 回（初回デプロイからリリースまで ${fmtTime(span)}、平均 ${(span / Math.max(1, sw.length)).toFixed(1)} 秒に 1 回）`,
  );
  console.log(`  序盤: ${sw.slice(0, 24).map((s) => `${fmtTime(s.t)} ${s.to}`).join(" > ")}`);
  console.log(`終盤の収入: $${formatNumber(res.final.incomePerSec)}/s（ボトルネック ${res.final.bottleneck}）`);
  console.log(`リリース: ${res.releaseAt != null ? fmtTime(res.releaseAt) : "到達せず"}`);
}

// SPEC 3.2 の「人間の目安」（幅があるものは中央）
const HUMAN_GUIDE = { crate: 42.5, inspector: 90, sorter: 145, sapphire: 220, monochrome: 305, crate_5: 400, straight: 485 };

/** 研究の間隔・単価記録の関門・sort { }・何も買わない区間をまとめる（--policy を付けたとき） */
export function analyze(res) {
  const ev = res.events.filter((e) => e.key !== "deploy");
  const rows = [];
  let prev = null;
  let prevGuide = null;
  for (const e of ev) {
    const g = HUMAN_GUIDE[e.key];
    rows.push({
      key: e.key, label: e.label, t: e.t, gap: prev == null ? null : e.t - prev,
      guide: g ?? null, guideGap: g != null && prevGuide != null ? g - prevGuide : null, income: e.income,
    });
    prev = e.t;
    prevGuide = g ?? null;
  }
  const after = res.buys.filter((t) => t >= (res.deployAt ?? 0));
  const gaps = [];
  for (let i = 1; i < after.length; i++) gaps.push({ from: after[i - 1], to: after[i], len: after[i] - after[i - 1] });
  gaps.sort((a, b) => b.len - a.len);
  // 「待つだけ」: 何も買えない秒が続いた区間（ボットが研究のために自分で貯めている秒は含めない）
  const waitRuns = [];
  for (const t of res.waits ?? []) {
    const last = waitRuns[waitRuns.length - 1];
    if (last && t === last.to + 1) last.to = t;
    else waitRuns.push({ from: t, to: t });
  }
  for (const w of waitRuns) w.len = w.to - w.from + 1;
  waitRuns.sort((a, b) => b.len - a.len);
  const gates = res.gates.filter((g) => RESEARCH.find((r) => r.key === g.key)?.requires?.record != null);
  return { rows, gates, sort: res.sortInfo, gaps, waitRuns, releaseAt: res.releaseAt };
}

function printAnalysis(res, title) {
  const a = analyze(res);
  console.log(`\n== ${title} ==`);
  console.log("研究                 時刻   間隔  人間の目安 目安の間隔(差)  研究時の収入");
  for (const r of a.rows) {
    const gap = r.gap == null ? "-" : `${r.gap}s`;
    const guide = r.guide == null ? "" : fmtTime(r.guide);
    const ggap = r.guideGap == null ? "" : `${r.guideGap.toFixed(0)}s (${((r.gap / r.guideGap - 1) * 100).toFixed(0)}%)`;
    console.log(`${padR(r.label, 18)} ${fmtTime(r.t).padStart(6)} ${gap.padStart(6)}  ${guide.padStart(8)}  ${ggap.padStart(12)}  $${formatNumber(r.income)}/s`);
  }
  console.log("\n単価記録の関門: 次の研究になった → 記録が届いた → お金が届いた → 買った（その間の収入）");
  const f = (x) => (x == null ? "-" : fmtTime(x));
  for (const g of a.gates) {
    console.log(
      `  ${padR(g.label, 14)} ${f(g.since)} → ${f(g.recordAt)} → ${f(g.moneyAt)} → ${f(g.boughtAt)}  記録待ち ${(g.recordAt ?? g.boughtAt) - g.since}s  ` +
        `$${formatNumber(g.incomeSince)}/s → $${formatNumber(g.incomeAt)}/s (x${(g.incomeAt / Math.max(1e-9, g.incomeSince)).toFixed(2)})`,
    );
  }
  const s = a.sort;
  if (s.start != null) {
    console.log(
      `\nsort { }: ${f(s.start)}〜${f(s.end)}、工場が赤 ${s.redSecs} 秒。` +
        `開始時 工場 ${formatNumber(s.refAtStart)} / 流入 ${formatNumber(s.inflowAtStart)} 個/秒、収入 $${formatNumber(s.incomeAtStart)}/s、` +
        `直前（reject）の収入 $${formatNumber(s.incomeBefore)}/s。` +
        `\n  お金で直す額 $${formatNumber(s.fixCost)}（赤の間の収入 ${(s.fixCost / Math.max(1e-9, s.incomeAtStart)).toFixed(1)} 秒分、直前の収入 ${(s.fixCost / Math.max(1e-9, s.incomeBefore)).toFixed(1)} 秒分）。` +
        `買い続けて赤が最初に消えた: ${s.clearAt != null ? `${s.clearAt - s.start} 秒後` : "sort { } の間は消えず"}` +
        `\n  その瞬間に sort_by なら: 工場${s.sortByRedAtStart ? "は赤のまま" : "は赤でない"}（工場/流入 = ${s.sortByRatioAtStart?.toFixed(2)}）。` +
        `実際に sort_by に替えた時点: ${s.sortByRedAtSwitch == null ? "-" : s.sortByRedAtSwitch ? "赤のまま" : "赤でない"}（工場/流入 = ${s.sortByFlowRatio?.toFixed(2) ?? "-"}）`,
    );
  }
  console.log(`\n何も買わない区間（長い順）: ${a.gaps.slice(0, 5).map((g) => `${f(g.from)}〜${f(g.to)} ${g.len}s`).join(" / ")}`);
  console.log(`買えるものがなく待つだけの区間（長い順）: ${a.waitRuns.slice(0, 5).map((g) => `${f(g.from)}〜${f(g.to)} ${g.len}s`).join(" / ")}`);
  const at = (k) => res.events.find((e) => e.key === k)?.t;
  if (at("yjit") != null && at("crate_9") != null && a.releaseAt != null) {
    console.log(`終盤: YJIT→定量梱包 IV ${at("crate_9") - at("yjit")} 秒、定量梱包 IV→リリース ${a.releaseAt - at("crate_9")} 秒`);
  }
  console.log(`リリース: ${f(a.releaseAt)}`);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const measured = measureCodes();
  console.log("コード        箱 色 表の単価    移植版の単価   表の鑑定  箱数/鉱石(移植版で測定)");
  for (const c of CODES) {
    const m = measured.get(c.key);
    console.log(
      `${c.key.padEnd(12)} ${String(c.box).padStart(2)} ${c.colors.length}  ${formatNumber(c.value).padStart(8)}  ${formatNumber(m.measuredValue).padStart(10)}  ${c.ops.toFixed(2).padStart(8)}  ${m.cratesPerOre.toFixed(3)}`,
    );
  }

  if (o.scenarios) {
    console.log("\nシナリオ                     初回デプロイ 定量梱包I ストレート リリース 入れ替わり 終盤の収入");
    const runs = [
      ["クリック 1/秒×30秒 VM 3秒", { vm: 3 }],
      ["クリック 1/秒×30秒 VM 8秒", { vm: 8 }],
      ["クリック 1/秒×30秒 VM 25秒", { vm: 25 }],
      ["クリック 1/秒×30秒 VM 60秒", { vm: 60 }],
      ["クリックなし VM 3秒", { vm: 3, clickRate: 0, clickSecs: 0 }],
      ["クリックなし VM 60秒", { vm: 60, clickRate: 0, clickSecs: 0 }],
    ];
    for (const [name, opt] of runs) {
      const r = simulate({ ...opt, prices: o.prices, sets: o.sets, buyCap: o.buyCap, maxSecs: o.maxSecs, measured });
      const at = (k) => {
        const e = r.events.find((x) => x.key === k);
        return e ? fmtTime(e.t) : "-";
      };
      console.log(
        `${padR(name, 28)}  ${fmtTime(r.deployAt ?? 0).padStart(6)}  ${at("crate").padStart(8)}  ${at("straight").padStart(8)}  ${(r.releaseAt != null ? fmtTime(r.releaseAt) : "-").padStart(7)}  ${String(r.switches.length).padStart(8)}   $${formatNumber(r.final.incomePerSec)}/s`,
      );
    }
    return;
  }

  if (o.policy) {
    const pols = o.policy === "both" ? ["bot", "human"] : [o.policy];
    const extra = [
      ...(o.backdoor.length ? [`裏口 ${o.backdoor.join("+")}`] : []),
    ];
    const note =
      (o.sets.length || Object.keys(o.prices).length ? `（上書き: ${[...o.sets, ...Object.entries(o.prices).map(([k, v]) => `${k}=${v}`)].join(", ")}）` : "") +
      (extra.length ? `（${extra.join("、")}）` : "");
    for (const p of pols) {
      const r = simulate({ ...o, policy: p, measured });
      printAnalysis(r, `${p === "human" ? `人間らしい方針（赤を ${o.humanBuyCap} 個/秒まで・${o.humanPick === "biggest" ? "容量最大" : "1 ドルあたり最大"}、sort { } ${o.sortBlockSecs} 秒${o.humanSaveSecs ? `、研究が収入 ${o.humanSaveSecs} 秒分以内なら貯める` : "、貯めない"}）` : "ボット方針"}${note}`);
    }
    return;
  }

  const res = simulate({ ...o, measured });
  const pricesNote = Object.keys(o.prices).length ? `（価格上書き: ${JSON.stringify(o.prices)}）` : "";
  report(res, `VM ${o.vm} 秒・クリック ${o.clickRate}/秒×${o.clickSecs} 秒${pricesNote}`);
  if (res.releaseAt == null || res.releaseAt > 40 * 60 || res.releaseAt < 15 * 60) {
    console.log("\n※ リリースが 15〜40 分の範囲外です。--price で価格を変えて確かめてください");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
