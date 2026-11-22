// 監査ライン（SPEC-rubyist 3.2・4.4）。出荷された箱のボーナスから「最低でもこれだけは鑑定したはず」を見積もる。
// 鑑定を数えずに属性を読む技（bind_call・tick の再定義など）を使っても、工場の計算に使う鑑定はこのラインより下がらない。
// 根拠は JS が持つもの（PricedBatch の crates とボーナス、Ruby が返した研磨済みの id）だけ。Ruby の申告やコード文字列は使わない。
import { AUDIT, BATCH_SIZE, BONUSES, COLORS, UNKNOWN_TECHNIQUE } from "../data/balance.js";
import { crateValue, PRICED_BELT, PRICED_BONUSES } from "./price.js";

export { PRICED_BELT, PRICED_BONUSES };

const CARAT_KINDS = 9;

function choose(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** n 個を適当に並べて carat が昇順（同じ値を含む）になる確率 */
export function chanceAscending(n) {
  return n < 2 ? 0 : choose(n + CARAT_KINDS - 1, n) / CARAT_KINDS ** n;
}
/** 傷の有無を見ずに n 個詰めて全部無傷になる確率 */
export function chanceFlawless(n) {
  return 0.75 ** n;
}
/** 色を見ずに n 個詰めて全部同じ色になる確率（k 色） */
export function chanceMono(n, k) {
  return k <= 1 ? 1 : (1 / k) ** (n - 1);
}
/** n 個を適当に並べて carat が 1 ずつ増える（STRAIGHT）確率。ストレートは 3 個以上の箱だけ */
export function chanceStraight(n) {
  return n < 3 ? 0 : Math.max(0, CARAT_KINDS - n + 1) / CARAT_KINDS ** n;
}

/**
 * n 個の carat（1..9 が独立に等確率）について、昇順・STRAIGHT・合計 25（クリスマス便）の同時確率。
 * 合計 25 は昇順や STRAIGHT と独立ではない（5 個の STRAIGHT で合計 25 は 3..7 だけ）ので、掛け算ではなく数え上げる。
 * cells は [昇順か, STRAIGHT か, 合計 25 か] ごとの確率（期待値と分散に使う）
 */
const caratCache = new Map();
export function chanceCarat(n) {
  if (caratCache.has(n)) return caratCache.get(n);
  const target = BONUSES.christmas.sum;
  // 状態: 直前の carat・ここまでの合計・ここまで昇順か・ここまで 1 ずつ増えているか
  let cur = new Map();
  const put = (m, key, p) => m.set(key, (m.get(key) ?? 0) + p);
  if (n >= 1) for (let k = 1; k <= CARAT_KINDS; k++) put(cur, `${k}|${k}|1|1`, 1 / CARAT_KINDS);
  for (let i = 1; i < n; i++) {
    const next = new Map();
    for (const [key, p] of cur) {
      const [last, sum, asc, st] = key.split("|").map(Number);
      for (let k = 1; k <= CARAT_KINDS; k++) {
        const s = Math.min(sum + k, target + 1); // 25 を超えたらまとめる
        put(next, `${k}|${s}|${asc && k >= last ? 1 : 0}|${st && k === last + 1 ? 1 : 0}`, p / CARAT_KINDS);
      }
    }
    cur = next;
  }
  const cells = new Map();
  for (const [key, p] of cur) {
    const [, sum, asc, st] = key.split("|").map(Number);
    const a = n >= 2 && asc === 1;
    const s = n >= 3 && st === 1;
    put(cells, `${+a}${+s}${+(sum === target)}`, p);
  }
  const P = (f) => [...cells].reduce((t, [k, p]) => (f(k[0] === "1", k[1] === "1", k[2] === "1") ? t + p : t), 0);
  const out = {
    asc: P((a) => a),
    straight: P((a, s) => s),
    sum25: P((a, s, x) => x),
    asc25: P((a, s, x) => a && x),
    straight25: P((a, s, x) => s && x),
    cells: [...cells].map(([k, p]) => ({ asc: k[0] === "1", straight: k[1] === "1", sum25: k[2] === "1", p })),
  };
  caratCache.set(n, out);
  return out;
}
/** carat を読まずに n 個詰めて、合計がちょうど 25 になる確率 */
export function chanceChristmas(n) {
  return chanceCarat(n).sum25;
}

/**
 * 偶然を超えて 1 個そろえるのに、最低でも何回の鑑定が要るか（属性 a、その大きさの箱で偶然そろう確率 p）。
 * 傷と色は「箱の中を全部鑑定する」のが一番安く、n 個読んで n (1 − p) 個ぶん偶然を超えるので 1 / (1 − p)。
 * 一部だけ読む詰め方（j 個読んで残りは運）は、どの j でもこれより高くつく（傷は 0.75 の独立な 2 択、色は k 色の独立な選択）。
 * carat は読んだ値で並べる位置を選ぶ手（9 を後ろに置くなど）があり、2 個箱では 1 / (1 − p) より安く作れるので 1 のまま
 */
export function readsPerExcess(a, p) {
  if (a === "carat" || !(p > 0) || !(p < 1)) return 1;
  return 1 / (1 - p);
}

const colorCount = (colors) => (Array.isArray(colors) ? colors.length : Number(colors) || 1);

// ---- 売上の下限 ----
// 出荷された箱しか見ないラインは、そろった箱を探すための鑑定を数えない。ボーナスのそろった STRAIGHT 箱を数箱だけ作って
// 残りを each_slice にするコードは、ラインが 0 か小さいまま、単価を数箱に集めて「鑑定 1 回あたりの売上」が上限の 3 倍を超えた。
// そこで、偶然ではまずそろわない箱（AUDIT.valueChance）の「売上 − 読まずに詰めたときの期待値」を、JS が同じベルトで作る
// 基準解（属性を 1 回ずつ読む正直な詰め方）の鑑定 1 回あたりの同じ値 × AUDIT.valueCap で割った回数も、ラインの下限にする。
// 読まずに得られる売上（each_slice でも付く分）は数えないので、鑑定 0 の正直なコードのラインは 0 のまま

const COLOR_UNIT = Object.fromEntries(COLORS.map((c) => [c.key, c.unit]));
const baseOf = (ores) => ores.reduce((s, o) => s + o.carat * (COLOR_UNIT[o.color] ?? 1), 0) * ores.length;

/**
 * 属性を読まずに n 個詰めた箱の、ボーナスの倍率の期待値と分散（傷・色・carat は独立）。
 * 昇順 ×2、STRAIGHT ×2^(n−1)（STRAIGHT は昇順に含まれる）、クリスマス便 ×4（carat の合計 25）、無傷 ×3、単色 ×3
 */
export function chanceMultiplier(n, k, bonuses) {
  const has = (b) => bonuses.has(b);
  const parts = [];
  if (has("flawless")) parts.push([BONUSES.flawless.mul, chanceFlawless(n)]);
  if (has("mono")) parts.push([BONUSES.mono.mul, chanceMono(n, k)]);
  let mean = 1;
  let sq = 1;
  for (const [mul, p] of parts) {
    mean *= 1 + (mul - 1) * p;
    sq *= 1 + (mul * mul - 1) * p;
  }
  const a = has("ascending") ? BONUSES.ascending.mul : 1;
  const s = has("straight") ? 2 ** (n - 1) : 1;
  if (has("christmas")) {
    // 合計 25 は昇順・STRAIGHT と独立ではないので、carat の 3 つは同時確率で数える
    const c = BONUSES.christmas.mul;
    let m = 0;
    let q = 0;
    for (const cell of chanceCarat(n).cells) {
      const x = (cell.asc ? a : 1) * (cell.straight ? s : 1) * (cell.sum25 ? c : 1);
      m += cell.p * x;
      q += cell.p * x * x;
    }
    mean *= m;
    sq *= q;
    return { mean, variance: Math.max(0, sq - mean * mean) };
  }
  const pA = has("ascending") ? chanceAscending(n) : 0;
  const pS = has("straight") ? chanceStraight(n) : 0;
  mean *= 1 + (a - 1) * pA + a * (s - 1) * pS;
  sq *= 1 + (a * a - 1) * pA + a * a * (s * s - 1) * pS;
  return { mean, variance: Math.max(0, sq - mean * mean) };
}

/**
 * 箱に付いたボーナスの組み合わせが、属性を読まずに偶然そろう確率（STRAIGHT は昇順に含めて STRAIGHT の確率だけ）。
 * クリスマス便が付いた箱は、carat の側を「合計 25 かつ（STRAIGHT・昇順）」の同時確率にする
 */
export function crateChance(keys, n, k) {
  let p = 1;
  if (keys.has("flawless")) p *= chanceFlawless(n);
  if (keys.has("mono")) p *= chanceMono(n, k);
  if (keys.has("christmas")) {
    const c = chanceCarat(n);
    p *= keys.has("straight") ? c.straight25 : keys.has("ascending") ? c.asc25 : c.sum25;
  } else if (keys.has("straight")) p *= chanceStraight(n);
  else if (keys.has("ascending")) p *= chanceAscending(n);
  return p;
}

/**
 * 「売上 − 読まずに詰めたときの売上の期待値」を箱ごとに足す。
 * tau を渡すと、ボーナスの組み合わせが偶然そろう見込み（確率 × 同じ大きさの箱の数）が tau 以上の箱は数えない
 * （each_slice でも偶然そろう箱で、ラインが付いたり消えたりしないように）。pol は研磨済みの id（研磨は発熱の分を別に数えるので、
 * 研磨済みを含む箱の無傷は偶然とみなさず、期待値の側にも無傷 ×3 を入れる）
 */
function excessValue(crates, k, bonuses, { tau = Infinity, pol = null } = {}) {
  const count = new Map();
  for (const c of crates) count.set(c.ores.length, (count.get(c.ores.length) ?? 0) + 1);
  let total = 0;
  for (const c of crates) {
    const n = c.ores.length;
    const keys = new Set((c.bonuses ?? []).map((b) => b.key));
    let { mean } = chanceMultiplier(n, k, bonuses);
    if (pol && keys.has("flawless") && c.ores.some((o) => pol.has(o.id))) {
      keys.delete("flawless");
      mean = (mean / (1 + (BONUSES.flawless.mul - 1) * chanceFlawless(n))) * BONUSES.flawless.mul;
    }
    if (crateChance(keys, n, k) * count.get(n) >= tau) continue;
    const x = c.value - baseOf(c.ores) * mean;
    total += tau === Infinity ? x : Math.max(0, x);
  }
  return Math.max(0, total);
}

/**
 * 基準解で取る carat の並び（窓）を、取る順に返す。
 * クリスマス便がなければ前と同じく長いストレートから、同じ長さは carat の大きい窓から（これは箱の値段の順と同じ）。
 * クリスマス便があれば、長さ 3〜box の窓と、合計 25 の組み合わせ（1 ずつ続かなくてもよい。昇順に並べる）を、箱の値段の高い順に並べる。
 * strategy: "length" はクリスマス便を見ない前の順（クリスマス便があっても、比べるために使う）
 */
const runsCache = new Map();
function referenceRuns(box, { straight, christmas, strategy = "worth" }) {
  const key = `${box}|${+straight}|${+christmas}|${strategy}`;
  if (runsCache.has(key)) return runsCache.get(key);
  const top = Math.min(box, CARAT_KINDS);
  const windows = [];
  if (straight) {
    for (let n = top; n >= 3; n--) {
      for (let lo = CARAT_KINDS - n + 1; lo >= 1; lo--) windows.push(Array.from({ length: n }, (_, d) => lo + d));
    }
  }
  let runs = windows;
  if (christmas && strategy === "worth") {
    const target = BONUSES.christmas.sum;
    const isStraight = (r) => r.every((c, i) => i === 0 || c === r[i - 1] + 1);
    const gifts = [];
    // 合計 25 の昇順の組み合わせ（repeated_combination で select { it.sum == 25 } したもの）
    const walk = (left, from, acc) => {
      if (acc.length >= 3 && left === 0) {
        if (!(straight && isStraight(acc))) gifts.push([...acc]);
      }
      if (acc.length >= top || left <= 0) return;
      for (let c = from; c <= Math.min(CARAT_KINDS, left); c++) walk(left - c, c, [...acc, c]);
    };
    walk(target, 1, []);
    const worth = (r) => {
      const sum = r.reduce((t, c) => t + c, 0);
      return sum * r.length * (straight && r.length >= 3 && isStraight(r) ? 2 ** (r.length - 1) : 1) * (sum === target ? BONUSES.christmas.mul : 1);
    };
    // 同じ値段なら前の順（sort は安定）
    runs = [...windows, ...gifts].map((r) => [r, worth(r)]).sort((x, y) => y[1] - x[1]).map(([r]) => r);
  }
  runsCache.set(key, runs);
  return runs;
}

/**
 * 基準解: 属性を 1 回ずつ読む正直な詰め方を JS で作り、箱と鑑定の回数を返す（演出ではなく上限の物差し）。
 * 無傷のボーナスが解禁済みなら傷を全部読んで無傷だけを使い、色ごと（単色が解禁済みで 2 色以上）に分け、
 * STRAIGHT が解禁済みなら referenceRuns の順に窓を取り（クリスマス便があれば合計 25 の箱も）、
 * 残りを carat 順（昇順が解禁済みなら）に box 個ずつ。傷ありは読まずに box 個ずつ。
 * polishAll のときは flaw を読まずに全部磨いた形にする（傷物も窓に使う。研磨の熱は監査の側で別に足すので、ここでは数えない）
 */
export function referencePack(belt, { box, colors = 1, bonuses, strategy = "worth", polishAll = false }) {
  const k = colorCount(colors);
  const has = (b) => bonuses.has(b);
  let reads = 0;
  let good = belt;
  let bad = [];
  if (has("flawless") && !polishAll) {
    reads += belt.length;
    good = belt.filter((o) => !o.flaw);
    bad = belt.filter((o) => o.flaw);
  }
  const byColor = has("mono") && k > 1;
  if (byColor) reads += good.length;
  const readCarat = has("ascending") || has("straight") || has("christmas");
  if (readCarat) reads += good.length;
  const groups = new Map();
  for (const o of good) {
    const key = byColor ? o.color : "_";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const crates = [];
  const slice = (ores) => {
    for (let i = 0; i < ores.length; i += box) crates.push(ores.slice(i, i + box));
  };
  const runs = (has("straight") || has("christmas")) && box >= 3
    ? referenceRuns(box, { straight: has("straight"), christmas: has("christmas"), strategy })
    : [];
  // 単価の高い色から
  const order = [...groups.entries()].sort((x, y) => (COLOR_UNIT[y[0]] ?? 0) - (COLOR_UNIT[x[0]] ?? 0));
  for (const [, g] of order) {
    let rest = g;
    if (runs.length > 0) {
      const pool = new Map();
      for (const o of g) (pool.get(o.carat) ?? pool.set(o.carat, []).get(o.carat)).push(o);
      for (const run of runs) {
        const need = new Map();
        for (const c of run) need.set(c, (need.get(c) ?? 0) + 1);
        while ([...need].every(([c, m]) => (pool.get(c)?.length ?? 0) >= m)) crates.push(run.map((c) => pool.get(c).pop()));
      }
      rest = [...pool.values()].flat();
    }
    slice(readCarat ? [...rest].sort((x, y) => x.carat - y.carat) : rest);
  }
  slice(bad);
  return { crates, reads };
}

/**
 * 基準解の「鑑定 1 回あたりの、偶然を超えたボーナスの売上」。解禁済みのボーナスがなければ 0。
 * クリスマス便があるときは、値段順の基準解と前の順の基準解の大きい方（どちらが稼ぐかはベルト次第なので、正直なコードに甘い方を使う）。
 * polish のとき（研磨済みの原石を出荷したバッチ）は、flaw を読まずに全部磨く基準解とも比べる。flaw を 512 回読む代わりに熱を払うコードは、
 * 属性の鑑定が少ないのに全部の原石で窓を作れるので、flaw を読む基準解だけだと箱 9 で売上の下限が実測を超え、裏口を使っていないのに監査にかかった（tests/audit.test.mjs の POLISH_BLIND）
 */
export function referenceValuePerRead(belt, { box, colors = 1, bonuses, polish = false }) {
  if (!belt?.length || !bonuses?.size) return 0;
  const k = colorCount(colors);
  const strategies = bonuses.has("christmas") && bonuses.has("straight") ? ["worth", "length"] : ["worth"];
  let best = 0;
  for (const polishAll of polish ? [false, true] : [false]) {
    const pol = polishAll ? new Set(belt.filter((o) => o.flaw).map((o) => o.id)) : null;
    for (const strategy of strategies) {
      const { crates, reads } = referencePack(belt, { box, colors, bonuses, strategy, polishAll });
      if (!(reads > 0)) continue;
      const priced = crates.map((ores) => {
        const r = crateValue(ores, { box, bonuses, polished: pol ?? new Set(), polish: polishAll });
        return { ores, value: r.value, bonuses: r.bonuses };
      });
      best = Math.max(best, excessValue(priced, k, bonuses, { pol }) / reads);
    }
  }
  return best;
}
const ATTRS = ["carat", "flaw", "color"];

/** 研磨機の発熱。1 バッチで k 個磨くと、研磨の鑑定は少なくとも 1 + 2 + … + k 回 */
export const polishFloor = (k) => (k > 0 ? (k * (k + 1)) / 2 : 0);
// 監査報告の「偶然なら ◯ 箱」に使う根拠。最小の箱の大きさ未満はボーナスが偶然でも付きやすいので根拠にしない
const EVIDENCE = [
  { bonus: "straight", attr: "carat", min: 3 },
  { bonus: "ascending", attr: "carat", min: 2 },
  { bonus: "mono", attr: "color", min: 2 },
  { bonus: "flawless", attr: "flaw", min: 2 },
];

/**
 * 監査ライン。priced は price.priceBatch の結果、polished は BatchResult.polished（研磨済みの id）。
 * colors は解禁済みの色の配列（derive().colors）か色の数。box はいまの箱サイズ。
 *
 * 観測と期待（偶然そろう分）は、箱の大きさごとに分けて差を取り、マイナスは 0 にしてから足す。
 * ボーナスの付かない箱（2 個箱や 1 個箱）を足しても、別の大きさの箱の「余裕」は増えない
 * （ボーナスの付かない箱を足して期待値をふくらませ、ラインを 0 まで下げるコードへの対策）
 */
export function auditFloor(priced, polished, { colors = 1, box = 1, slack = AUDIT.slack, lucky = AUDIT.lucky, z = AUDIT.z, weigh = AUDIT.weigh, valueCap = AUDIT.valueCap, valueChance = AUDIT.valueChance, belt = null, bonuses = null } = {}) {
  const k = colorCount(colors);
  // 1 鉱石あたりにする分母はベルトの原石数（shipped + scrap）。欠けていたら 512
  const len = (priced?.shippedOres ?? 0) + (priced?.scrapOres ?? 0) || BATCH_SIZE;
  // 研磨済みとして数えるのは、値付けでも研磨済みに扱われた id（priceBatch は研磨機の研究前なら [] にする）。
  // 研究前に Yield.polished を直に呼んでも得はないので、ラインにも足さない
  const pol = new Set(Array.isArray(priced?.polished) ? priced.polished : polished ?? []);
  const observed = { carat: 0, flaw: 0, color: 0 };
  const expected = { carat: 0, flaw: 0, color: 0 };
  // 箱の大きさごとの観測・期待・ばらつき（属性ごと）。
  // ばらつき（分散、鑑定の回数に直したもの）は箱ごとに「w 個そろうか 0 か」の 2 択なので m² w² p (1 − p) を足す。
  // 分散も層ごとに持つ。全部の層で 1 つに合算すると、ボーナスの付かない 2 個箱を足すだけで σ が増え、
  // 長い箱の層の超過がその余裕に食われた（上位の箱だけ出して残りを 2 個箱で埋めるコードで起きた）
  const strata = { carat: new Map(), flaw: new Map(), color: new Map() };
  // m は「偶然を超えた 1 個」を作るのに要る鑑定の回数（weigh のときだけ。readsPerExcess）
  const add = (a, key, obs, exp, w, p) => {
    observed[a] += obs;
    expected[a] += exp;
    const m = weigh ? readsPerExcess(a, p) : 1;
    const s = strata[a].get(key) ?? { obs: 0, exp: 0, m, variance: 0 };
    s.obs += obs;
    s.exp += exp;
    s.variance += m * m * w * w * p * (1 - p);
    strata[a].set(key, s);
  };
  // worst の表示用: ボーナスごとの箱数と、偶然そろう箱数の期待値
  const evid = Object.fromEntries(EVIDENCE.map((e) => [e.bonus, { crates: 0, chance: 0 }]));
  let polishShipped = 0;
  for (const c of priced?.crates ?? []) {
    if (!c.valid) continue;
    const n = c.ores.length;
    const keys = new Set((c.bonuses ?? []).map((b) => b.key));
    const unpol = c.ores.filter((o) => !pol.has(o.id)).length;
    polishShipped += n - unpol;
    // 層は「箱の大きさ × ほかの 2 属性のボーナスの有無」で分ける。ボーナスの付かない同じ大きさの箱（each_slice など）を
    // 足しても、ボーナスのそろった数箱の層には混ざらない（層を分けないと、同じ大きさの箱で薄めたときに傷の σ が膨らんで超過が消えた）。
    // 読んでいない属性はほかの属性と独立なので、偶然そろう確率 p はどの層でも同じ
    const asc = keys.has("ascending") || keys.has("straight");
    const flawless = keys.has("flawless");
    const mono = keys.has("mono");
    // 昇順とストレートの両方が付いた箱でも carat は 1 回分しか数えない
    add("carat", `${n}|${+mono}${+flawless}`, asc ? n : 0, n * chanceAscending(n), n, chanceAscending(n));
    add("flaw", `${n}|${+asc}${+mono}`, flawless ? unpol : 0, unpol * chanceFlawless(n), unpol, chanceFlawless(n));
    if (k > 1) add("color", `${n}|${+asc}${+flawless}`, mono ? n : 0, n * chanceMono(n, k), n, chanceMono(n, k));
    const chanceOf = {
      straight: chanceStraight(n),
      ascending: chanceAscending(n),
      mono: k > 1 ? chanceMono(n, k) : 0,
      flawless: unpol > 0 ? chanceFlawless(n) : 0,
    };
    for (const e of EVIDENCE) {
      if (n < e.min || chanceOf[e.bonus] === 0) continue;
      evid[e.bonus].chance += chanceOf[e.bonus];
      if (keys.has(e.bonus)) evid[e.bonus].crates++;
    }
  }
  // 層ごとに「超過 − z σ」を 0 で切ってから足す。どの大きさの箱を足しても、ほかの層の超過は減らない
  const over = {};
  for (const a of ATTRS) {
    over[a] = 0;
    for (const s of strata[a].values()) over[a] += Math.max(0, s.m * (s.obs - slack * s.exp) - z * Math.sqrt(s.variance));
  }
  // 端数の箱などの余裕（lucky × box）は、属性ごとではなく全体で 1 回だけ引く。属性ごとに引くと箱 9 で 81 回がただになり、
  // 上位の数箱だけ出すコードではその分がまるごと得になった。
  // 超過の小さい属性から引く（監査報告の根拠には、超過が残った大きい属性のボーナスを出したいので）
  const excess = { carat: over.carat, flaw: over.flaw, color: over.color };
  let free = lucky * box;
  for (const a of [...ATTRS].sort((x, y) => over[x] - over[y])) {
    const take = Math.min(free, excess[a]);
    excess[a] -= take;
    free -= take;
  }
  // 鑑定を読まないコード（each_slice・1 個ずつ）でも、まれに偶然のばらつきが余裕を超える（200 バッチに 1〜2 本、0.05 回/鉱石未満）。
  // 見抜かれたかの判定と同じ minFloorPerOre より小さいラインは 0 にする（ボーナスがほぼ偶然どまりのコードはラインが 0）
  const raw = excess.carat + excess.flaw + excess.color;
  const attrReads = raw / len >= AUDIT.minFloorPerOre ? raw : 0;
  // 売上の下限は、偶然を超えたボーナスの売上 ÷（基準解の鑑定 1 回あたりのボーナスの売上 × valueCap）
  const allOres = belt ?? priced?.[PRICED_BELT] ?? null;
  const bonusSet = bonuses ?? priced?.[PRICED_BONUSES] ?? null;
  let valueReads = 0;
  let refValuePerRead = 0;
  if (allOres?.length && bonusSet?.size && valueCap > 0) {
    refValuePerRead = referenceValuePerRead(allOres, { box, colors: k, bonuses: bonusSet, polish: pol.size > 0 });
    if (refValuePerRead > 0) {
      const shipped = (priced?.crates ?? []).filter((c) => c.valid && c.ores?.length);
      valueReads = excessValue(shipped, k, bonusSet, { tau: valueChance, pol }) / (valueCap * refValuePerRead);
      // 鑑定 0 のコードでも、まれに偶然そろった箱が 1 つ数えられる（2,000 バッチに数本、0.0002 回/鉱石以下）。
      // 工場が ∞ と有限を行き来しないように、ごく小さい値は 0 にする（STRAIGHT を 1 箱だけそろえるコードでも 0.02 回/鉱石以上）
      if (valueReads / len < AUDIT.valueMinPerOre) valueReads = 0;
    }
  }
  const reads = Math.max(attrReads, valueReads);
  // 研磨の下限は、出荷された研磨済みの原石の数 k から 1 + 2 + … + k。@heat を書き換えて冷やしても、磨いた数は箱に残る
  const polishOps = polishFloor(polishShipped);
  const floorOps = reads + polishOps;
  // 根拠は、ラインに効いた属性のボーナスのうち、偶然の期待値に対して一番多く出たもの（STRAIGHT や長い昇順を優先して選べる）
  // 売上の下限がラインを決めたとき（数箱だけそろえるコード）は、属性の超過が 0 でも、偶然より多く出たボーナスを 1 箱から根拠にする
  const valueLed = valueReads > attrReads;
  let worst = null;
  let best = 0;
  for (const e of EVIDENCE) {
    if (!(reads > 0)) continue;
    if (!valueLed && !(excess[e.attr] > 0)) continue;
    const { crates, chance } = evid[e.bonus];
    if (crates < (valueLed ? 1 : 3) || (valueLed && crates < chance + 1)) continue;
    const score = crates / (chance + 1);
    if (score > best) {
      best = score;
      worst = { bonus: e.bonus, crates, chanceCrates: chance };
    }
  }
  return {
    floorOps,
    floorPerOre: floorOps / len,
    reads,
    attrReads,
    valueReads,
    refValuePerRead,
    polishShipped,
    polishOps,
    observed,
    expected,
    excess,
    worst,
  };
}

/** priced の opsPerOre を max(実測, ライン) に置き換えたコピーを返す。measuredOps / measuredOpsPerOre と audit を足す */
export function auditPriced(priced, polished, opts = {}) {
  const audit = auditFloor(priced, polished, opts);
  const measuredOps = Number.isFinite(priced?.ops) && priced.ops > 0 ? priced.ops : 0;
  // 研磨機を冷やしたバッチ（opts.cooled。Ruby の Yield.cooled?）は、磨いた k 回が 1 回 1 鑑定まで安くなっている。
  // 実測から k を引いて 1 + 2 + … + k を足した回数をラインの下限にする。全部冷やしたときは、正直に磨いた場合の鑑定とちょうど同じ
  const k = Array.isArray(polished) ? polished.length : 0;
  if (opts.cooled && k > 1) {
    const len = (priced?.shippedOres ?? 0) + (priced?.scrapOres ?? 0) || BATCH_SIZE;
    const reheated = measuredOps - k + polishFloor(k);
    if (reheated > audit.floorOps) {
      audit.floorOps = reheated;
      audit.floorPerOre = reheated / len;
      audit.cooled = true;
    }
  }
  const measuredOpsPerOre = Number.isFinite(priced?.opsPerOre) && priced.opsPerOre > 0 ? priced.opsPerOre : 0;
  const opsPerOre = Math.max(measuredOpsPerOre, audit.floorPerOre);
  const ops = Math.max(measuredOps, audit.floorOps);
  return { ...priced, measuredOps, measuredOpsPerOre, ops, opsPerOre, audit };
}

/**
 * 直近のバッチ（古い順、auditPriced の結果）から、見抜かれたかを決める。直近 AUDIT.window 本の平均で
 * 「実測 < ライン」かつ「ライン ≥ AUDIT.minFloorPerOre」なら caught。
 * worst と audit は直近のバッチのもの（監査報告の「偶然なら ◯ 箱」に使う）
 */
export function auditVerdict(list, { window = AUDIT.window, minFloorPerOre = AUDIT.minFloorPerOre } = {}) {
  const rows = (list ?? []).filter((b) => b && b.ok && b.audit).slice(-window);
  if (rows.length === 0) return { caught: false, measuredPerOre: 0, floorPerOre: 0, batches: 0, worst: null, audit: null };
  const avg = (f) => rows.reduce((s, b) => s + f(b), 0) / rows.length;
  const measuredPerOre = avg((b) => b.measuredOpsPerOre ?? b.opsPerOre ?? 0);
  const floorPerOre = avg((b) => b.audit.floorPerOre);
  const last = rows[rows.length - 1];
  // 直近のバッチでラインが 0 なら、平均で一番超過したバッチの worst を出す
  const withWorst = [...rows].reverse().find((b) => b.audit.worst) ?? last;
  return {
    caught: measuredPerOre < floorPerOre && floorPerOre >= minFloorPerOre,
    measuredPerOre,
    floorPerOre,
    batches: rows.length,
    worst: withWorst.audit.worst,
    audit: last.audit,
  };
}

// ---- 技の推定（演出だけ。上限の根拠にはしない） ----

/** 上から順に当てる。bind_call を先に置く（super_method.bind_call は bind_call と言う） */
export const TECHNIQUES = [
  { key: "bind_call", label: "bind_call", re: /\bbind_call\b/ },
  { key: "super_method", label: "super_method", re: /\bsuper_method\b/ },
  { key: "data_instance_method", label: "Data.instance_method", re: /\bData\s*\.\s*instance_method\b/ },
  { key: "remove_method", label: "remove_method", re: /\bremove_method\b/ },
  { key: "undef_method", label: "undef_method", re: /\bundef_method\b|\bundef\s+:?\w/ },
  { key: "tick", label: "def Yield.tick", re: /\bdef\s+(?:Yield|self)\s*\.\s*tick\b/ },
  { key: "define_singleton_method", label: "define_singleton_method(:tick)", re: /\bdefine_singleton_method\s*\(?\s*:tick\b/ },
  // singleton_class.send(:define_method, :tick) や class << Yield の中の define_method(:tick)
  { key: "tick", label: "define_method(:tick)", re: /\bdefine_method\s*[(,]?\s*:tick\b/ },
  { key: "ivar_ops", label: "instance_variable_set(:@ops)", re: /\binstance_variable_set\s*\(?\s*:@ops\b/ },
  // 研磨機に水をかける。instance_variable_set でも、instance_eval などの中の代入でも
  { key: "heat", label: "instance_variable_set(:@heat)", re: /\binstance_variable_set\s*\(?\s*:@heat\b/ },
  { key: "heat", label: "def Yield.heat_up", re: /\bdef\s+(?:Yield|self)\s*\.\s*heat_up\b|\bdefine_singleton_method\s*\(?\s*:heat_up\b/ },
  // 外から heat_up を先に呼んで @heat を磨いた数より大きくし、数え直させる
  { key: "heat", label: "Yield.heat_up の呼び出し", re: /\bYield\s*\.\s*heat_up\b/ },
  { key: "heat", label: "@heat の書き換え", re: /@heat\b\s*(?:\*\*|<<|>>|\|\||&&|[-+*\/%|&^])?=(?![=~>])/ },
  { key: "tick_alias", label: "alias_method(:tick)", re: /\balias_method\s*\(?\s*:tick\b|\balias\s+:?tick\b/ },
  { key: "prepend", label: "prepend", re: /\bprepend\b/ },
  { key: "object_space", label: "ObjectSpace", re: /\bObjectSpace\b/ },
  { key: "polished", label: "Yield.polished", re: /\bYield\s*\.\s*polished\b/ },
  { key: "refine", label: "refine", re: /\brefine\b/ },
  { key: "marshal", label: "Marshal", re: /\bMarshal\b/ },
];

/**
 * コメントと文字列の中身を空白にする（改行は残すので行番号がずれない）。
 * 文字列の #{...} の中はコードとして残す。ヒアドキュメントや %w などは扱わない（演出なので割り切る）
 */
export function stripCode(code) {
  const src = String(code ?? "");
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (ch) => (ch === "\n" ? "\n" : " ");
  while (i < n) {
    const ch = src[i];
    // =begin ... =end（行頭）
    if (ch === "=" && (i === 0 || src[i - 1] === "\n") && src.startsWith("=begin", i)) {
      const end = src.indexOf("\n=end", i);
      const stop = end < 0 ? n : end + 5;
      for (; i < stop; i++) out += blank(src[i]);
      continue;
    }
    if (ch === "#") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      out += " ";
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) {
          out += " " + blank(src[i + 1]);
          i += 2;
          continue;
        }
        if (q !== "'" && src[i] === "#" && src[i + 1] === "{") {
          // 式展開の中はコード。入れ子の { } を数えて閉じまで残す
          let depth = 0;
          while (i < n) {
            const c = src[i];
            out += c;
            i++;
            if (c === "{") depth++;
            else if (c === "}" && --depth === 0) break;
          }
          continue;
        }
        out += blank(src[i]);
        i++;
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }
    // ?a のような文字リテラルの ?# ?" ?' は文字列やコメントの始まりにしない
    if (ch === "?" && i + 1 < n && "#\"'`".includes(src[i + 1]) && !/[\w)\]}]/.test(src[i - 1] ?? "")) {
      out += "  ";
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 技の推定。当たらなければ null。line は 1 始まり */
export function guessTechnique(code) {
  const stripped = stripCode(code);
  for (const t of TECHNIQUES) {
    const m = t.re.exec(stripped);
    if (!m) continue;
    const line = stripped.slice(0, m.index).split("\n").length;
    return { key: t.key, label: t.label, line };
  }
  return null;
}

// ---- 監査報告の文面（SPEC-rubyist 2.3）。画面では鑑定長の見立てとして出す ----

// 技を当てられなかったときの名前は data/balance.js に置き、main.js からはここ経由でも読めるようにしておく
export { UNKNOWN_TECHNIQUE };

/** 技の名前のあとに助詞を続けるときの形。英字で終わる名前（bind_call など）だけ後ろに空白を入れる */
export const techWord = (label) => `${label}${/[\x21-\x7e]$/.test(label) ? " " : ""}`;

const BONUS_WORD = { ascending: "昇順", straight: "ストレート", flawless: "無傷", mono: "単色", christmas: "クリスマス便" };
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "0.00");
const comma = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * audited は auditVerdict の結果（measuredPerOre・floorPerOre・worst）か auditPriced の結果。
 * technique は guessTechnique の結果（null なら技は「正体不明」）。opsMul（YJIT の ×0.5）を渡すと両方に掛けて出す
 */
export function auditReport({ audited, technique = null, file = "pack.rb", opsMul = 1 } = {}) {
  const a = audited ?? {};
  const measured = (a.measuredPerOre ?? a.measuredOpsPerOre ?? 0) * opsMul;
  const floor = (a.floorPerOre ?? a.audit?.floorPerOre ?? 0) * opsMul;
  const worst = a.worst ?? a.audit?.worst ?? null;
  const polishShipped = a.audit?.polishShipped ?? 0;
  const line = technique?.line ?? 1;
  // 研磨機を冷やしたときは、箱のボーナスではなく研磨の数を根拠にする（足りないのは熱の分なので）
  const cooled = technique?.key === "heat" || technique?.key === "polished";
  let why;
  if (polishShipped > 0 && (cooled || !worst)) {
    why = `研磨済みの原石が ${polishShipped} 個出荷されています。1 + 2 + … + ${polishShipped} = ${comma(polishFloor(polishShipped))} 回の研磨が見当たりません`;
  } else if (worst) {
    const chance = Math.max(0, Math.round(worst.chanceCrates));
    why = `${BONUS_WORD[worst.bonus] ?? worst.bonus}の箱が ${worst.crates} 箱あります（偶然なら ${chance} 箱ほど）`;
  } else {
    why = "出荷された箱の出来がよすぎます";
  }
  const how = technique ? `${technique.label}（${file}:${technique.line}）` : UNKNOWN_TECHNIQUE;
  const named = technique ? `${techWord(technique.label)}ですか。よく見つけましたね` : "どうやったのかは見抜けませんでした";
  const remark = technique?.key === "heat"
    ? "研磨機に水をかけましたね。冷やしても、磨いた数は箱に残っています"
    : `${named}。でも、箱の出来はごまかせません`;
  return [
    `${file}:${line}: warning: 鑑定 ${f2(measured)} 回/鉱石にしては、${why}`,
    `  使った技: ${how}`,
    `  鑑定長「${remark}。鑑定は ${f2(floor)} 回/鉱石で数えておきます」`,
  ].join("\n");
}
