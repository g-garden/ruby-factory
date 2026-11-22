import {
  BACKDOOR,
  BELTS,
  CLICK_HALF_LIFE_SEC,
  COST_GROWTH,
  CPU_BASE,
  CPUS,
  DOCK_BASE,
  DOCKS,
  EMA_ALPHA,
  EMA_WINDOW,
  FIRST_DEPLOY_PICKAXES,
  MINES,
  PASSTHROUGH_VALUE,
  RESEARCH,
} from "../data/balance.js";

export const STAGES = ["mine", "belt", "refinery", "dock"];
export const STAGE_LABEL = { mine: "採掘", belt: "ベルト", refinery: "工場", dock: "出荷ドック" };
const STAGE_KIND = { mine: "mine", belt: "belt", refinery: "cpu", dock: "dock" };
const LISTS = { mine: MINES, cpu: CPUS, dock: DOCKS };
const STATE_FIELD = { mine: "mines", cpu: "cpus", dock: "docks" };
const CLICK_LAMBDA = Math.LN2 / CLICK_HALF_LIFE_SEC;
const RESEARCH_BY_KEY = new Map(RESEARCH.map((r) => [r.key, r]));

// ---- 研究 → 効果（price.js もこれを使う） ----

export function researchEffects(keys) {
  const done = new Set(keys);
  const out = { box: 1, colors: ["red"], bonuses: new Set(), polish: false, cpuMul: 1, opsMul: 1, ended: false };
  for (const r of RESEARCH) {
    if (!done.has(r.key)) continue;
    const e = r.effect;
    if (e.box) out.box = Math.max(out.box, e.box);
    if (e.color && !out.colors.includes(e.color)) out.colors.push(e.color);
    if (e.bonus) out.bonuses.add(e.bonus);
    if (e.polish) out.polish = true;
    if (e.cpuMul) out.cpuMul *= e.cpuMul;
    if (e.opsMul) out.opsMul *= e.opsMul;
    if (e.ending) out.ended = true;
  }
  return out;
}

export function derive(state) {
  const eff = researchEffects(state.research);
  const done = new Set(state.research);
  eff.nextResearch = RESEARCH.find((r) => !done.has(r.key)) ?? null;
  return eff;
}

// ---- 値段 ----

/** owned は state に入っている台数そのもの（つるはしなら最初の 1 本を含む） */
export function costOf(list, key, owned) {
  const item = list.find((x) => x.key === key);
  if (!item) throw new Error(`unknown item: ${key}`);
  const bought = Math.max(0, (owned ?? 0) - (item.initial ?? 0));
  return item.base * COST_GROWTH ** bought;
}

// ---- 裏口（SPEC-rubyist 4.6）。Ruby の報告は clampBackdoor で丸めてから state.backdoor に入れる ----

/** state.backdoor を読んで、効き目の範囲に丸めたもの（古いセーブや壊れた値でも 1 車線・夜間ラインなし） */
export function backdoorOf(state) {
  const b = state?.backdoor;
  const l = Math.floor(Number(b?.lanes));
  return {
    lanes: Number.isFinite(l) ? Math.min(BACKDOOR.lanesMax, Math.max(1, l)) : 1,
    night: b?.night === true,
    overtime: Math.max(0, Math.floor(Number(b?.overtime) || 0)),
  };
}

const isFinalBelt = (state) => (state.belt ?? 0) >= BELTS.length - 1;

/** いま効いている車線数（最終段のベルトのときだけ 2 車線が効く） */
export function beltLanes(state) {
  return isFinalBelt(state) ? backdoorOf(state).lanes : 1;
}

/**
 * Ruby の報告（BatchResult.backdoor。生の値か null）を丸める。notes は丸めたときの一言（ログ用）。
 * 2 車線は最終段より前のベルトでも lanes: 2 のまま返す（ページは埋まる。容量に効くのは最終段のときだけ）
 */
export function clampBackdoor(raw, state) {
  const out = { lanes: 1, night: false, overtime: 0, notes: [] };
  if (raw == null || typeof raw !== "object") return out;
  const l = raw.lanes;
  if (l == null || l === 1) out.lanes = 1;
  else if (typeof l !== "number" || !Number.isInteger(l) || l <= 0) {
    out.lanes = 1;
    out.notes.push("0 車線じゃベルトが止まる。やめておいたぞ");
  } else if (l > BACKDOOR.lanesMax) {
    out.lanes = BACKDOOR.lanesMax;
    out.notes.push(`床が抜ける。${BACKDOOR.lanesMax} 車線にしておいたぞ`);
  } else out.lanes = l;
  if (out.lanes > 1 && state && !isFinalBelt(state)) {
    const cur = BELTS[Math.min(state.belt ?? 0, BELTS.length - 1)];
    out.notes.push(`${out.lanes} 車線にできるのは${BELTS[BELTS.length - 1].label}ベルトだけだ。いまは${cur.label}ベルトだぞ`);
  }
  out.night = raw.night === true || raw.night === 1;
  const ot = Number(raw.overtime);
  out.overtime = Number.isFinite(ot) && ot > 0 ? Math.floor(ot) : 0;
  return out;
}

/** 設備 1 台あたりのいまの能力（夜間ラインなら最上位の採掘とドックだけ ×nightMul）。econ の買い物と表示もこれを使う */
export function unitRate(state, kind, key) {
  const list = kind === "mine" ? MINES : kind === "cpu" ? CPUS : kind === "dock" ? DOCKS : null;
  const item = list?.find((x) => x.key === key);
  if (!item) return 0;
  const night = backdoorOf(state).night;
  if (night && ((kind === "mine" && key === BACKDOOR.nightMine) || (kind === "dock" && key === BACKDOOR.nightDock))) {
    return item.rate * BACKDOOR.nightMul;
  }
  return item.rate;
}

function sumRates(state, kind, list, counts) {
  let s = 0;
  for (const x of list) s += unitRate(state, kind, x.key) * (counts?.[x.key] ?? 0);
  return s;
}

export function mineRate(state) {
  return sumRates(state, "mine", MINES, state.mines);
}

export function cpuRate(state) {
  return (CPU_BASE + sumRates(state, "cpu", CPUS, state.cpus)) * derive(state).cpuMul;
}

export function dockRate(state) {
  return DOCK_BASE + sumRates(state, "dock", DOCKS, state.docks);
}

/** 素通し中（初回デプロイ前）は $1・鑑定 0・ドック不使用 */
export function effectiveEma(state) {
  if (!state.deployed) return { valuePerOre: PASSTHROUGH_VALUE, opsPerOre: 0, cratesPerOre: 0 };
  return state.ema;
}

// ---- 5.7 流量 ----

export function capacities(state) {
  const ema = effectiveEma(state);
  const { opsMul } = derive(state);
  const ops = ema.opsPerOre * opsMul;
  return {
    mine: mineRate(state),
    belt: BELTS[Math.min(state.belt ?? 0, BELTS.length - 1)].cap * beltLanes(state),
    refinery: ops > 0 ? cpuRate(state) / ops : Infinity,
    dock: state.deployed && ema.cratesPerOre > 0 ? dockRate(state) / ema.cratesPerOre : Infinity,
  };
}

function nearlyLE(a, b) {
  if (a === b) return true;
  return a <= b + Math.abs(b) * 1e-9;
}

export function flowInfo(state) {
  const caps = capacities(state);
  let bottleneck = STAGES[0];
  for (const s of STAGES) if (nearlyLE(caps[s], caps[bottleneck])) bottleneck = s; // 同率なら下流
  const flow = caps[bottleneck];
  const ema = effectiveEma(state);
  const clickRate = state.clickRate ?? 0;
  const util = {};
  for (const s of STAGES) util[s] = caps[s] === Infinity ? 0 : caps[s] > 0 ? Math.min(1, flow / caps[s]) : 1;
  // クリックはラインの外で即出荷するので、採掘の表示にだけ足す
  if (clickRate > 0) util.mine = Math.min(1, (flow + clickRate) / (caps.mine + clickRate));
  const idx = STAGES.indexOf(bottleneck);
  const inflow = idx === 0 ? flow : Math.min(...STAGES.slice(0, idx).map((s) => caps[s]));
  return {
    caps,
    flow,
    incomePerSec: flow * ema.valuePerOre,
    valuePerOre: ema.valuePerOre,
    util,
    bottleneck,
    inflow,
    backlogRate: Math.max(0, inflow - flow),
    clickRate,
    passthrough: !state.deployed,
  };
}

// ---- 数値の表示（診断カードの文面用） ----

const SUFFIXES = ["", "K", "M", "B", "T", "Qa", "Qi"];

export function formatNumber(n, { decimals } = {}) {
  if (n === Infinity) return "∞";
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs < 1000) {
    if (decimals != null) return n.toFixed(decimals);
    if (abs >= 100 || Number.isInteger(n)) return String(Math.round(n));
    return String(Number(n.toPrecision(3)));
  }
  let tier = Math.floor(Math.log10(abs) / 3);
  let v = n / 1000 ** tier;
  if (Math.abs(v) >= 999.5) {
    tier++;
    v /= 1000;
  }
  if (tier >= SUFFIXES.length) return n.toExponential(2).replace("e+", "e");
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1") + SUFFIXES[tier];
}

export function formatMoney(n) {
  if (Math.abs(n) < 1000) return `$${Math.floor(n).toLocaleString("en-US")}`;
  return `$${formatNumber(n)}`;
}

/** 条件まで足りない額。丸めると「記録 $3K で $3K が必要」と届いたように見えるので、差を切り上げて出す */
export function formatShortfall(need, have) {
  const gap = need - (have ?? 0);
  if (!(gap > 0)) return "$0";
  if (gap < 1) return `$${(Math.ceil(gap * 100 - 1e-6) / 100).toFixed(2)}`;
  return formatMoney(Math.ceil(gap));
}

// ---- 購入 ----

function cloneForWhatIf(state) {
  return {
    ...state,
    mines: { ...state.mines },
    cpus: { ...state.cpus },
    docks: { ...state.docks },
    ema: { ...state.ema },
    research: [...state.research],
  };
}

export function priceOf(state, kind, key) {
  if (kind === "belt") {
    const next = BELTS[(state.belt ?? 0) + 1];
    return next ? next.price : Infinity;
  }
  if (kind === "research") return RESEARCH_BY_KEY.get(key)?.price ?? Infinity;
  return costOf(LISTS[kind], key, state[STATE_FIELD[kind]]?.[key] ?? 0);
}

export function canResearch(state, key) {
  const def = RESEARCH_BY_KEY.get(key);
  if (!def) return { ok: false, reason: "その研究はありません", missing: "unknown" };
  if (state.research.includes(key)) return { ok: false, reason: "研究済みです", missing: "done" };
  const next = derive(state).nextResearch;
  if (!next || next.key !== key) return { ok: false, reason: `先に「${next?.label}」を研究してください`, missing: "order" };
  if (def.requires?.record != null && (state.record ?? 0) < def.requires.record) {
    return {
      ok: false,
      reason: `単価記録 ${formatMoney(def.requires.record)} が必要です。あと ${formatShortfall(def.requires.record, state.record)} 足りません`,
      missing: "record",
    };
  }
  if (state.money < def.price) return { ok: false, reason: "お金が足りません", missing: "money" };
  return { ok: true, reason: null, missing: null };
}

export function buy(state, kind, key) {
  if (kind === "research") {
    const chk = canResearch(state, key);
    if (!chk.ok) return { ok: false, state, reason: chk.reason };
    const def = RESEARCH_BY_KEY.get(key);
    state.money -= def.price;
    state.research.push(key);
    return { ok: true, state, reason: null, cost: def.price, effect: def.effect };
  }
  if (kind === "belt") {
    const tier = (state.belt ?? 0) + 1;
    if (tier >= BELTS.length) return { ok: false, state, reason: "これ以上のベルトはありません" };
    const cost = BELTS[tier].price;
    if (state.money < cost) return { ok: false, state, reason: "お金が足りません" };
    state.money -= cost;
    state.belt = tier;
    return { ok: true, state, reason: null, cost };
  }
  const list = LISTS[kind];
  if (!list || !list.some((x) => x.key === key)) return { ok: false, state, reason: "その設備はありません" };
  const field = STATE_FIELD[kind];
  const owned = state[field][key] ?? 0;
  const cost = costOf(list, key, owned);
  if (state.money < cost) return { ok: false, state, reason: "お金が足りません" };
  state.money -= cost;
  state[field][key] = owned + 1;
  return { ok: true, state, reason: null, cost };
}

export function canDeploy(state, vmReady) {
  if (!vmReady) return { ok: false, reason: "Ruby VM を準備中…", remaining: null };
  if (state.deployed) return { ok: true, reason: null, remaining: 0 };
  const remaining = Math.max(0, FIRST_DEPLOY_PICKAXES - (state.mines.pickaxe ?? 0));
  if (remaining > 0) {
    return { ok: false, reason: `つるはし ${FIRST_DEPLOY_PICKAXES} 本で工場が動きます。あと ${remaining} 本`, remaining };
  }
  return { ok: true, reason: null, remaining: 0 };
}

// ---- 診断カード（8.3） ----

function gainPct(before, after) {
  if (!(before > 0)) return after > 0 ? Infinity : 0;
  return (after / before - 1) * 100;
}

function codeHint(code, stage, box = 1, research = []) {
  const src = code ?? "";
  if (stage === "dock") {
    if (box <= 1) {
      // box が 1 のうちは each_slice(box) を書いても箱は減らない。先に箱を大きくする研究が要る
      const r = RESEARCH.find((x) => x.effect?.box > 1 && !research.includes(x.key));
      return r
        ? `いまは 1 箱 1 個までです。研究「${r.label}」を ${formatMoney(r.price)} で買って box が ${r.effect.box} になったら、each_slice(box) で詰めると箱が減ります`
        : "each_slice(box) で 1 箱に box 個まで詰められます";
    }
    if (!/\bbox\b/.test(src)) return "each_slice(box) で 1 箱に box 個まで詰められます";
    return "箱を大きくすると箱の数が減り、ドックが空きます";
  }
  if (/\.sort\s*(\{|do\b)/.test(src)) return "sort のブロックの中で carat を読んでいます。sort_by(&:carat) なら 1 個 1 回で済みます";
  for (const attr of ["carat", "color", "flaw"]) {
    const n = (src.match(new RegExp(`(\\.|&:)${attr}\\b`, "g")) ?? []).length;
    if (n >= 3) return `${attr} を何度も読んでいます。1 回読んで変数に持つと鑑定が減ります`;
  }
  if (/\.polish\b|&:polish\b/.test(src)) {
    // map(&:polish) や it.flaw ? it.polish : it は傷物を全部磨く。穴だけ磨くコード（ヒントの手本）には同じことを勧めない
    const all = /&:polish\b/.test(src) || /\bflaw\s*\?\s*\w+\.polish\b/.test(src);
    return all
      ? "polish は 1 バッチで n 回目の研磨に鑑定が n 回かかります。全部磨かずに、箱いっぱいの窓の穴を埋める傷物だけ磨くと鑑定がぐっと減ります"
      : "polish は 1 バッチで n 回目の研磨に鑑定が n 回かかります。工場が赤いうちは、研磨なしのコードの方が稼ぐこともあります。CPU を足すか、磨く数を減らしてみてください";
  }
  if (/chunk_while/.test(src)) return "each_cons 版は chunk_while 版より鑑定が少なめです";
  return "carat・color・flaw を読んだ回数がそのまま鑑定回数です";
}

export function diagnose(state, stage) {
  const fi = flowInfo(state);
  const caps = fi.caps;
  const ema = effectiveEma(state);
  const eff = derive(state);
  const idx = STAGES.indexOf(stage);
  const inflow = idx === 0 ? null : Math.min(...STAGES.slice(0, idx).map((s) => caps[s]));
  const title =
    inflow == null
      ? `${STAGE_LABEL[stage]}: ${formatNumber(caps[stage])} 個/秒`
      : `${STAGE_LABEL[stage]}: 処理 ${formatNumber(caps[stage])} 個/秒 ／ 流入 ${formatNumber(inflow)} 個/秒`;

  const lines = [];
  if (stage === "mine") {
    const parts = MINES.filter((m) => (state.mines[m.key] ?? 0) > 0).map((m) => {
      const r = unitRate(state, "mine", m.key);
      return `${m.label} ${state.mines[m.key]} × ${formatNumber(r)}${r !== m.rate ? "（夜間）" : ""}`;
    });
    lines.push(`${parts.join(" ＋ ")} = ${formatNumber(caps.mine)} 個/秒`);
    if (fi.clickRate > 0.05) lines.push(`手掘り ${formatNumber(fi.clickRate, { decimals: 1 })} 個/秒。掘ったその場で出荷します`);
  } else if (stage === "belt") {
    const cur = BELTS[state.belt ?? 0];
    const lanes = beltLanes(state);
    lines.push(`${cur.label}ベルト: 容量 ${formatNumber(cur.cap * lanes)} 個/秒${lanes > 1 ? `、${lanes} 車線` : ""}`);
  } else if (stage === "refinery") {
    const mul = [];
    if (eff.cpuMul !== 1) mul.push(`Ractor ×${eff.cpuMul}`);
    if (eff.opsMul !== 1) mul.push(`YJIT ×${eff.opsMul}`);
    lines.push(
      `CPU ${formatNumber(cpuRate(state))} 鑑定/秒 ÷ 鑑定 ${formatNumber(ema.opsPerOre * eff.opsMul, { decimals: 2 })} 回/鉱石` +
        (mul.length ? `（${mul.join("、")}）` : ""),
    );
  } else if (stage === "dock") {
    lines.push(`ドック ${formatNumber(dockRate(state))} 箱/秒 ÷ ${formatNumber(ema.cratesPerOre, { decimals: 2 })} 箱/鉱石`);
  }

  // お金で直す: その工程の設備を 1 つ足した場合
  const kind = STAGE_KIND[stage];
  const options = [];
  if (kind === "belt") {
    const tier = (state.belt ?? 0) + 1;
    if (tier < BELTS.length) options.push({ kind, key: tier, label: `${BELTS[tier].label}ベルト`, cost: BELTS[tier].price });
  } else {
    for (const item of LISTS[kind]) {
      options.push({ kind, key: item.key, label: item.label, cost: priceOf(state, kind, item.key) });
    }
  }
  const budget = Math.max(state.money, fi.incomePerSec * 30, 1) * 10;
  options.sort((a, b) => a.cost - b.cost);
  let shown = options.filter((o) => o.cost <= budget).slice(-2);
  if (shown.length === 0) shown = options.slice(0, 1);
  const money = shown.map((o) => {
    const s2 = cloneForWhatIf(state);
    if (o.kind === "belt") s2.belt = o.key;
    else s2[STATE_FIELD[o.kind]][o.key] = (s2[STATE_FIELD[o.kind]][o.key] ?? 0) + 1;
    const f2 = flowInfo(s2);
    return {
      ...o,
      label: o.kind === "belt" ? o.label : `${o.label} +1`,
      incomeGainPct: gainPct(fi.incomePerSec, f2.incomePerSec),
      movesBottleneckTo: f2.bottleneck !== stage ? f2.bottleneck : null,
    };
  });

  // コードで直す
  const code = { opsMinusOneGainPct: null, cratesGainPct: null, hint: null, floorPerOre: null, auditLine: null };
  if (stage === "refinery" && state.deployed) {
    // 「鑑定を 1 回減らせたら」は監査ラインより下を見積もらない（SPEC-rubyist 2.3）
    const floor = Number.isFinite(ema.floorPerOre) && ema.floorPerOre > 0 ? ema.floorPerOre : 0;
    const s2 = cloneForWhatIf(state);
    s2.ema.opsPerOre = Math.max(floor, ema.opsPerOre - 1);
    code.opsMinusOneGainPct = gainPct(fi.incomePerSec, flowInfo(s2).incomePerSec);
    code.hint = codeHint(state.lastGoodCode ?? state.code, stage, eff.box, state.research);
    if (floor > 0) {
      code.floorPerOre = floor;
      code.auditLine = `鑑定の下限 ${formatNumber(floor * eff.opsMul, { decimals: 2 })} 回/鉱石。理論上ここまで減らせます`;
    }
  } else if (stage === "dock" && state.deployed) {
    const shippedPerOre = ema.shippedPerOre ?? 1;
    const ideal = shippedPerOre / eff.box;
    if (ideal < ema.cratesPerOre) {
      const s2 = cloneForWhatIf(state);
      s2.ema.cratesPerOre = ideal;
      code.cratesGainPct = gainPct(fi.incomePerSec, flowInfo(s2).incomePerSec);
    }
    code.hint = codeHint(state.lastGoodCode ?? state.code, stage, eff.box, state.research);
  } else if (stage === "belt" && (state.belt ?? 0) >= BELTS.length - 1) {
    // 最終段のベルトはお金では広げられない。収入を伸ばせるのは単価（研究とコード）だけ
    lines.push("最終段階です。これ以上は広げられません");
    code.hint = maxedBeltNote(state);
  }

  return { title, lines, money, code };
}

/** 最終段のベルトが赤いときの一言。次の研究で何が伸びるかを言う（研究バナー・ショップ・診断カードで共通） */
export function maxedBeltNote(state) {
  const next = derive(state).nextResearch;
  if (!next) return "あとは単価を上げると収入が伸びます";
  const e = next.effect ?? {};
  if (e.ending) return `あとは研究「${next.label}」の ${formatMoney(next.price)} まで貯めるだけです`;
  if (e.box || e.color || e.bonus || e.polish) return `次の研究「${next.label}」で単価を上げると収入が伸びます`;
  return `次の研究「${next.label}」まで貯めましょう`;
}

// ---- 手掘りと時間経過 ----

export function clickMine(state) {
  const earned = Math.max(PASSTHROUGH_VALUE, state.deployed ? state.ema.valuePerOre : PASSTHROUGH_VALUE);
  state.money += earned;
  state.totalEarned = (state.totalEarned ?? 0) + earned;
  state.clickRate = (state.clickRate ?? 0) + CLICK_LAMBDA;
  if (state.stats) state.stats.shipped = (state.stats.shipped ?? 0) + 1;
  return { earned };
}

export function tick(state, dt) {
  if (state.clickRate) {
    state.clickRate *= Math.exp(-CLICK_LAMBDA * dt);
    if (state.clickRate < 1e-3) state.clickRate = 0;
  }
  const fi = flowInfo(state);
  const earned = fi.incomePerSec * dt;
  state.money += earned;
  state.totalEarned = (state.totalEarned ?? 0) + earned;
  if (state.stats) state.stats.shipped = (state.stats.shipped ?? 0) + fi.flow * dt;
  return { earned, flowInfo: fi };
}

// ---- バッチ結果 → 移動平均・記録 ----

/** 古い順に並んだ PricedBatch の配列から、直近 EMA_WINDOW 個の指数移動平均を作る */
export function emaFromBatches(batches) {
  const list = batches.filter((b) => b && b.ok).slice(-EMA_WINDOW);
  if (list.length === 0) return null;
  // opsPerOre は audit.auditPriced で max(実測, 監査ライン) に置き換えた後の値。floorPerOre は監査ライン（無ければ 0）
  const pick = (b) => ({
    valuePerOre: b.valuePerOre,
    opsPerOre: b.opsPerOre,
    cratesPerOre: b.cratesPerOre,
    shippedPerOre: b.shippedOres / Math.max(1, b.shippedOres + b.scrapOres),
    floorPerOre: b.audit?.floorPerOre ?? 0,
  });
  const ema = pick(list[0]);
  for (const b of list.slice(1)) {
    const x = pick(b);
    for (const k of Object.keys(ema)) ema[k] = EMA_ALPHA * x[k] + (1 - EMA_ALPHA) * ema[k];
  }
  return ema;
}

/** 単価の記録を更新する。更新したら true */
export function updateRecord(state) {
  if (!state.deployed) return false;
  const v = state.ema.valuePerOre;
  if (v > (state.record ?? 0)) {
    state.record = v;
    return true;
  }
  return false;
}
