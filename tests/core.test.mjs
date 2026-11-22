import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BELTS, CPUS, DOCKS, INITIAL_CODE, MINES, RESEARCH, SAMPLE_CODE } from "../data/balance.js";
import {
  buy,
  canDeploy,
  canResearch,
  capacities,
  clickMine,
  costOf,
  derive,
  diagnose,
  emaFromBatches,
  flowInfo,
  formatMoney,
  formatNumber,
  formatShortfall,
  researchEffects,
  tick,
  updateRecord,
} from "../src/economy.js";
import { didYouMean, extractMethods, fullwidthHint, suggestFromError, unappliedResearch } from "../src/methods.js";
import { crateValue, crateViews, priceBatch } from "../src/price.js";
import { beltToRubyLiteral, makeBelt, mulberry32 } from "../src/rng.js";
import { initialState, load, save } from "../src/state.js";
import { checkBatchResult } from "../src/ruby/runtime.js";
import { PACKERS, toRubyResult } from "../tools/econ.mjs";
import { clampBackdoor, unitRate } from "../src/economy.js";

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ""} expected ${expected}±${tol}, got ${actual}`);

/** 移植版の pack を複数シードで回した単価の平均 */
function avgValue(packer, { box, colors = ["red"], research }) {
  let sum = 0;
  for (const seed of SEEDS) {
    const belt = makeBelt(seed, { colors });
    sum += priceBatch(belt, toRubyResult(PACKERS[packer](belt, box)), { box, research: new Set(research) }).valuePerOre;
  }
  return sum / SEEDS.length;
}

const upTo = (key) => RESEARCH.slice(0, RESEARCH.findIndex((r) => r.key === key) + 1).map((r) => r.key);

describe("balance", () => {
  it("研究は 15 行で、価格は Gemfile のとおり（クリスマス便はストレートの次）", () => {
    assert.deepEqual(
      RESEARCH.map((r) => [r.key, r.price]),
      [
        ["crate", 50], ["inspector", 400], ["sorter", 150e3], ["sapphire", 300e3], ["monochrome", 20e6],
        ["crate_5", 250e6], ["straight", 2e9], ["christmas", 5e9], ["polish", 70e9], ["emerald", 500e9], ["ractor", 800e9],
        ["crate_7", 15e12], ["yjit", 40e12], ["crate_9", 90e12], ["release", 500e12],
      ],
    );
    assert.equal(RESEARCH.find((r) => r.key === "straight").requires.record, 400);
    assert.equal(RESEARCH.find((r) => r.key === "crate_7").requires.record, 15000);
    assert.equal(RESEARCH.find((r) => r.key === "crate_9").requires.record, 40000);
  });
  it("表の行数", () => {
    assert.equal(MINES.length, 8);
    assert.equal(BELTS.length, 9);
    assert.equal(CPUS.length, 6);
    assert.equal(DOCKS.length, 5);
    assert.match(INITIAL_CODE, /belt\.map \{ \[it\] \}/);
  });
  it("初期コードの説明は ri 早見表への案内 1 行だけ", () => {
    const comments = INITIAL_CODE.split("\n").filter((l) => l.startsWith("#"));
    assert.deepEqual(comments, ["# 説明は上の「ri 早見表」にあります。"]);
    assert.match(INITIAL_CODE, /belt\.map \{ \[it\] \}   # 1 個ずつ箱に詰める/);
  });
});

describe("rng", () => {
  it("mulberry32 は同じシードで同じ列", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i++) assert.equal(a(), b());
  });
  it("makeBelt: carat 1..9、flaw 約 25%、id は 0..511", () => {
    const belt = makeBelt(7, { colors: ["red", "blue", "green"] });
    assert.equal(belt.length, 512);
    assert.deepEqual(belt.map((o) => o.id), [...Array(512).keys()]);
    assert.ok(belt.every((o) => o.carat >= 1 && o.carat <= 9));
    const flaws = belt.filter((o) => o.flaw).length / 512;
    near(flaws, 0.25, 0.06, "flaw 率");
    assert.deepEqual(new Set(belt.map((o) => o.color)), new Set(["red", "blue", "green"]));
  });
  it("beltToRubyLiteral は 10.2 の形", () => {
    const lit = beltToRubyLiteral(
      [{ id: 0, color: "red", carat: 5, flaw: false }, { id: 1, color: "blue", carat: 9, flaw: true }],
      3,
      200000,
    );
    assert.equal(lit, "[3, 200000, [[0,0,5,false],[1,1,9,true]]]");
  });
});

describe("price: SPEC 5.9 の代表値", () => {
  it("初期コード map { [it] } は 5.0 前後", () => {
    near(avgValue("initial", { box: 1, research: [] }), 5.0, 0.25);
  });
  it("each_slice(3) は 15.0 前後", () => {
    near(avgValue("eachSlice", { box: 3, research: upTo("crate") }), 15.0, 0.6);
  });
  it("検品 reject(&:flaw) は 33.3 前後", () => {
    near(avgValue("reject", { box: 3, research: upTo("inspector") }), 33.3, 2);
  });
  it("整列 sort_by は 66.4 前後", () => {
    near(avgValue("sortBy", { box: 3, research: upTo("sorter") }), 66.4, 4);
  });
  it("仕分け group_by は 箱 3 で 298、箱 5 で 495 前後", () => {
    near(avgValue("groupBy", { box: 3, colors: ["red", "blue"], research: upTo("monochrome") }), 298.4, 18);
    near(avgValue("groupBy", { box: 5, colors: ["red", "blue"], research: upTo("crate_5") }), 495.4, 30);
  });
  it("ストレート chunk_while 版は 3,961 前後（シードの揺れが大きいので ±15%）", () => {
    near(avgValue("straightChunk", { box: 5, colors: ["red", "blue"], research: upTo("straight") }), 3961, 600);
  });
});

describe("price: 箱の値段とボーナス", () => {
  const ore = (id, carat, { color = "red", flaw = false } = {}) => ({ id, color, carat, flaw });
  const ALL = new Set(upTo("straight"));

  it("ストレート 5 個は 無傷×3・単色×3・昇順×2・×16 が全部掛かる", () => {
    const ores = [1, 2, 3, 4, 5].map((k, i) => ore(i, k));
    const r = crateValue(ores, { box: 5, research: ALL });
    assert.equal(r.valid, true);
    assert.equal(r.value, 15 * 5 * 3 * 3 * 2 * 16);
    assert.deepEqual(r.bonuses.map((b) => [b.key, b.mul]), [["flawless", 3], ["mono", 3], ["ascending", 2], ["straight", 16]]);
    assert.equal(r.bonuses[3].label, "STRAIGHT ×16");
    assert.equal(r.perfect, true);
  });
  it("ストレートは 3 個以上・1 ずつ増える時だけ。2 個は昇順だけ", () => {
    assert.equal(crateValue([ore(0, 3), ore(1, 4)], { box: 5, research: ALL }).bonuses.some((b) => b.key === "straight"), false);
    const gap = crateValue([ore(0, 1), ore(1, 2), ore(2, 4)], { box: 5, research: ALL });
    assert.deepEqual(gap.bonuses.map((b) => b.key), ["flawless", "mono", "ascending"]);
    const s3 = crateValue([ore(0, 7), ore(1, 8), ore(2, 9)], { box: 3, research: ALL });
    assert.equal(s3.value, 24 * 3 * 3 * 3 * 2 * 4);
  });
  it("研究していないボーナスは掛けない", () => {
    const ores = [1, 2, 3].map((k, i) => ore(i, k));
    const r = crateValue(ores, { box: 3, research: new Set(["crate"]) });
    assert.equal(r.value, 6 * 3);
    assert.deepEqual(r.bonuses, []);
  });
  it("色単価: 青 2、緑 4。色が混ざると単色は付かない", () => {
    const r = crateValue([ore(0, 1, { color: "blue" }), ore(1, 1, { color: "green" })], { box: 3, research: ALL });
    assert.equal(r.bonuses.some((b) => b.key === "mono"), false);
    assert.equal(r.value, (2 + 4) * 2 * 3 * 2);
  });
  it("クリスマス便: 3,4,5,6,7 は ストレート ×16 とクリスマス便 ×4 が重なる", () => {
    const XMAS = new Set(upTo("christmas"));
    assert.ok(XMAS.has("straight") && XMAS.has("christmas"));
    const ores = [3, 4, 5, 6, 7].map((k, i) => ore(i, k));
    const r = crateValue(ores, { box: 5, research: XMAS });
    assert.equal(r.value, 25 * 5 * 3 * 3 * 2 * 16 * 4);
    assert.deepEqual(r.bonuses.map((b) => [b.key, b.mul]), [["flawless", 3], ["mono", 3], ["ascending", 2], ["straight", 16], ["christmas", 4]]);
    assert.equal(r.bonuses[4].label, "クリスマス便 ×4");
    // 金の箱（perfect）は無傷・単色・昇順・STRAIGHT の 4 つで決める。クリスマス便がなくても金のまま
    assert.equal(r.perfect, true);
    assert.equal(crateValue([1, 2, 3, 4, 5].map((k, i) => ore(i, k)), { box: 5, research: XMAS }).perfect, true);
    // 研究前は付かない
    assert.equal(crateValue(ores, { box: 5, research: ALL }).bonuses.some((b) => b.key === "christmas"), false);
  });
  it("クリスマス便: 5,5,5,5,5 は付き、ストレートは付かない。合計 24・26 には付かない", () => {
    const XMAS = new Set(upTo("christmas"));
    const fives = crateValue([5, 5, 5, 5, 5].map((k, i) => ore(i, k)), { box: 5, research: XMAS });
    assert.deepEqual(fives.bonuses.map((b) => b.key), ["flawless", "mono", "ascending", "christmas"]);
    assert.equal(fives.value, 25 * 5 * 3 * 3 * 2 * 4);
    assert.equal(fives.perfect, false);
    // 並び順や色・傷はクリスマス便に関係ない
    const mixed = crateValue([ore(0, 9), ore(1, 1, { color: "blue", flaw: true }), ore(2, 8), ore(3, 7)], { box: 5, research: XMAS });
    assert.deepEqual(mixed.bonuses.map((b) => b.key), ["christmas"]);
    assert.equal(mixed.value, (9 + 2 + 8 + 7) * 4 * 4);
    for (const carats of [[4, 5, 5, 5, 5], [6, 5, 5, 5, 5], [8, 8, 8], [9, 9, 8]]) {
      const r = crateValue(carats.map((k, i) => ore(i, k)), { box: 5, research: XMAS });
      assert.equal(r.bonuses.some((b) => b.key === "christmas"), false, carats.join(","));
    }
    assert.ok(crateValue([7, 9, 9].map((k, i) => ore(i, k)), { box: 3, research: XMAS }).bonuses.some((b) => b.key === "christmas"));
  });
  it("研磨済みは無傷扱い（研磨機を研究しているときだけ）", () => {
    const ores = [ore(0, 1, { flaw: true }), ore(1, 2)];
    const withPolish = new Set([...upTo("polish")]);
    assert.ok(crateValue(ores, { box: 3, research: withPolish, polished: new Set([0]) }).bonuses.some((b) => b.key === "flawless"));
    assert.ok(!crateValue(ores, { box: 3, research: withPolish, polished: new Set() }).bonuses.some((b) => b.key === "flawless"));
    assert.ok(!crateValue(ores, { box: 3, research: ALL, polished: new Set([0]) }).bonuses.some((b) => b.key === "flawless"));
  });
});

describe("price: 検算", () => {
  const belt = makeBelt(1);
  const research = new Set(upTo("crate"));
  const run = (crates, extra = {}) => priceBatch(belt, { ok: true, ops: 0, polished: [], crates, log: "", ...extra }, { box: 3, research });

  it("複製: [belt.first(3)] * 1000 は最初の 1 箱だけ有効で、差分メッセージが出る", () => {
    const p = run(Array.from({ length: 1000 }, () => [0, 1, 2]));
    assert.equal(p.validCrates, 1);
    assert.equal(p.crates.filter((c) => c.reason === "duplicate").length, 999);
    assert.equal(p.value, crateValue(belt.slice(0, 3), { box: 3, research }).value);
    assert.ok(p.issues.includes("id 0, 1, 2 が 1000 回出荷されています。複製は無効です"), p.issues.join("\n"));
    assert.equal(p.shippedOres, 3);
    assert.equal(p.scrapOres, 509);
  });
  it("同じ箱の中の重複も無効", () => {
    const p = run([[5, 5]]);
    assert.equal(p.validCrates, 0);
    assert.equal(p.crates[0].reason, "duplicate");
  });
  it("はみ出し: box を超える箱は無効", () => {
    const p = run([[0, 1, 2, 3], [4, 5, 6]]);
    assert.equal(p.crates[0].valid, false);
    assert.equal(p.crates[0].reason, "overflow");
    assert.equal(p.validCrates, 1);
    assert.ok(p.issues.some((m) => m.includes("はみ出し")));
  });
  it("Ore 以外（-1）が入った箱は無効", () => {
    const p = run([[-1, -1, -1], [0, 1]]);
    assert.equal(p.crates[0].reason, "not-ore");
    assert.ok(p.issues.includes("Ore 以外が 3 個入っています"));
    assert.equal(p.ok, true);
  });
  it("空箱は無効", () => {
    const p = run([[], [0]]);
    assert.equal(p.crates[0].reason, "empty");
    assert.ok(p.issues.some((m) => m.includes("空の箱")));
  });
  it("ベルトにない id は無効", () => {
    const p = run([[9999]]);
    assert.equal(p.crates[0].reason, "not-ore");
    assert.ok(p.issues.some((m) => m.includes("ベルトにない id")));
  });
  it("配列の配列以外（全部 [-2]）は ok: false でバッチ全部スクラップ", () => {
    const p = run(Array.from({ length: 512 }, () => [-2]));
    assert.equal(p.ok, false);
    assert.equal(p.value, 0);
    assert.equal(p.scrapOres, 512);
    assert.equal(p.issues.length, 1);
  });
  it("Ore 以外を 1 個ずつ箱に入れた（全部 [-1]）のは配列の配列なので ok: true の検品エラー", () => {
    const p = run(Array.from({ length: 512 }, () => [-1]));
    assert.equal(p.ok, true);
    assert.equal(p.validCrates, 0);
    assert.ok(p.issues.includes("Ore 以外が 512 個入っています"), p.issues.join("\n"));
  });
  it("空の配列を返すと全部スクラップで、検品エラーの差分が出る", () => {
    const p = run([]);
    assert.equal(p.ok, true);
    assert.equal(p.value, 0);
    assert.equal(p.scrapOres, 512);
    assert.ok(p.issues.some((m) => m.includes("空の配列")), p.issues.join("\n"));
  });
  it("有効な箱が 0 なら、それも差分に出す", () => {
    const p = run([[0, 1, 2, 3]]);
    assert.ok(p.issues.some((m) => m.includes("有効な箱が 1 つもありません")), p.issues.join("\n"));
  });
  it("Ruby 側で箱を切ったときは、返された箱の数を差分に出す", () => {
    const p = run([[0, 1, 2], [0, 1, 2]], { crateCount: 300000 });
    assert.ok(p.issues.some((m) => m.includes("300000")), p.issues.join("\n"));
  });
  it("Ruby が失敗したら同じ形の空の結果", () => {
    const p = priceBatch(belt, { ok: false, ops: 200001, errClass: "Yield::Overheat", message: "", line: 2, log: "" }, { box: 3, research });
    assert.equal(p.ok, false);
    assert.deepEqual(p.crates, []);
    assert.equal(p.scrapOres, 512);
    assert.equal(p.ops, 200001);
  });
  it("値を書き換えても JS 側のデータで値付けする（with(carat: 99) と同じ id）", () => {
    const p = run([[0]]);
    assert.equal(p.value, belt[0].carat * 1);
  });
  it("valuePerOre はスクラップ込み、cratesPerOre は有効な箱だけ", () => {
    const p = run([[0, 1, 2], [3, 4, 5, 6]]);
    assert.equal(p.valuePerOre, p.value / 512);
    assert.equal(p.cratesPerOre, 1 / 512);
  });
  it("crateViews は有効な箱だけを簡易版にする", () => {
    const p = run([[0, 1, 2], [0], [3]]);
    const views = crateViews(p);
    assert.equal(views.length, 2);
    assert.deepEqual(Object.keys(views[0].cells[0]).sort(), ["carat", "color", "flaw", "polished"]);
  });
});

describe("economy", () => {
  it("costOf: つるはしは最初の 1 本を数えない（10 / 11.5 / 13.2 / 15.2）", () => {
    assert.equal(costOf(MINES, "pickaxe", 1), 10);
    near(costOf(MINES, "pickaxe", 2), 11.5, 0.01);
    near(costOf(MINES, "pickaxe", 3), 13.225, 0.01);
    near(costOf(MINES, "pickaxe", 4), 15.209, 0.01);
    assert.equal(costOf(CPUS, "server", 0), 7500);
    near(costOf(CPUS, "server", 1), 8625, 0.01);
  });
  it("buy は costOf と同じ値段を引く", () => {
    const s = initialState(0);
    s.money = 100;
    const r = buy(s, "mine", "pickaxe");
    assert.equal(r.ok, true);
    assert.equal(s.money, 90);
    assert.equal(s.mines.pickaxe, 2);
    assert.equal(buy(s, "belt").ok, false);
    s.money = 500;
    assert.equal(buy(s, "belt").ok, true);
    assert.equal(s.belt, 1);
  });
  it("素通し中は工場とドックが無制限、単価 $1", () => {
    const s = initialState(0);
    const caps = capacities(s);
    assert.equal(caps.refinery, Infinity);
    assert.equal(caps.dock, Infinity);
    const fi = flowInfo(s);
    assert.equal(fi.bottleneck, "mine");
    assert.equal(fi.incomePerSec, 0.5);
  });
  it("初回デプロイ直後（つるはし 5 本・map { [it] }）はドックが赤い", () => {
    const s = initialState(0);
    s.mines.pickaxe = 5;
    s.deployed = true;
    s.ema = { valuePerOre: 5, opsPerOre: 0, cratesPerOre: 1 };
    const fi = flowInfo(s);
    assert.equal(fi.bottleneck, "dock");
    assert.equal(fi.flow, 2);
    assert.equal(fi.incomePerSec, 10);
    assert.equal(fi.backlogRate, 0.5);
  });
  it("ボトルネックは同率なら下流を優先", () => {
    const s = initialState(0);
    s.deployed = true;
    s.mines.pickaxe = 16; // 8 個/秒 = 黄ベルト
    s.ema = { valuePerOre: 1, opsPerOre: 0, cratesPerOre: 0 };
    assert.equal(flowInfo(s).bottleneck, "belt");
    s.ema = { valuePerOre: 1, opsPerOre: 1.25, cratesPerOre: 0.25 }; // CPU 10 / 1.25 = 8、ドック 2 / 0.25 = 8
    assert.equal(flowInfo(s).bottleneck, "dock");
  });
  it("Ractor は CPU ×4、YJIT は鑑定 ×0.5（capacities で 1 回だけ掛ける）", () => {
    const s = initialState(0);
    s.deployed = true;
    s.mines.planet = 10;
    s.belt = 8;
    s.ema = { valuePerOre: 1, opsPerOre: 2, cratesPerOre: 0 };
    assert.equal(capacities(s).refinery, 5);
    s.research = upTo("ractor");
    assert.equal(capacities(s).refinery, 20);
    s.research = upTo("yjit");
    assert.equal(capacities(s).refinery, 40);
  });
  it("derive / researchEffects", () => {
    const d = derive({ research: upTo("emerald") });
    assert.equal(d.box, 5);
    assert.deepEqual(d.colors, ["red", "blue", "green"]);
    assert.deepEqual([...d.bonuses].sort(), ["ascending", "christmas", "flawless", "mono", "straight"]);
    assert.equal(d.polish, true);
    assert.equal(d.nextResearch.key, "ractor");
    assert.equal(researchEffects([]).box, 1);
    assert.equal(derive({ research: upTo("release") }).ended, true);
  });
  it("canResearch: 順番・単価記録・お金", () => {
    const s = initialState(0);
    s.money = 1e10;
    assert.equal(canResearch(s, "inspector").missing, "order");
    assert.equal(canResearch(s, "crate").ok, true);
    s.research = upTo("crate_5");
    s.record = 300;
    const r = canResearch(s, "straight");
    assert.equal(r.missing, "record");
    assert.match(r.reason, /\$400/);
    s.record = 495;
    assert.equal(canResearch(s, "straight").ok, true);
    s.money = 0;
    assert.equal(canResearch(s, "straight").missing, "money");
  });
  it("canDeploy: VM とつるはし 5 本", () => {
    const s = initialState(0);
    assert.equal(canDeploy(s, false).ok, false);
    const r = canDeploy(s, true);
    assert.equal(r.ok, false);
    assert.equal(r.remaining, 4);
    assert.match(r.reason, /あと 4 本/);
    s.mines.pickaxe = 5;
    assert.equal(canDeploy(s, true).ok, true);
  });
  it("clickMine はラインの外で即入金。素通し中は $1、デプロイ後は単価", () => {
    const s = initialState(0);
    assert.equal(clickMine(s).earned, 1);
    assert.equal(s.money, 1);
    assert.ok(s.clickRate > 0);
    const before = flowInfo(s).flow;
    assert.equal(before, 0.5);
    s.deployed = true;
    s.ema = { valuePerOre: 15, opsPerOre: 0, cratesPerOre: 1 / 3 };
    assert.equal(clickMine(s).earned, 15);
  });
  it("clickRate はクリック 1 回/秒で 1 個/秒前後に落ち着き、止めると減る", () => {
    const s = initialState(0);
    for (let i = 0; i < 20; i++) {
      clickMine(s);
      for (let j = 0; j < 10; j++) tick(s, 0.1);
    }
    near(s.clickRate, 1, 0.5);
    for (let j = 0; j < 50; j++) tick(s, 0.1);
    assert.ok(s.clickRate < 0.1);
  });
  it("tick はお金を流量 × 単価 × dt だけ増やす", () => {
    const s = initialState(0);
    s.deployed = true;
    s.mines.pickaxe = 5;
    s.ema = { valuePerOre: 5, opsPerOre: 0, cratesPerOre: 1 };
    const r = tick(s, 0.5);
    assert.equal(r.earned, 5);
    assert.equal(s.money, 5);
  });
  it("diagnose: 工場はお金とコードの両方の試算を出す", () => {
    const s = initialState(0);
    s.deployed = true;
    s.mines.rig = 20;
    s.belt = 3;
    s.cpus.server = 2;
    s.docks.train = 20;
    s.money = 2000;
    s.research = upTo("sorter");
    s.lastGoodCode = "def pack(belt)\n  belt.reject(&:flaw).sort { |a, b| a.carat <=> b.carat }.each_slice(box).to_a\nend\n";
    s.ema = { valuePerOre: 66, opsPerOre: 1.74, cratesPerOre: 0.25 };
    const fi = flowInfo(s);
    assert.equal(fi.bottleneck, "refinery");
    const d = diagnose(s, "refinery");
    assert.match(d.title, /^工場: 処理 121 個\/秒 ／ 流入 601 個\/秒$/);
    assert.match(d.lines[0], /CPU 210 鑑定\/秒 ÷ 鑑定 1.74 回\/鉱石/);
    assert.ok(d.money.length >= 1 && d.money.length <= 2);
    for (const m of d.money) {
      assert.equal(m.kind, "cpu");
      assert.ok(m.incomeGainPct > 0);
    }
    assert.ok(d.code.opsMinusOneGainPct > 100);
    assert.match(d.code.hint, /sort のブロック/);
  });
  it("diagnose: polish の一言は、傷物を全部磨くコードにだけ「穴だけ磨く」を勧める", () => {
    const s = initialState(0);
    s.deployed = true;
    s.research = upTo("polish");
    s.ema = { valuePerOre: 1000, opsPerOre: 6, cratesPerOre: 0.25 };
    s.lastGoodCode = "def pack(belt)\n  belt.map(&:polish).group_by(&:color).values.flat_map { it.sort_by(&:carat).each_slice(box).to_a }\nend\n";
    assert.match(diagnose(s, "refinery").code.hint, /穴を埋める傷物だけ磨く/);
    s.lastGoodCode = "def pack(belt)\n  belt.map { it.flaw ? it.polish : it }.sort_by(&:carat).each_slice(box).to_a\nend\n";
    assert.match(diagnose(s, "refinery").code.hint, /穴を埋める傷物だけ磨く/);
    // ヒントの手本（穴だけ磨く版）には、手本そのものを勧めない
    s.lastGoodCode = SAMPLE_CODE.polishHoles;
    const hint = diagnose(s, "refinery").code.hint;
    assert.match(hint, /n 回目の研磨に鑑定が n 回/);
    assert.doesNotMatch(hint, /穴を埋める傷物だけ磨く/);
  });
  it("diagnose: 移ったボトルネックを返す", () => {
    const s = initialState(0);
    s.deployed = true;
    s.mines.pickaxe = 5;
    s.money = 100;
    s.ema = { valuePerOre: 5, opsPerOre: 0, cratesPerOre: 1 };
    const d = diagnose(s, "dock");
    const truck = d.money.find((m) => m.key === "truck");
    assert.ok(truck);
    assert.equal(truck.cost, 80);
    assert.equal(truck.movesBottleneckTo, "mine");
    near(truck.incomeGainPct, 25, 0.001);
  });
  it("diagnose: 最終段のベルトはお金の選択肢を出さず、次の研究を指す", () => {
    const s = initialState(0);
    s.deployed = true;
    s.belt = BELTS.length - 1;
    s.research = upTo("yjit");
    s.ema = { valuePerOre: 45000, opsPerOre: 6.78, cratesPerOre: 0.3 };
    const d = diagnose(s, "belt");
    assert.equal(d.money.length, 0);
    assert.ok(d.lines.some((l) => /最終段階/.test(l)));
    assert.match(d.code.hint, /次の研究「定量梱包 IV」で単価を上げる/);
    s.research = upTo("crate_9");
    assert.match(diagnose(s, "belt").code.hint, /研究「12\/25 リリース」の \$500T まで貯める/);
  });
  it("emaFromBatches と updateRecord", () => {
    const b = (v) => ({ ok: true, valuePerOre: v, opsPerOre: 1, cratesPerOre: 0.25, shippedOres: 384, scrapOres: 128 });
    const ema = emaFromBatches([b(10), b(20)]);
    near(ema.valuePerOre, 14, 1e-9);
    near(ema.shippedPerOre, 0.75, 1e-9);
    assert.equal(emaFromBatches([]), null);
    const s = initialState(0);
    s.ema = ema;
    assert.equal(updateRecord(s), false); // 素通し中は記録しない
    s.deployed = true;
    assert.equal(updateRecord(s), true);
    assert.equal(s.record, 14);
  });
  it("formatNumber / formatMoney", () => {
    assert.equal(formatMoney(999.9), "$999");
    assert.equal(formatMoney(1500), "$1.5K");
    assert.equal(formatMoney(12.3e6), "$12.3M");
    assert.equal(formatNumber(1.74), "1.74");
    assert.equal(formatNumber(1.23e18), "1.23Qi");
    assert.equal(formatNumber(1.23e21), "1.23e21");
    assert.equal(formatNumber(Infinity), "∞");
  });
});

describe("state", () => {
  const memory = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m };
  };
  it("初期状態", () => {
    const s = initialState(123);
    assert.equal(s.mines.pickaxe, 1);
    assert.equal(s.mines.drill, 0);
    assert.equal(s.deployed, false);
    assert.deepEqual(s.ema, { valuePerOre: 1, opsPerOre: 0, cratesPerOre: 0 });
    assert.equal(s.stats.startedAt, 123);
  });
  it("save → load で戻る。壊れたデータは null", () => {
    const st = memory();
    const s = initialState(0);
    s.money = 1234;
    s.research = ["crate"];
    s.mines.drill = 3;
    s.code = "def pack(belt) = belt.each_slice(box).to_a";
    assert.equal(save(s, st), true);
    const back = load(st);
    assert.equal(back.money, 1234);
    assert.deepEqual(back.research, ["crate"]);
    assert.equal(back.mines.drill, 3);
    assert.equal(back.code, s.code);
    st.m.set("yield-factory/v1", "{broken");
    assert.equal(load(st), null);
    assert.equal(load(null), null);
  });
  it("コード履歴もセーブに入る（リロード後の自動復帰で初期コードまで戻さない）", () => {
    const st = memory();
    const s = initialState(0);
    s.codeHistory = ["def pack(belt) = belt.each_slice(box).to_a", 42];
    assert.equal(save(s, st), true);
    assert.deepEqual(load(st).codeHistory, ["def pack(belt) = belt.each_slice(box).to_a"]);
    assert.deepEqual(initialState(0).codeHistory, []);
  });
  it("新しく始めたときは音を出さない。いまのセーブは音の設定をそのまま引き継ぐ", () => {
    assert.equal(initialState(0).muted, true);
    for (const muted of [false, true]) {
      const st = memory();
      st.m.set("yield-factory/v1", JSON.stringify({ ...initialState(0), muted }));
      assert.equal(load(st).muted, muted);
    }
    const st = memory();
    st.m.set("yield-factory/v1", JSON.stringify({ ...initialState(0), muted: "no" }));
    assert.equal(load(st).muted, true);
  });
  it("クリアした時点の最高単価を保存して読み直す。クリア前の値や壊れた値は捨てる", () => {
    const st = memory();
    const base = initialState(0);
    st.m.set("yield-factory/v1", JSON.stringify({ ...base, record: 9e5, stats: { ...base.stats, clearedAt: 1000, recordAtClear: 1.4e5 } }));
    assert.equal(load(st).stats.recordAtClear, 1.4e5);
    st.m.set("yield-factory/v1", JSON.stringify({ ...base, stats: { ...base.stats, clearedAt: 1000, recordAtClear: "x" } }));
    assert.equal(load(st).stats.recordAtClear, null);
    st.m.set("yield-factory/v1", JSON.stringify({ ...base, stats: { ...base.stats, clearedAt: null, recordAtClear: 1.4e5 } }));
    assert.equal(load(st).stats.recordAtClear, null);
    assert.equal(initialState(0).stats.recordAtClear, null);
    // save から load まで通しても残る
    const s = initialState(0);
    s.stats.clearedAt = 2000;
    s.stats.recordAtClear = 6.07e4;
    s.record = 1.77e5;
    const st2 = memory();
    assert.equal(save(s, st2), true);
    assert.equal(load(st2).stats.recordAtClear, 6.07e4);
  });
  it("名前を変える前のセーブも読める。実績の key と、技を当てられなかったときの文言を読み替える", () => {
    const st = memory();
    const old = {
      ...initialState(0),
      achievements: ["perfect_crime", "night_shift", "no_hardcode"],
      notebook: ["audit", "lanes"],
      notebookFeatures: { audit: "不明（監査が負けました）", lanes: "instance_variable_set" },
    };
    st.m.set("yield-factory/v1", JSON.stringify(old));
    const s = load(st);
    assert.deepEqual(s.achievements, ["unknown_technique", "night_line", "no_hardcode"]);
    assert.deepEqual(s.notebookFeatures, { audit: "正体不明", lanes: "instance_variable_set" });
  });
  it("クリスマス便より前に作ったセーブ（ストレートより先まで研究済み）は、クリスマス便が次の研究として買える", () => {
    const before = ["crate", "inspector", "sorter", "sapphire", "monochrome", "crate_5", "straight", "polish", "emerald", "ractor", "crate_7"];
    const st = memory();
    st.m.set("yield-factory/v1", JSON.stringify({ ...initialState(0), money: 8e9, record: 9000, research: before, deployed: true, code: SAMPLE_CODE.straightChunk }));
    const s = load(st);
    assert.ok(s);
    assert.deepEqual(s.research, before);
    const eff = derive(s);
    assert.equal(eff.nextResearch.key, "christmas");
    assert.equal(eff.box, 7);
    assert.equal(eff.bonuses.has("christmas"), false);
    assert.deepEqual(canResearch(s, "christmas"), { ok: true, reason: null, missing: null });
    // 後ろの研究は、クリスマス便を買うまで買えない（1 本道のまま）
    assert.equal(canResearch(s, "yjit").missing, "order");
    const r = buy(s, "research", "christmas");
    assert.equal(r.ok, true);
    assert.equal(s.money, 8e9 - RESEARCH.find((r) => r.key === "christmas").price);
    assert.equal(derive(s).nextResearch.key, "yjit");
    assert.equal(derive(s).bonuses.has("christmas"), true);
    assert.equal(unappliedResearch(s.research, s.code, RESEARCH)?.key, "christmas");
  });
  it("ストレージが例外を投げても落ちない", () => {
    const bad = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } };
    assert.equal(save(initialState(0), bad), false);
    assert.equal(load(bad), null);
  });

  // 手で書き換えたセーブや壊れたセーブでも、起動直後の refresh で使う derive と flowInfo が例外を投げないこと。
  // 1e999 は JSON.parse で Infinity になる。JSON.stringify では null になってしまうので、生の JSON 文字列で書く
  const loadRaw = (json) => {
    const st = memory();
    st.m.set("yield-factory/v1", json);
    const s = load(st);
    assert.ok(s, json);
    assert.doesNotThrow(() => derive(s), json);
    assert.doesNotThrow(() => flowInfo(s), json);
    return s;
  };
  const base = (extra) => JSON.stringify({ ...initialState(0), deployed: true, ...extra });

  it("壊れた belt は BELTS の添字に丸める", () => {
    for (const [belt, want] of [[-1, 0], [2.5, 2], [99, BELTS.length - 1], ["3", 0], [null, 0]]) {
      const s = loadRaw(base({ belt }));
      assert.equal(s.belt, want, String(belt));
      assert.ok(Number.isInteger(s.belt) && s.belt >= 0 && s.belt < BELTS.length);
      assert.ok(Number.isFinite(flowInfo(s).caps.belt));
    }
    assert.equal(loadRaw(base({}).replace(/"belt":0/, '"belt":1e999')).belt, 0);
  });

  it("設備の台数は 0 以上の整数。つるはしは最初の 1 本より減らない", () => {
    const s = loadRaw(base({ mines: { pickaxe: -5, drill: 2.7, rig: "3" }, cpus: { core: -1 }, docks: { truck: 1.5 } }));
    assert.equal(s.mines.pickaxe, 1);
    assert.equal(s.mines.drill, 2);
    assert.equal(s.mines.rig, 0);
    assert.equal(s.cpus.core, 0);
    assert.equal(s.docks.truck, 1);
    assert.ok(flowInfo(s).incomePerSec >= 0);
    assert.equal(loadRaw(base({ mines: { pickaxe: 0 } })).mines.pickaxe, 1);
    assert.equal(loadRaw(base({ mines: { pickaxe: 12 } })).mines.pickaxe, 12);
  });

  it("ema は 0 以上の有限の数だけ読む。shippedPerOre も有限のときだけ", () => {
    const s = loadRaw(base({ ema: { valuePerOre: -3, opsPerOre: -1, cratesPerOre: 0.5, shippedPerOre: "x" } }));
    assert.equal(s.ema.valuePerOre, initialState(0).ema.valuePerOre);
    assert.equal(s.ema.opsPerOre, 0);
    assert.equal(s.ema.cratesPerOre, 0.5);
    assert.equal("shippedPerOre" in s.ema, false);
    const inf = loadRaw(base({ ema: { valuePerOre: 2, opsPerOre: 1, cratesPerOre: 0.2, shippedPerOre: 0 } }).replace(/"shippedPerOre":0/, '"shippedPerOre":1e999'));
    assert.equal("shippedPerOre" in inf.ema, false);
    assert.equal(loadRaw(base({ ema: { valuePerOre: 2, opsPerOre: 1, cratesPerOre: 0.2, shippedPerOre: 0.8 } })).ema.shippedPerOre, 0.8);
  });

  it("lastCrates は cells と bonuses が配列の箱だけ残す", () => {
    const good = { cells: [{ color: "red", carat: 3, flaw: false, polished: false }], value: 3, bonuses: [{ key: "flawless", label: "無傷" }], perfect: false };
    const s = loadRaw(base({ lastCrates: [null, 5, "x", [], {}, { cells: "x", bonuses: [] }, { cells: [], bonuses: null }, { cells: [null], bonuses: [] }, { cells: [], bonuses: [null] }, good] }));
    assert.deepEqual(s.lastCrates, [good]);
  });

  it("stats は項目ごとに丸める。startedAt は確かめた値のまま", () => {
    const s = loadRaw(base({ stats: { deploys: -2, restarts: "3", shipped: "x", startedAt: "x", clearedAt: "y", bestDeploy: { before: "a" } } }));
    assert.equal(s.stats.deploys, 0);
    assert.equal(s.stats.restarts, 3);
    assert.equal(s.stats.shipped, 0);
    assert.equal(typeof s.stats.startedAt, "number");
    assert.ok(Number.isFinite(s.stats.startedAt));
    assert.equal(s.stats.clearedAt, null);
    assert.equal(s.stats.bestDeploy, null);

    const ok = loadRaw(base({ stats: { deploys: 4.6, restarts: 2, shipped: 123.5, startedAt: 1000, clearedAt: 5000, bestDeploy: { before: "a", after: "b", ratio: 2.5, extra: 1 }, junk: 1 } }));
    assert.deepEqual(ok.stats, { deploys: 4, restarts: 2, shipped: 123.5, bestDeploy: { before: "a", after: "b", ratio: 2.5 }, startedAt: 1000, clearedAt: 5000, recordAtClear: null });

    for (const restarts of ["", " ", null, true, [], "1e999", "abc"]) {
      assert.equal(loadRaw(base({ stats: { restarts } })).stats.restarts, 0, JSON.stringify(restarts));
    }
    assert.equal(loadRaw(base({ stats: { bestDeploy: { before: "a", after: "b", ratio: "2" } } })).stats.bestDeploy, null);
    assert.equal(loadRaw(base({ stats: "x" })).stats.deploys, 0);
  });
});

describe("runtime: Worker の返事の形", () => {
  it("研究の box より長い箱は通す（@box を書き換えた箱は値付けで「はみ出し」にする）。8192 個を超える箱は ProtocolError", () => {
    const maxBox = Math.max(...RESEARCH.map((r) => r.effect?.box ?? 0));
    const ok = { ok: true, ops: 1, polished: [], crates: [Array.from({ length: maxBox + 1 }, (_, i) => i)], crateCount: 1, log: "" };
    assert.equal(checkBatchResult(ok), ok);
    const wide = { ...ok, crates: [Array.from({ length: maxBox * 3 }, (_, i) => i)] };
    assert.equal(checkBatchResult(wide), wide);
    // 箱の数は多くても通す（[belt.first(3)] * 300_000 は値付けで複製として無効にする）
    const many = { ok: true, ops: 1, polished: [], crates: Array.from({ length: 8192 }, () => [0, 1, 2]), crateCount: 300_000, log: "" };
    assert.equal(checkBatchResult(many), many);
    const huge = { ...ok, crates: [Array.from({ length: 8193 }, (_, i) => i)] };
    assert.equal(checkBatchResult(huge).errClass, "ProtocolError");
  });
  it("ok: false の返事は文字列にして長さを切る。行番号は正の整数だけ", () => {
    const fail = { ok: false, ops: 0, errClass: "NoMethodError", message: "x", line: 1, log: "" };
    assert.equal(checkBatchResult(fail), fail);
    const r = checkBatchResult({ ok: false, ops: 0, errClass: "E".repeat(500), message: { toString: () => "m".repeat(2000) }, line: -3, log: "l".repeat(100_000), extra: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.errClass.length, 100);
    assert.equal(r.message.length, 600);
    assert.equal(r.log.length, 4096);
    assert.equal(r.line, null);
    assert.equal(r.extra, 1);
    const empty = checkBatchResult({ ok: false });
    assert.deepEqual([empty.errClass, empty.message, empty.line, empty.log], ["", "", null, ""]);
    assert.equal(checkBatchResult({ ok: false, line: 2.5 }).line, null);
  });
});

describe("methods", () => {
  it("extractMethods: コメントと文字列を除いて出現順", () => {
    const code = `# belt.sort { } はコメント
def pack(belt)
  puts "belt.tally"
  belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a
end
`;
    assert.deepEqual(extractMethods(code), ["reject", "sort_by", "each_slice"]);
    assert.deepEqual(extractMethods(code, { all: true }), ["reject", "flaw", "sort_by", "carat", "each_slice", "to_a"]);
  });
  it("extractMethods: ストレートのコード", () => {
    const code = RESEARCH.find((r) => r.key === "straight").hint.solution;
    // 手本は傷物も色ごとに carat の順で詰めるので、partition・sort_by・each_slice が先に並ぶ
    assert.deepEqual(extractMethods(code), ["partition", "group_by", "values", "flat_map", "sort_by", "each_slice", "filter_map", "pop", "concat", "chunk_while"]);
    assert.ok(extractMethods(RESEARCH.find((r) => r.key === "polish").hint.solution).includes("polish"));
  });
  it("didYouMean", () => {
    assert.equal(didYouMean("slect"), "select");
    assert.equal(didYouMean("sort_bt"), "sort_by");
    assert.equal(didYouMean("each_slise"), "each_slice");
    assert.equal(didYouMean("select"), null);
    assert.equal(didYouMean("zzzzzzzz"), null);
    assert.equal(suggestFromError("undefined method 'slect' for an instance of Array"), "select");
  });
  it("全角スペース・全角括弧を見つける。コメントと文字列の中は無視", () => {
    assert.match(fullwidthHint("def pack(belt)\n  belt.each_slice(box).to_a\u3000\nend\n"), /pack\.rb:2 に全角スペース/);
    assert.match(fullwidthHint("def pack(belt)\n  belt.each_slice（box）.to_a\nend\n"), /全角の括弧/);
    assert.equal(fullwidthHint("# 箱に詰める（3 個ずつ）\ndef pack(belt)\n  puts \"（ok）\"\n  belt.each_slice(box).to_a\nend\n"), null);
  });
  it("unappliedResearch: 買ったのにまだコードで使っていない研究を 1 つ返す", () => {
    const f = (research, code) => unappliedResearch(research, code, RESEARCH)?.key ?? null;
    const sample = (k) => RESEARCH.find((r) => r.key === k).hint.solution;
    assert.equal(f([], INITIAL_CODE), null);
    assert.equal(f(["crate"], INITIAL_CODE), "crate");
    assert.equal(f(["crate"], sample("crate")), null);
    assert.equal(f(["crate", "inspector"], sample("crate")), "inspector");
    // 仕分けを買ったのに group_by を書いていないと、単価記録 $400 の手前で止まる
    assert.equal(f(["crate", "inspector", "sorter", "sapphire", "monochrome", "crate_5"], sample("sorter")), "monochrome");
    // 研磨のコードは reject を使わないが、検品は済んだとみなす
    assert.equal(f(["crate", "inspector", "sorter", "sapphire", "monochrome", "crate_5", "straight", "polish"], sample("polish")), null);
  });
  it("unappliedResearch: ヒントの完成コードは、その研究まで買った時点で「取り入れていない研究」を残さない", () => {
    const keys = RESEARCH.map((r) => r.key);
    for (const def of RESEARCH) {
      const research = keys.slice(0, keys.indexOf(def.key) + 1);
      for (const code of [def.hint?.solution, def.hint?.altSolution]) {
        if (!code || !def.hint.uses?.length) continue;
        assert.equal(unappliedResearch(research, code, RESEARCH)?.key ?? null, null, `${def.key}\n${code}`);
      }
    }
  });
});

describe("表示の丸め", () => {
  it("formatShortfall: 条件にわずかに届かないとき、届いたように見せない", () => {
    assert.equal(formatShortfall(3000, 2996), "$4");
    assert.equal(formatShortfall(30000, 29960), "$40");
    assert.equal(formatShortfall(400, 399.96), "$0.04");
    assert.equal(formatShortfall(400, 500), "$0");
  });
  it("canResearch の理由に、あといくら足りないかを出す", () => {
    const s = initialState(0);
    s.research = ["crate", "inspector", "sorter", "sapphire", "monochrome", "crate_5"];
    s.record = 399.96;
    s.money = 1e9;
    assert.match(canResearch(s, "straight").reason, /あと \$0\.04/);
  });
  it("priceBatch: 負の数や NaN の鑑定回数は 0 にする", () => {
    const belt = makeBelt(1);
    for (const ops of [-1e6, NaN]) {
      const p = priceBatch(belt, { ok: true, ops, polished: [], crates: [[0, 1, 2]], log: "" }, { box: 3, research: new Set(["crate"]) });
      assert.equal(p.ops, 0);
      assert.equal(p.opsPerOre, 0);
    }
  });
});

describe("裏口（SPEC-rubyist 4.6）", () => {
  const finalBelt = () => {
    const s = initialState(0);
    s.belt = BELTS.length - 1;
    s.deployed = true;
    return s;
  };
  it("clampBackdoor: 車線は 1〜2 に丸め、丸めたら一言", () => {
    const s = finalBelt();
    assert.deepEqual(clampBackdoor(null, s), { lanes: 1, night: false, overtime: 0, notes: [] });
    assert.deepEqual(clampBackdoor({ lanes: 1, night: false, overtime: 0 }, s).notes, []);
    assert.equal(clampBackdoor({ lanes: 2, night: false, overtime: 0 }, s).lanes, 2);
    const three = clampBackdoor({ lanes: 3, night: false, overtime: 0 }, s);
    assert.equal(three.lanes, 2);
    assert.deepEqual(three.notes, ["床が抜ける。2 車線にしておいたぞ"]);
    for (const bad of [0, -1, 1.5, NaN, "2"]) {
      const r = clampBackdoor({ lanes: bad, night: false, overtime: 0 }, s);
      assert.equal(r.lanes, 1, String(bad));
      assert.deepEqual(r.notes, ["0 車線じゃベルトが止まる。やめておいたぞ"]);
    }
    const r = clampBackdoor({ lanes: 1, night: true, overtime: 2.5 }, s);
    assert.equal(r.night, true);
    assert.equal(r.overtime, 2);
    assert.equal(clampBackdoor({ lanes: 1, night: 1, overtime: -3 }, s).overtime, 0);
  });
  it("2 車線は最終段のベルトにだけ効く（それより前はページだけ埋まって一言）", () => {
    const s = initialState(0);
    s.belt = 2; // 青
    const r = clampBackdoor({ lanes: 2, night: false, overtime: 0 }, s);
    assert.equal(r.lanes, 2);
    assert.deepEqual(r.notes, ["2 車線にできるのは無限ベルトだけだ。いまは青ベルトだぞ"]);
    s.backdoor = { lanes: 2, night: false, overtime: 0 };
    assert.equal(capacities(s).belt, BELTS[2].cap);
    const f = finalBelt();
    assert.equal(capacities(f).belt, 20_000_000);
    f.backdoor = { lanes: 2, night: false, overtime: 0 };
    assert.equal(capacities(f).belt, 40_000_000);
    f.backdoor = { lanes: 9, night: false, overtime: 0 }; // 壊れたセーブでも 2 車線まで
    assert.equal(capacities(f).belt, 40_000_000);
    delete f.backdoor; // 古いセーブ
    assert.equal(capacities(f).belt, 20_000_000);
  });
  it("夜間ラインは惑星コアと軌道エレベータだけ ×1.5。ほかの設備・残業は容量を変えない", () => {
    const s = finalBelt();
    s.mines.planet = 3;
    s.mines.coredrill = 2;
    s.docks.elevator = 2;
    s.docks.airlift = 1;
    const before = capacities(s);
    s.backdoor = { lanes: 1, night: false, overtime: 5 };
    assert.deepEqual(capacities(s), before);
    s.backdoor = { lanes: 1, night: true, overtime: 0 };
    const after = capacities(s);
    assert.equal(after.mine - before.mine, 3 * 500_000);
    assert.equal(unitRate(s, "mine", "planet"), 1_500_000);
    assert.equal(unitRate(s, "mine", "coredrill"), 130_000);
    assert.equal(unitRate(s, "dock", "elevator"), 375_000);
    assert.equal(unitRate(s, "dock", "airlift"), 3_000);
    assert.equal(unitRate(s, "cpu", "core"), 10);
  });
  it("emaFromBatches は監査ラインも平均し、diagnose の「鑑定を 1 回減らせたら」はラインより下を見積もらない", () => {
    const b = (ops, floor) => ({ ok: true, valuePerOre: 100, opsPerOre: ops, cratesPerOre: 0.25, shippedOres: 384, scrapOres: 128, audit: { floorPerOre: floor } });
    const ema = emaFromBatches([b(1.5, 1.5), b(1.5, 1.5)]);
    near(ema.floorPerOre, 1.5, 1e-9);
    assert.equal(emaFromBatches([{ ok: true, valuePerOre: 1, opsPerOre: 1, cratesPerOre: 1, shippedOres: 1, scrapOres: 0 }]).floorPerOre, 0);
    const s = initialState(0);
    s.deployed = true;
    s.research = ["crate", "inspector", "sorter"];
    s.mines.pickaxe = 50;
    s.ema = { ...ema };
    const d = diagnose(s, "refinery");
    assert.equal(d.code.opsMinusOneGainPct, 0); // 実測 = ライン なので 1 回も減らせない
    assert.match(d.code.auditLine, /^鑑定の下限 1\.50 回\/鉱石。理論上ここまで減らせます$/);
    s.ema = { ...ema, floorPerOre: 0 };
    assert.equal(diagnose(s, "refinery").code.auditLine, null);
  });
});
