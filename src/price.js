import { BONUSES, COLORS } from "../data/balance.js";
import { researchEffects } from "./economy.js";

const UNIT = Object.fromEntries(COLORS.map((c) => [c.key, c.unit]));
const BONUS_ORDER = ["flawless", "mono", "ascending", "straight", "christmas"];
/** 金の箱（perfect）は無傷・単色・昇順・STRAIGHT の 4 つがそろった箱。7 個・9 個のストレートは合計 25 にならないので、クリスマス便は入れない */
const PERFECT_KEYS = ["flawless", "mono", "ascending", "straight"];
const NOT_ARRAY = -2;
/** prelude.rb の CRATE_CAP と同じ。有効な箱はベルトの原石数（512）を超えないので、これ以上は検品しない */
export const CRATE_CAP = 8192;
/** priceBatch が PricedBatch に付けるベルトと解禁済みのボーナス（監査の売上の下限に使う。シンボルなので JSON には出ず、スプレッドでは残る） */
export const PRICED_BELT = Symbol("belt");
export const PRICED_BONUSES = Symbol("bonuses");

function effectsOf({ research, bonuses, polish }) {
  const eff = researchEffects(research ?? []);
  return {
    bonuses: bonuses ? new Set(bonuses) : eff.bonuses,
    polish: polish ?? eff.polish,
  };
}

function bonusLabel(key, mul) {
  return `${BONUSES[key].label} ×${mul}`;
}

/**
 * ores は belt の原石オブジェクト。Ore 以外・存在しない id は null で渡す。
 * 複製の判定は箱をまたぐので priceBatch 側で行う。
 */
export function crateValue(ores, { box, research, bonuses, polished = new Set(), polish } = {}) {
  const eff = effectsOf({ research, bonuses, polish });
  const n = ores.length;
  if (n === 0) return { value: 0, bonuses: [], valid: false, reason: "empty", perfect: false };
  if (n > box) return { value: 0, bonuses: [], valid: false, reason: "overflow", perfect: false };
  if (ores.some((o) => o == null)) return { value: 0, bonuses: [], valid: false, reason: "not-ore", perfect: false };

  let base = 0;
  for (const o of ores) base += o.carat * UNIT[o.color];
  base *= n;

  const got = [];
  const isPolished = (o) => eff.polish && polished.has(o.id);
  if (eff.bonuses.has("flawless") && ores.every((o) => !o.flaw || isPolished(o))) {
    got.push({ key: "flawless", label: bonusLabel("flawless", 3), mul: BONUSES.flawless.mul });
  }
  if (eff.bonuses.has("mono") && ores.every((o) => o.color === ores[0].color)) {
    got.push({ key: "mono", label: bonusLabel("mono", 3), mul: BONUSES.mono.mul });
  }
  if (eff.bonuses.has("ascending") && n >= 2 && ores.every((o, i) => i === 0 || ores[i - 1].carat <= o.carat)) {
    got.push({ key: "ascending", label: bonusLabel("ascending", 2), mul: BONUSES.ascending.mul });
  }
  if (eff.bonuses.has("straight") && n >= 3 && ores.every((o, i) => i === 0 || o.carat === ores[i - 1].carat + 1)) {
    const mul = 2 ** (n - 1);
    got.push({ key: "straight", label: bonusLabel("straight", mul), mul });
  }
  if (eff.bonuses.has("christmas") && ores.reduce((s, o) => s + o.carat, 0) === BONUSES.christmas.sum) {
    got.push({ key: "christmas", label: bonusLabel("christmas", BONUSES.christmas.mul), mul: BONUSES.christmas.mul });
  }
  got.sort((a, b) => BONUS_ORDER.indexOf(a.key) - BONUS_ORDER.indexOf(b.key));
  const value = got.reduce((v, b) => v * b.mul, base);
  return { value, bonuses: got, valid: true, reason: null, perfect: PERFECT_KEYS.every((k) => got.some((b) => b.key === k)) };
}

/** Yield の @ops を負の数や NaN に書き換えられても、鑑定回数は 0 より下にしない */
function safeOps(x) {
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function emptyBatch(belt, rubyResult, ok) {
  const ops = safeOps(rubyResult?.ops);
  const len = belt.length || 1;
  return {
    ok,
    ops,
    opsPerOre: ops / len,
    value: 0,
    valuePerOre: 0,
    crates: [],
    validCrates: 0,
    cratesPerOre: 0,
    shippedOres: 0,
    scrapOres: belt.length,
    polished: [],
    issues: [],
  };
}

function idList(ids, max = 5) {
  const head = ids.slice(0, max).join(", ");
  return ids.length > max ? `${head} ほか ${ids.length - max} 個` : head;
}

export function priceBatch(belt, rubyResult, opts = {}) {
  if (!rubyResult || !rubyResult.ok) return emptyBatch(belt, rubyResult, false);

  const eff = effectsOf(opts);
  const box = opts.box ?? 1;
  const polished = new Set(rubyResult.polished ?? []);
  const byId = new Map(belt.map((o) => [o.id, o]));
  const rawCrates = rubyResult.crates ?? [];

  // Ruby 側は配列でない要素を [-2]（箱の中の Ore 以外は -1）にする。全部が [-2] なら「配列の配列」ではなかった
  if (rawCrates.length > 0 && rawCrates.every((c) => c.length === 1 && c[0] === NOT_ARRAY)) {
    const res = emptyBatch(belt, rubyResult, false);
    res.issues.push("pack が配列の配列を返していません。箱ごとに原石を配列に入れて返してください");
    return res;
  }

  const shipped = new Set();
  const occurrences = new Map();
  const crates = [];
  let value = 0;
  let validCrates = 0;
  let shippedOres = 0;
  let notOre = 0;
  let unknownIds = 0;
  let overflow = 0;
  let overflowMax = 0;
  let empty = 0;
  let dupCrates = 0;

  for (const ids of rawCrates) {
    for (const id of ids) if (id >= 0) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    const ores = ids.map((id) => (id >= 0 ? byId.get(id) ?? null : null));
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] < 0) notOre++;
      else if (ores[i] == null) unknownIds++;
    }
    let r = crateValue(ores, { box, bonuses: eff.bonuses, polish: eff.polish, polished });
    if (r.valid) {
      const seen = new Set();
      let dup = false;
      for (const id of ids) {
        if (shipped.has(id) || seen.has(id)) {
          dup = true;
          break;
        }
        seen.add(id);
      }
      if (dup) {
        r = { value: 0, bonuses: [], valid: false, reason: "duplicate", perfect: false };
        dupCrates++;
      }
    } else if (r.reason === "overflow") {
      overflow++;
      overflowMax = Math.max(overflowMax, ids.length);
    } else if (r.reason === "empty") {
      empty++;
    }
    if (r.valid) {
      for (const id of ids) shipped.add(id);
      value += r.value;
      validCrates++;
      shippedOres += ids.length;
    }
    crates.push({ ids, ores, value: r.value, valid: r.valid, reason: r.reason, bonuses: r.bonuses, perfect: r.perfect });
  }

  const issues = [];
  if (dupCrates > 0) {
    const byCount = new Map();
    for (const [id, n] of occurrences) {
      if (n < 2) continue;
      if (!byCount.has(n)) byCount.set(n, []);
      byCount.get(n).push(id);
    }
    for (const [n, ids] of [...byCount].sort((a, b) => b[0] - a[0]).slice(0, 3)) {
      issues.push(`id ${idList(ids.sort((a, b) => a - b))} が ${n} 回出荷されています。複製は無効です`);
    }
  }
  // Ruby 側は box + 1 個で打ち切って送るので、それ以上の個数は分からない
  if (overflow > 0) issues.push(`box は ${box} なのに ${overflowMax > box + 1 ? `${overflowMax} 個` : `${box + 1} 個以上`}入った箱があります。はみ出した ${overflow} 箱は無効です`);
  if (notOre > 0) issues.push(`Ore 以外が ${notOre} 個入っています`);
  if (unknownIds > 0) issues.push(`ベルトにない id の原石が ${unknownIds} 個入っています`);
  if (empty > 0) issues.push(`空の箱が ${empty} 箱あります`);
  if (rubyResult.crateCount > rawCrates.length) issues.push(`pack が ${rubyResult.crateCount} 箱返しました。先頭 ${rawCrates.length} 箱だけ検品しています`);
  if (shippedOres === 0) {
    issues.push(rawCrates.length === 0
      ? `pack が空の配列を返しました。${belt.length} 個すべてスクラップです`
      : `有効な箱が 1 つもありません。${belt.length} 個すべてスクラップです`);
  }

  const len = belt.length || 1;
  const ops = safeOps(rubyResult.ops);
  return {
    ok: true,
    ops,
    opsPerOre: ops / len,
    value,
    valuePerOre: value / len,
    crates,
    validCrates,
    cratesPerOre: validCrates / len,
    shippedOres,
    scrapOres: belt.length - shippedOres,
    polished: eff.polish ? [...polished] : [],
    issues,
    [PRICED_BELT]: belt,
    [PRICED_BONUSES]: eff.bonuses,
  };
}

export function rePrice(belt, rubyResult, opts) {
  return priceBatch(belt, rubyResult, opts);
}

/** state.lastCrates / CrateView 用の簡易版（有効な箱だけ、先頭 limit 箱） */
export function crateViews(priced, limit = 64) {
  const polished = new Set(priced.polished ?? []);
  const out = [];
  for (const c of priced.crates) {
    if (!c.valid) continue;
    out.push({
      cells: c.ores.map((o) => ({ color: o.color, carat: o.carat, flaw: o.flaw, polished: polished.has(o.id) })),
      value: c.value,
      bonuses: c.bonuses.map(({ key, label }) => ({ key, label })),
      perfect: c.perfect,
    });
    if (out.length >= limit) break;
  }
  return out;
}
