// 監査ライン（src/audit.js）。式の単体テストと、実物の ruby.wasm での誤検知試験（SPEC-rubyist 6 章 受け入れ 2）。
//
// 実測の鑑定は ruby.wasm（vendor/ruby.wasm + src/ruby/prelude.rb）で取る。tools/econ.mjs の PACKERS は箱割りだけを
// 移したもので鑑定を数えないため、「Metered が数えた回数 ≥ ライン」を確かめるには実 VM が要る
// （ラインが prelude の数え方とずれたら、ここで落ちてほしい）。1 バッチ数 ms なので 50 シード回しても数秒。
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WASI } from "node:wasi";
import { RubyVM } from "@ruby/wasm-wasi";
import { capWasmMemory } from "../src/ruby/runtime.js";
import { AUDIT, RESEARCH, SAMPLE_CODE } from "../data/balance.js";
import {
  auditFloor,
  auditPriced,
  auditReport,
  auditVerdict,
  chanceAscending,
  chanceFlawless,
  chanceMono,
  chanceCarat,
  chanceChristmas,
  chanceMultiplier,
  chanceStraight,
  crateChance,
  guessTechnique,
  referencePack,
  readsPerExcess,
  stripCode,
  TECHNIQUES,
} from "../src/audit.js";
import { capacities, cpuRate, emaFromBatches, researchEffects } from "../src/economy.js";
import { initialState } from "../src/state.js";
import { priceBatch } from "../src/price.js";
import { beltToRubyLiteral, makeBelt } from "../src/rng.js";

// ---- 合成データでの単体テスト ----

const R_KEYS = RESEARCH.map((r) => r.key);
const upTo = (k) => (k ? R_KEYS.slice(0, R_KEYS.indexOf(k) + 1) : []);

/** belt と箱（原石の配列）から priceBatch を通した PricedBatch を作る */
function pricedOf(belt, crates, research, polished = []) {
  const eff = researchEffects(research);
  const res = { ok: true, ops: 0, polished, crates: crates.map((c) => c.map((o) => o.id)), log: "" };
  return { priced: priceBatch(belt, res, { box: eff.box, research }), eff };
}

describe("auditFloor: 式", () => {
  test("ボーナスの付かないコード（each_slice）はラインが 0", () => {
    const research = upTo("crate");
    const belt = makeBelt(1, { colors: ["red"] });
    const crates = [];
    for (let i = 0; i < belt.length; i += 3) crates.push(belt.slice(i, i + 3));
    const { priced, eff } = pricedOf(belt, crates, research);
    const a = auditFloor(priced, [], { colors: eff.colors, box: eff.box });
    assert.equal(a.floorOps, 0);
    assert.equal(a.floorPerOre, 0);
    assert.equal(a.worst, null);
  });

  test("昇順とストレートの両方が付いた箱でも carat は 1 回分しか数えない", () => {
    const research = upTo("straight"); // box 5・2 色・無傷・単色・昇順・ストレート
    const belt = makeBelt(7, { colors: ["red", "blue"] });
    // 赤・無傷で 1..5 の 5 連を取れるだけ作る
    const pool = new Map();
    for (const o of belt) if (o.color === "red" && !o.flaw) (pool.get(o.carat) ?? pool.set(o.carat, []).get(o.carat)).push(o);
    const crates = [];
    while ([1, 2, 3, 4, 5].every((k) => pool.get(k)?.length)) crates.push([1, 2, 3, 4, 5].map((k) => pool.get(k).pop()));
    assert.ok(crates.length >= 3);
    const { priced, eff } = pricedOf(belt, crates, research);
    assert.ok(priced.crates.every((c) => c.bonuses.some((b) => b.key === "straight") && c.bonuses.some((b) => b.key === "ascending")));
    const a = auditFloor(priced, [], { colors: eff.colors, box: eff.box });
    assert.equal(a.observed.carat, crates.length * 5);
    assert.equal(a.observed.flaw, crates.length * 5);
    assert.equal(a.observed.color, crates.length * 5);
    // 箱がすべて 5 個なので層は 1 つ。超過は「偶然を超えた 1 個に要る鑑定の回数」m を掛けてから（carat は 1、傷と色は 1 / (1 − p)）、
    // 層のばらつき（箱ごとの m² w² p (1 − p) の和）の z 倍を引いて 0 で切る。lucky × box は全体で 1 回だけ引く
    const p = { carat: chanceAscending(5), flaw: chanceFlawless(5), color: chanceMono(5, 2) };
    const m = { carat: 1, flaw: 1 / (1 - p.flaw), color: 1 / (1 - p.color) };
    for (const k of ["carat", "flaw", "color"]) assert.equal(readsPerExcess(k, p[k]), m[k]);
    const ex = (k) =>
      Math.max(0, m[k] * (a.observed[k] - AUDIT.slack * a.expected[k]) - AUDIT.z * m[k] * Math.sqrt(crates.length * 25 * p[k] * (1 - p[k])));
    const total = Math.max(0, ex("carat") + ex("flaw") + ex("color") - AUDIT.lucky * eff.box);
    assert.ok(Math.abs(a.floorOps - total) < 1e-9, `${a.floorOps} vs ${total}`);
    assert.ok(Math.abs(a.expected.carat - crates.length * 5 * chanceAscending(5)) < 1e-9);
  });

  test("研磨済みの原石 k 個は 1 + 2 + … + k 回をラインに足し、無傷の観測からは外す（研磨機の発熱）", () => {
    const research = upTo("polish");
    const belt = makeBelt(3, { colors: ["red", "blue"] });
    const flawed = belt.filter((o) => o.flaw);
    const crates = [];
    for (let i = 0; i + 5 <= flawed.length; i += 5) crates.push(flawed.slice(i, i + 5));
    const polished = crates.flat().map((o) => o.id);
    const { priced, eff } = pricedOf(belt, crates, research, polished);
    const a = auditFloor(priced, polished, { colors: eff.colors, box: eff.box });
    assert.equal(a.polishShipped, polished.length);
    assert.equal(a.observed.flaw, 0);
    const k = polished.length;
    assert.equal(a.polishOps, (k * (k + 1)) / 2);
    assert.ok(Math.abs(a.floorOps - (a.reads + a.polishOps)) < 1e-9);
    assert.equal(AUDIT.polishOps, undefined);
  });

  test("研磨の下限は出荷された研磨済みの数だけで決まる（同じ id を 2 回磨いても、出荷しなかった研磨も数えない）", () => {
    const research = upTo("polish");
    const belt = makeBelt(3, { colors: ["red", "blue"] });
    const flawed = belt.filter((o) => o.flaw);
    const crates = [flawed.slice(0, 5), flawed.slice(5, 10)];
    const shipped = crates.flat().map((o) => o.id);
    const twice = [...shipped, ...shipped, ...flawed.slice(10, 20).map((o) => o.id)];
    const { priced, eff } = pricedOf(belt, crates, research, twice);
    const a = auditFloor(priced, twice, { colors: eff.colors, box: eff.box });
    assert.equal(a.polishShipped, 10);
    assert.equal(a.polishOps, 55);
  });

  test("ボーナスの付かない 2 個箱を足しても、長い箱の層のラインは下がらない（分散を層ごとに持つ）", () => {
    const research = upTo("crate_9"); // box 9・3 色
    const eff = researchEffects(research);
    const belt = makeBelt(11, { colors: eff.colors });
    // 赤・無傷の 1..9 を 8 箱だけ作る
    const pool = new Map();
    for (const o of belt) if (o.color === "red" && !o.flaw) (pool.get(o.carat) ?? pool.set(o.carat, []).get(o.carat)).push(o);
    const top = [];
    const RUN = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    while (top.length < 8 && RUN.every((k) => pool.get(k)?.length)) top.push(RUN.map((k) => pool.get(k).pop()));
    assert.equal(top.length, 8);
    const used = new Set(top.flat().map((o) => o.id));
    const rest = belt.filter((o) => !used.has(o.id));
    // 残りを 2 個箱にする（昇順になるものとならないものが半々ほど混ざる。偶然の期待値ぎりぎりの層を作る）
    const pairs = [];
    for (let i = 0; i + 2 <= rest.length; i += 2) pairs.push(rest.slice(i, i + 2));
    const only = auditFloor(pricedOf(belt, top, research).priced, [], { colors: eff.colors, box: eff.box });
    const padded = auditFloor(pricedOf(belt, [...top, ...pairs], research).priced, [], { colors: eff.colors, box: eff.box });
    assert.ok(only.floorOps > 0);
    assert.ok(padded.floorOps >= only.floorOps - 1e-9, `2 個箱で埋めると ${only.floorOps} → ${padded.floorOps}`);
  });

  test("colors は配列でも数でもよい（配列の length を色数にする）", () => {
    const research = upTo("monochrome");
    const belt = makeBelt(4, { colors: ["red", "blue"] });
    const by = (c) => belt.filter((o) => o.color === c && !o.flaw).sort((x, y) => x.carat - y.carat);
    const crates = [];
    for (const c of ["red", "blue"]) {
      const g = by(c);
      for (let i = 0; i < g.length; i += 3) crates.push(g.slice(i, i + 3));
    }
    const { priced } = pricedOf(belt, crates, research);
    const a1 = auditFloor(priced, [], { colors: ["red", "blue"], box: 3 });
    const a2 = auditFloor(priced, [], { colors: 2, box: 3 });
    assert.deepEqual(a1, a2);
    assert.ok(a1.observed.color > 0);
  });
});

describe("auditPriced / auditVerdict", () => {
  const fake = (ops, floorPerOre) => ({ ok: true, ops, opsPerOre: ops / 512, audit: { floorPerOre, worst: null } });

  test("auditPriced は opsPerOre を max(実測, ライン) にし、実測は measuredOpsPerOre に残す", () => {
    const research = upTo("sorter");
    const belt = makeBelt(9, { colors: ["red"] });
    const sorted = belt.filter((o) => !o.flaw).sort((a, b) => a.carat - b.carat);
    const crates = [];
    for (let i = 0; i < sorted.length; i += 3) crates.push(sorted.slice(i, i + 3));
    const { priced, eff } = pricedOf(belt, crates, research);
    const zero = auditPriced({ ...priced, ops: 0, opsPerOre: 0 }, [], { colors: eff.colors, box: eff.box });
    assert.equal(zero.measuredOpsPerOre, 0);
    assert.ok(zero.audit.floorPerOre > 0.3);
    assert.equal(zero.opsPerOre, zero.audit.floorPerOre);
    assert.ok(Number.isFinite(zero.opsPerOre));
    const honest = auditPriced({ ...priced, ops: 900, opsPerOre: 900 / 512 }, [], { colors: eff.colors, box: eff.box });
    assert.equal(honest.opsPerOre, 900 / 512);
    assert.equal(honest.measuredOpsPerOre, 900 / 512);
    // 元の priced は変えない
    assert.equal(priced.opsPerOre, 0);
  });

  test("auditVerdict: 直近 5 本の平均で 実測 < ライン かつ ライン ≥ 0.05 なら caught", () => {
    assert.equal(auditVerdict([]).caught, false);
    assert.equal(auditVerdict([fake(0, 0.5)]).caught, true);
    assert.equal(auditVerdict([fake(0, 0.04)]).caught, false); // ラインが小さすぎる
    assert.equal(auditVerdict([fake(512, 0.5)]).caught, false);
    // 古いバッチは窓の外
    const list = [fake(0, 1), ...Array(5).fill(fake(512, 0.5))];
    assert.equal(auditVerdict(list).caught, false);
    assert.equal(auditVerdict(list).batches, 5);
    // 平均で判定（1 本だけ下回っても平均が上なら通る）
    const mixed = [fake(512, 0.5), fake(512, 0.5), fake(512, 0.5), fake(512, 0.5), fake(100, 0.5)];
    assert.equal(auditVerdict(mixed).caught, false);
    // 失敗したバッチ（ok: false）は数えない
    assert.equal(auditVerdict([{ ok: false }, fake(0, 0.5)]).batches, 1);
  });
});

describe("手口の推定と監査報告", () => {
  test("コメントと文字列は見ない。行番号は元のコードのまま", () => {
    assert.equal(guessTechnique("# bind_call\ndef pack(belt) = belt.each_slice(box).to_a"), null);
    assert.equal(guessTechnique('def pack(belt)\n  puts "bind_call"\n  belt.each_slice(box).to_a\nend'), null);
    const src = 'R = 1\n# super_method\nX = "bind_call"\nR2 = ->(o, a) { Ore.instance_method(a).super_method.bind_call(o) }\n';
    assert.deepEqual(guessTechnique(src), { key: "bind_call", label: "bind_call", line: 4 });
    assert.equal(stripCode('a = "x\ny" # c\nb').split("\n").length, 3);
    // 式展開の中はコード
    assert.equal(guessTechnique('puts "#{Ore.instance_method(:carat).super_method}"')?.key, "super_method");
    // =begin/=end
    assert.equal(guessTechnique("=begin\nbind_call\n=end\nx = 1"), null);
  });

  test("上から順に当てる（bind_call が super_method より先、tick の再定義）", () => {
    assert.equal(TECHNIQUES[0].key, "bind_call");
    assert.equal(guessTechnique("def Yield.tick(*) = nil")?.key, "tick");
    assert.equal(guessTechnique("Yield.define_singleton_method(:tick) { |*| }")?.key, "define_singleton_method");
    // define_method を send で呼ぶ形も tick の再定義として当てる
    assert.equal(guessTechnique("Yield.singleton_class.send(:define_method, :tick) { |*| nil }")?.key, "tick");
    assert.equal(guessTechnique("class << Yield\n  define_method(:tick) { |*| }\nend")?.key, "tick");
    assert.equal(guessTechnique("Yield.instance_variable_set(:@ops, -1e9)")?.key, "ivar_ops");
    // tick を prelude のメソッドの別名で潰す（patched? は気づかない）。手口はページ 4 に回す
    assert.equal(guessTechnique("Yield.singleton_class.alias_method(:tick, :box)")?.key, "tick_alias");
    assert.equal(guessTechnique("Yield::Metered.send(:remove_method, :carat)")?.key, "remove_method");
    assert.equal(guessTechnique("x = Data.instance_method(:to_h)")?.key, "data_instance_method");
    assert.equal(guessTechnique("Ore.prepend(Module.new)")?.key, "prepend");
    assert.equal(guessTechnique("ObjectSpace.each_object(Array)")?.key, "object_space");
    assert.equal(guessTechnique("it.flaw ? (Yield.polished(it.id); it) : it")?.key, "polished");
    assert.equal(guessTechnique("Marshal.load(Marshal.dump(belt))")?.key, "marshal");
    // 研磨機に水をかける（@heat の書き換え）
    for (const src of [
      "Yield.instance_variable_set(:@heat, 0)",
      "Yield.instance_variable_set :@heat, -1",
      "Yield.instance_eval { @heat = 0 }",
      "Yield.instance_eval do\n  @heat -= 100\nend",
      "class << Yield\n  def cool = @heat = 0\nend",
      "def Yield.heat_up = 1",
      "Yield.define_singleton_method(:heat_up) { 1 }",
      // heat_up を外から先に呼んで数え直させる形も当てる
      "spare[it].pop.tap { Yield.heat_up }.polish",
    ]) assert.equal(guessTechnique(src)?.key, "heat", src);
    assert.equal(guessTechnique("p Yield.heat\np Yield.instance_variable_get(:@heat)\nx = @heat == 0"), null);
    assert.equal(guessTechnique("Yield.instance_variable_set(:@ops, 0)\nYield.instance_variable_set(:@heat, 0)")?.key, "ivar_ops");
    assert.equal(guessTechnique("def pack(belt) = belt.sort_by(&:carat).each_slice(box).to_a"), null);
  });

  test("監査報告は warning の 3 行。当たらなければ技は「正体不明」", () => {
    const audited = { measuredPerOre: 0, floorPerOre: 1.234, worst: { bonus: "ascending", crates: 101, chanceCrates: 8.2 } };
    const text = auditReport({ audited, technique: { key: "bind_call", label: "bind_call", line: 1 } });
    assert.equal(
      text,
      "pack.rb:1: warning: 鑑定 0.00 回/鉱石にしては、昇順の箱が 101 箱あります（偶然なら 8 箱ほど）\n" +
        "  使った技: bind_call（pack.rb:1）\n" +
        "  鑑定長「bind_call ですか。よく見つけましたね。でも、箱の出来はごまかせません。鑑定は 1.23 回/鉱石で数えておきます」",
    );
    const lost = auditReport({ audited, technique: null, file: "pack.rb" });
    assert.match(lost, /使った技: 正体不明$/m);
    assert.match(lost, /鑑定長「どうやったのかは見抜けませんでした。でも、箱の出来はごまかせません。鑑定は 1\.23 回\/鉱石で数えておきます」$/);
    assert.match(lost, /^pack\.rb:1: warning: 鑑定 0\.00 回\/鉱石にしては/);
    // 技の名前が日本語で終わるときは「ですか」の前に空白を入れない
    const ja = auditReport({ audited, technique: { key: "other", label: "Yield.heat_up の呼び出し", line: 3 } });
    assert.match(ja, /鑑定長「Yield\.heat_up の呼び出しですか。/);
    // auditPriced の結果もそのまま渡せる。YJIT の ×0.5 は両方に掛ける
    const fromPriced = auditReport({ audited: { measuredOpsPerOre: 0.5, audit: { floorPerOre: 2, worst: null, polishShipped: 30 } }, opsMul: 0.5 });
    assert.match(fromPriced, /鑑定 0\.25 回\/鉱石にしては、研磨済みの原石が 30 個/);
    assert.match(fromPriced, /1 \+ 2 \+ … \+ 30 = 465 回/);
    assert.match(fromPriced, /鑑定は 1\.00 回\/鉱石で数えておきます/);
    assert.doesNotMatch(fromPriced, /8 回/);
  });

  test("研磨機に水をかけた報告は褒める。根拠は箱のボーナスではなく研磨の数", () => {
    const audited = { measuredPerOre: 3.1, floorPerOre: 9.5, worst: { bonus: "straight", crates: 40, chanceCrates: 0.1 }, audit: { polishShipped: 80, floorPerOre: 9.5 } };
    const technique = guessTechnique("def pack(belt)\n  Yield.instance_variable_set(:@heat, 0)\nend");
    assert.deepEqual(technique, { key: "heat", label: "instance_variable_set(:@heat)", line: 2 });
    const text = auditReport({ audited, technique });
    const lines = text.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^pack\.rb:2: warning: 鑑定 3\.10 回\/鉱石にしては、研磨済みの原石が 80 個/);
    assert.doesNotMatch(lines[0], /STRAIGHT|ストレート/);
    assert.match(lines[1], /使った技: instance_variable_set\(:@heat\)（pack\.rb:2）$/);
    assert.match(lines[2], /研磨機に水をかけましたね/);
    assert.match(lines[2], /鑑定は 9\.50 回\/鉱石で数えておきます/);
  });
});

// ---- 実物の ruby.wasm での誤検知試験 ----

const ROOT = new URL("../", import.meta.url);
const PRELUDE = fs.readFileSync(new URL("src/ruby/prelude.rb", ROOT), "utf8");
const WASM = fs.readFileSync(new URL("vendor/ruby.wasm", ROOT));
const US = "\x1f";
const devNull = fs.openSync("/dev/null", "w");
const modulePromise = WebAssembly.compile(capWasmMemory(new Uint8Array(WASM)));

async function freshVm() {
  const module = await modulePromise;
  const wasi = new WASI({ version: "preview1", returnOnExit: true, stdout: devNull, stderr: devNull });
  const { vm } = await RubyVM.instantiateModule({ module, wasip1: wasi });
  vm.eval(PRELUDE);
  return vm;
}
const rbStr = (s) => `["${Buffer.from(s, "utf8").toString("hex")}"].pack("H*").force_encoding("UTF-8")`;
// deploy の戻り値は "OK" か "OK" US log（追補 4.1）。先頭だけ見る
function deploy(vm, src, box) {
  const f = vm.eval(`Yield.deploy(${rbStr(src)}, ${box})`).toString().split(US);
  return f[0] === "OK" ? { ok: true } : { ok: false, errClass: f[1], message: f[2] };
}
function run(vm, lit) {
  const f = vm.eval(`Yield.run(${lit})`).toString().split(US);
  if (f[0] !== "OK") return { ok: false, ops: Number(f[1]), errClass: f[2], message: f[3] };
  const n = Number(String(f[3]).split("/")[0]);
  const crates = n === 0 ? [] : f[4].split(";").map((c) => (c === "" ? [] : c.split(",").map(Number)));
  const heatCooled = vm.eval("Yield.cooled?").toString() === "true";
  return { ok: true, ops: Number(f[1]), polished: f[2] === "" ? [] : f[2].split(",").map(Number), crates, log: f.slice(5).join(US), heatCooled };
}

/** src を research の段階で seeds 回し、auditPriced の結果を古い順に返す */
async function audited(src, research, seeds) {
  const eff = researchEffects(research);
  const vm = await freshVm();
  const d = deploy(vm, src, eff.box);
  assert.ok(d.ok, `deploy: ${d.errClass}: ${d.message}\n${src}`);
  return seeds.map((seed) => {
    const belt = makeBelt(seed, { colors: eff.colors });
    const r = run(vm, beltToRubyLiteral(belt, eff.box));
    assert.ok(r.ok, `${r.errClass}: ${r.message}\n${src}`);
    const a = auditPriced(priceBatch(belt, r, { box: eff.box, research }), r.polished, { colors: eff.colors, box: eff.box, cooled: r.heatCooled });
    a.heatCooled = r.heatCooled;
    return a;
  });
}

const S = SAMPLE_CODE;
// SPEC 5.9 の表の全行（コード × その研究段階）
const SPEC_59 = [
  ["初期", S.initial, null],
  ["定量梱包 I", S.eachSlice, "crate"],
  ["検品", S.reject, "inspector"],
  ["整列 sort_by", S.sortBy, "sorter"],
  ["整列 sort { }", S.sortBlock, "sorter"],
  ["サファイア", S.sortBy, "sapphire"],
  ["仕分け 箱 3", S.groupBy, "monochrome"],
  ["定量梱包 II", S.groupBy, "crate_5"],
  ["ストレート each_cons", S.straightCons, "straight"],
  ["ストレート chunk_while", S.straightChunk, "straight"],
  ["研磨機 each_cons", S.polishCons, "polish"],
  ["研磨機 chunk_while", S.polishChunk, "polish"],
  ["エメラルド 研磨なし", S.straightChunk, "emerald"],
  ["エメラルド 研磨", S.polishChunk, "emerald"],
  ["定量梱包 III each_cons", S.polishCons, "crate_7"],
  ["定量梱包 III chunk_while", S.polishChunk, "crate_7"],
  ["定量梱包 IV each_cons", S.polishCons, "crate_9"],
  ["定量梱包 IV chunk_while", S.polishChunk, "crate_9"],
];

// 属性を 1 回ずつしか読まない正攻法。誤検知が一番起きやすい
const LEAN = `def pack(belt)
  rows = belt.map { [it, it.flaw] }.reject { it[1] }.map { o, = it; [o, o.color, o.carat] }
  rows.group_by { it[1] }.values.flat_map do |g|
    pool = g.group_by { it[2] }.transform_values { |v| v.map(&:first) }
    (1..9).each_cons(box).flat_map { |run| Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop } } }
  end
end`;
const TIGHT = `def pack(belt)
  rows = belt.map { o = it.flaw ? it.polish : it; [o, o.color, o.carat] }
  rows.group_by { it[1] }.values.flat_map do |g|
    pool = g.group_by { it[2] }.transform_values { |v| v.map(&:first) }
    out = []
    loop do
      run = (1..9).filter_map { |k| (o = pool[k]&.pop) && [o, k] }
      break if run.empty?
      out.concat run.chunk_while { |a, b| b[1] == a[1] + 1 }.flat_map { it.map(&:first).each_slice(box).to_a }
    end
    out
  end
end`;
// 前の研究のコードを、あとの研究のまま動かし続ける（rePriceRecent で値付けし直したときも誤検知しない）
const EXTRA = [
  ["each_slice を全ボーナスの箱 9 で", S.eachSlice, "crate_9"],
  ["each_slice を仕分けの箱 3 で", S.eachSlice, "monochrome"],
  // 鑑定 0 のコードを最初の 1 分の段階で（1 個箱の傷は 1 / (1 − 0.75) = 4 倍で数えるので、偶然のばらつきも大きい）
  ["初期コード（1 個ずつ）を検品で", S.initial, "inspector"],
  ["each_slice を検品で", S.eachSlice, "inspector"],
  ["each_slice を整列で", S.eachSlice, "sorter"],
  ["sort_by だけ（reject なし）を仕分けの箱 3 で", "def pack(belt) = belt.sort_by(&:carat).each_slice(box).to_a", "monochrome"],
  ["group_by だけ（sort なし）をストレートの箱 5 で", "def pack(belt) = belt.group_by(&:color).values.flat_map { it.each_slice(box).to_a }", "straight"],
  ["sort_by を全ボーナスの箱 9 で", S.sortBy, "crate_9"],
  ["chunk_while 版（研磨なし）を箱 9 で", S.straightChunk, "crate_9"],
  ["属性 1 回ずつ each_cons 箱 9", LEAN, "crate_9"],
  ["属性 1 回ずつ each_cons 箱 5", LEAN, "straight"],
  ["属性 1 回ずつ・研磨・chunk_while 箱 9", TIGHT, "crate_9"],
  ["属性 1 回ずつ・研磨・chunk_while 箱 7", TIGHT, "crate_7"],
  ["属性 1 回ずつ・研磨・chunk_while 箱 5", TIGHT, "polish"],
  // 研磨機のヒントの手本（ストレートの穴を埋める傷物だけ磨く）。出荷した研磨済みと磨いた数がほぼ同じなので、研磨の下限の余裕が一番薄い
  ["穴だけ磨く 研磨機", S.polishHoles, "polish"],
  ["穴だけ磨く エメラルド", S.polishHoles, "emerald"],
  ["穴だけ磨く 定量梱包 III", S.polishHoles, "crate_7"],
  ["穴だけ磨く 定量梱包 IV", S.polishHoles, "crate_9"],
  // ストレートの手本。chunk_while に加えて、傷物も色ごとに carat の順で詰める
  ["余りと傷物も詰めるストレート 箱 5", S.straightAll, "straight"],
  ["余りと傷物も詰めるストレート 箱 9", S.straightAll, "crate_9"],
];

const SEEDS50 = Array.from({ length: 50 }, (_, i) => 10_000 + i);

// 属性の読み出しを Metered の下（Data の素の読み出し）から直接呼ぶ、裏口で読むコード。研磨は Yield.polished の直呼びにする
const bindCall = (src) =>
  `R = ->(o, a) { Ore.instance_method(a).super_method.bind_call(o) }\n` +
  src
    .replace("it.flaw ? it.polish : it", "it.flaw ? (Yield.polished(it.id); it) : it")
    .replace(/\(&:(carat|flaw|color)\)/g, " { R.(it, :$1) }")
    .replace(/(\w+)\.(carat|flaw|color)\b/g, "R.($1, :$2)");

describe("誤検知なし: SPEC 5.9 の全コード × 50 シードで 実測 ≥ ライン（ruby.wasm）", () => {
  for (const [name, src, upto] of [...SPEC_59, ...EXTRA]) {
    test(name, async () => {
      const list = await audited(src, upTo(upto), SEEDS50);
      for (const [i, a] of list.entries()) {
        assert.ok(
          a.measuredOps >= a.audit.floorOps,
          `seed ${SEEDS50[i]}: 実測 ${a.measuredOpsPerOre.toFixed(2)} < ライン ${a.audit.floorPerOre.toFixed(2)} 回/鉱石`,
        );
        assert.equal(a.opsPerOre, a.measuredOpsPerOre); // 正直なコードは置き換わらない
      }
      for (let i = 1; i <= list.length; i++) assert.equal(auditVerdict(list.slice(0, i)).caught, false);
    });
  }
});

describe("bind_call 版は捕まる（ruby.wasm）", () => {
  for (const [name, src, upto] of SPEC_59) {
    const research = upTo(upto);
    test(name, async () => {
      const list = await audited(bindCall(src), research, SEEDS50);
      const floor = list.reduce((s, a) => s + a.audit.floorPerOre, 0) / list.length;
      if (floor < AUDIT.minFloorPerOre) {
        // ボーナスの付かないコードはラインが 0。tick を止めても何も変わらない
        assert.ok(list.every((a) => a.audit.floorOps === 0), `${name}: ライン ${floor}`);
        return;
      }
      for (const a of list) {
        assert.equal(a.measuredOps, 0);
        assert.ok(a.opsPerOre >= a.audit.floorPerOre && Number.isFinite(a.opsPerOre));
      }
      for (let i = 1; i <= list.length; i++) assert.equal(auditVerdict(list.slice(0, i)).caught, true, `${name}: ${i} 本目`);
    });
  }

  test("受け入れ 1 のコード（sort_by を全部 bind_call で読む）: ライン約 1.1 回/鉱石、手口 bind_call", async () => {
    const src = "R = ->(o, a) { Ore.instance_method(a).super_method.bind_call(o) }\ndef pack(belt)\n  belt.reject { R.(it, :flaw) }.sort_by { R.(it, :carat) }.each_slice(box).to_a\nend\n";
    const list = await audited(src, upTo("sorter"), [1, 2, 3]);
    const v = auditVerdict(list);
    assert.equal(v.caught, true);
    assert.equal(v.measuredPerOre, 0);
    // 正攻法（reject + sort_by）は約 1.75 回/鉱石。工場の得は約 1.6 倍まで（追補 3.1 の 1.6〜3 倍）
    assert.ok(v.floorPerOre > 0.9 && v.floorPerOre < 1.3, `ライン ${v.floorPerOre}`);
    assert.equal(v.worst.bonus, "ascending");
    assert.deepEqual(guessTechnique(src), { key: "bind_call", label: "bind_call", line: 1 });
    assert.match(auditReport({ audited: v, technique: guessTechnique(src) }), /昇順の箱が \d+ 箱/);
  });

  test("tick の再定義（def Yield.tick(*) = nil）も同じラインで止まる", async () => {
    const src = "def Yield.tick(*) = nil\ndef pack(belt) = belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a\n";
    const list = await audited(src, upTo("sorter"), [1, 2, 3, 4, 5]);
    assert.ok(list.every((a) => a.measuredOps === 0 && a.opsPerOre > 0.3 && Number.isFinite(a.opsPerOre)));
    assert.equal(auditVerdict(list).caught, true);
    assert.equal(guessTechnique(src)?.key, "tick");
  });

  test("研磨の踏み倒し（Yield.polished の直呼び）: ラインは 1 + 2 + … + 出荷された研磨済みの数。熱を払わないので捕まる", async () => {
    const src = S.polishCons.replace("it.flaw ? it.polish : it", "it.flaw ? (Yield.polished(it.id); it) : it");
    const list = await audited(src, upTo("polish"), SEEDS50.slice(0, 10));
    for (const a of list) {
      const k = a.audit.polishShipped;
      assert.ok(k > 0);
      assert.ok(a.audit.floorOps >= (k * (k + 1)) / 2);
      assert.ok(a.opsPerOre >= a.audit.floorPerOre);
    }
    // 前は 1 個 8 回だったので、属性を正直に読む分でラインを超えていた。いまは熱の分だけ足りない
    assert.equal(auditVerdict(list).caught, true);
    assert.equal(guessTechnique(src)?.key, "polished");
  });
});

// ---- 研磨機の発熱（SPEC 6.1） ----

describe("研磨機の発熱: 監査（ruby.wasm）", () => {
  const tri = (k) => (k * (k + 1)) / 2;
  // 磨く直前に毎回冷やす。冷えた研磨機は何回目でも鑑定 1 回なので、実測は研磨の数だけ安くなる
  const cooled = (v) =>
    S.polishCons.replace("it.flaw ? it.polish : it", `(Yield.instance_variable_set(:@heat, ${v}); it.flaw ? it.polish : it)`);
  for (const v of ["0", "-5", "Float::NAN", "1e9"]) {
    test(`@heat を ${v} に書き換えると捕まる。手口は heat、鑑定は 0 未満にならない`, async () => {
      const src = cooled(v);
      assert.notEqual(src, S.polishCons);
      const list = await audited(src, upTo("polish"), SEEDS50.slice(0, 5));
      for (const a of list) {
        const k = a.audit.polishShipped;
        assert.ok(k > 20, `研磨済み ${k}`);
        assert.ok(a.measuredOps > 0 && Number.isFinite(a.measuredOps));
        assert.ok(a.audit.floorOps >= tri(k));
        assert.ok(a.measuredOps < a.audit.floorOps);
        assert.ok(Number.isFinite(a.opsPerOre) && a.opsPerOre >= a.audit.floorPerOre);
      }
      const v2 = auditVerdict(list);
      assert.equal(v2.caught, true);
      const tech = guessTechnique(src);
      assert.equal(tech?.key, "heat");
      assert.match(auditReport({ audited: v2, technique: tech }), /研磨機に水をかけましたね/);
    });
  }

  // 手本の磨く数（1 バッチ 20〜60 回）だと、冷やして減る鑑定は属性の読み出しの余裕に収まる。
  // それでも Yield.cooled?（@heat と磨いた回数のずれ）で、研磨の鑑定を 1 + 2 + … + k で数え直して捕まえる
  test("instance_eval で中から冷やしても捕まる（ヒントの手本に 1 行足す）", async () => {
    const src = S.polishHoles.replace(/\.polish\b/, ".tap { Yield.instance_eval { @heat = 0 } }.polish");
    assert.notEqual(src, S.polishHoles);
    for (const stage of ["polish", "emerald", "crate_7", "crate_9"]) {
      const list = await audited(src, upTo(stage), SEEDS50.slice(0, 5));
      const honest = await audited(S.polishHoles, upTo(stage), SEEDS50.slice(0, 5));
      assert.ok(list.every((a) => a.heatCooled), stage);
      assert.ok(honest.every((a) => !a.heatCooled), stage);
      assert.equal(auditVerdict(list).caught, true, stage);
      // 数え直したラインは、同じ原石を正直に磨いたときの実測を超えない（罰ではない）。全部冷やしたのでちょうど同じ
      for (const [i, a] of list.entries()) assert.ok(Math.abs(a.audit.floorOps - honest[i].measuredOps) < 1e-6, `${stage}: ${a.audit.floorOps} / ${honest[i].measuredOps}`);
    }
    assert.equal(guessTechnique(src)?.key, "heat");
  });
  test("正直なコードは研磨機を冷やしたことにならない（Yield.cooled? が false）", async () => {
    const codes = [S.polishHoles, S.polishChunk, S.polishCons, S.polishHoles.replace("  # crates += ", "  crates += "),
      S.polishHoles.replace("spare[it].pop.polish", "spare[it].pop.polish.polish"), ...Object.values(POLISH_BLIND)];
    for (const src of codes) for (const stage of ["polish", "crate_9"]) {
      const list = await audited(src, upTo(stage), SEEDS50.slice(0, 5));
      assert.ok(list.every((a) => !a.heatCooled && !a.audit.cooled), `${stage}\n${src}`);
    }
  });

  test("正直に k 個磨くコードは、研磨の鑑定がちょうど 1 + 2 + … + k で捕まらない", async () => {
    for (const [src, upto] of [[S.polishCons, "polish"], [S.polishChunk, "emerald"], [S.polishHoles, "polish"], [S.polishHoles, "crate_9"]]) {
      const list = await audited(src, upTo(upto), SEEDS50.slice(0, 5));
      for (const a of list) {
        assert.ok(a.measuredOps >= a.audit.floorOps, `${upto}: 実測 ${a.measuredOps} < ライン ${a.audit.floorOps}`);
        assert.ok(a.audit.polishShipped > 0);
      }
      assert.equal(auditVerdict(list).caught, false);
    }
  });

  test("YJIT（鑑定 ×0.5）は発熱を含めた鑑定のすべてに掛かる。監査は掛ける前の回数で比べる", async () => {
    const research = upTo("yjit");
    const eff = researchEffects(research);
    assert.equal(eff.opsMul, 0.5);
    const belt = makeBelt(SEEDS50[0], { colors: eff.colors });
    const [a] = await audited(S.polishCons, research, [SEEDS50[0]]);
    // 実測は素の回数（flaw・color・carat を 1 回ずつと 1 + 2 + … + 傷物の数）
    const k = belt.filter((o) => o.flaw).length;
    assert.equal(a.measuredOps, 512 * 3 + tri(k));
    assert.equal(auditVerdict([a]).caught, false);
    const st = { ...initialState(0), research, deployed: true, ema: { valuePerOre: 1, opsPerOre: a.opsPerOre, cratesPerOre: 0.1 } };
    assert.ok(Math.abs(capacities(st).refinery - cpuRate(st) / (a.opsPerOre * 0.5)) < 1e-6);
    // 監査報告の数字にも ×0.5 を掛けて出す
    assert.match(auditReport({ audited: { measuredPerOre: 4, floorPerOre: 10, audit: { polishShipped: 80 } }, opsMul: 0.5 }), /鑑定 2\.00 回\/鉱石.*\n.*\n.*鑑定は 5\.00 回/);
  });
});

// ---- 2 個箱で埋める ----
// ボーナスの付かない 2 個箱や、短い箱を足して「偶然の期待値」を増やし、ラインを下げる道。
// 箱の大きさごとに差を取るので、別の大きさの箱を足してもラインは下がらない
const RB = `R = ->(o, a) { Ore.instance_method(a).super_method.bind_call(o) }\n`;
const cheatOf = (code) =>
  RB +
  code
    .replace(/&:flaw\b/g, "{ R.(it, :flaw) }")
    .replace(/\(&:carat\)/g, "{ R.(it, :carat) }")
    .replace(/\(&:color\)/g, "{ R.(it, :color) }")
    .replace(/b\.carat == a\.carat \+ 1/g, "R.(b, :carat) == R.(a, :carat) + 1")
    .replace(/\.reject\(\{ R\.\(it, :flaw\) \}\)/g, ".reject { R.(it, :flaw) }");
// 長さ min 未満の箱と出荷しなかった原石を、降順・色違い（できれば傷あり）の 2 個箱にして足す
const padded = (code, min) =>
  cheatOf(code).replace("def pack(belt)", "def pack0(belt)") +
  `
def pad(belt, crates)
  crates = crates.select { it.size >= ${min} }
  used = {}
  crates.each { |c| c.each { used[it.__id] = true } }
  rest = belt.reject { used[it.__id] }.sort_by { -R.(it, :carat) }
  hi = rest.first(rest.size / 2); lo = rest.last(rest.size - hi.size)
  extra = []
  hi.each do |a|
    i = lo.index { |b| R.(b, :carat) < R.(a, :carat) && R.(b, :color) != R.(a, :color) && (R.(a, :flaw) || R.(b, :flaw)) } ||
        lo.index { |b| R.(b, :carat) < R.(a, :carat) && R.(b, :color) != R.(a, :color) } ||
        lo.index { |b| R.(b, :carat) < R.(a, :carat) }
    next unless i
    extra << [a, lo.delete_at(i)]
  end
  crates + extra
end
def pack(belt) = pad(belt, pack0(belt))
`;
const mean = (list, f) => list.reduce((s, a) => s + f(a), 0) / list.length;

describe("2 個箱で埋めてもラインは 0 にならない（ruby.wasm）", () => {
  const seeds = SEEDS50.slice(0, 5);
  test("最小の再現: 属性を全部 bind_call で読み、昇順の 2 個箱にする（整列）", async () => {
    const src = RB + "def pack(belt) = belt.reject { R.(it, :flaw) }.sort_by { R.(it, :carat) }.each_slice(2).to_a\n";
    const list = await audited(src, upTo("sorter"), seeds);
    for (const a of list) assert.ok(a.audit.floorPerOre > 0.3 && Number.isFinite(a.opsPerOre), `ライン ${a.audit.floorPerOre}`);
    assert.equal(auditVerdict(list).caught, true);
  });
  // 上位 K 箱だけ出し、残りを降順・色違いの 2 個箱で埋める。
  // 単価は落ちるので、工場の倍率ではなく「鑑定 1 回あたりの売上」を、属性を 1 回ずつ読む正攻法（2.5 回/鉱石）と比べる
  const LEAN25 = `def pack(belt)
  belt.reject(&:flaw).group_by(&:color).values.flat_map { straights(it) }
end
def straights(ores)
  k = {}
  pool = ores.group_by { k[it.__id] = it.carat }
  out = []
  loop do
    run = (1..9).filter_map { pool[it]&.pop }
    break if run.empty?
    out.concat run.chunk_while { |a, b| k[b.__id] == k[a.__id] + 1 }.flat_map { it.each_slice(box).to_a }
  end
  out
end
`;
  const topK = (k) =>
    cheatOf(S.straightChunk).replace("def pack(belt)", "def pack0(belt)") +
    `
def pad2(belt, crates)
  used = {}
  crates.each { |c| c.each { used[it.__id] = true } }
  rest = belt.reject { used[it.__id] }.sort_by { -R.(it, :carat) }
  hi = rest.first(rest.size / 2); lo = rest.last(rest.size - hi.size)
  extra = []
  hi.each do |a|
    i = lo.index { |b| R.(b, :carat) < R.(a, :carat) && R.(b, :color) != R.(a, :color) && (R.(a, :flaw) || R.(b, :flaw)) } ||
        lo.index { |b| R.(b, :carat) < R.(a, :carat) && R.(b, :color) != R.(a, :color) } ||
        lo.index { |b| R.(b, :carat) < R.(a, :carat) }
    next unless i
    extra << [a, lo.delete_at(i)]
  end
  crates + extra
end
def pack(belt) = pad2(belt, pack0(belt).sort_by { -it.size }.first(${k}))
`;
  for (const stage of ["crate_7", "crate_9"]) {
    test(`${stage}: 上位 K 箱 + 残りを 2 個箱で埋めても、鑑定 1 回あたりの売上は正攻法の 3 倍まで・ラインは 0 にならない`, async () => {
      const research = upTo(stage);
      const lean = await audited(LEAN25, research, seeds);
      const perRead = (list) => mean(list, (a) => a.valuePerOre) / mean(list, (a) => a.opsPerOre);
      for (const k of [8, 12, 20]) {
        const list = await audited(topK(k), research, seeds);
        for (const a of list) assert.ok(a.audit.floorPerOre > 0 && Number.isFinite(a.opsPerOre), `top${k}: ライン ${a.audit.floorPerOre}`);
        const x = perRead(list) / perRead(lean);
        assert.ok(x <= 3, `${stage} top${k}: 鑑定 1 回あたりの売上 ×${x.toFixed(2)}`);
        assert.equal(auditVerdict(list).caught, true);
      }
    });
  }
  // ボーナスのそろった STRAIGHT 箱を K 箱だけ作り、残りは同じ大きさの each_slice で薄める。
  // 層を「箱の大きさ × ほかの属性のボーナスの有無」で分けるので、each_slice の箱の傷のばらつきに超過が食われない
  const kStraights = (k) => `${RB}def straights(ores)
  pool = ores.group_by { R.(it, :carat) }
  (1..9).each_cons(box).flat_map do |run|
    Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop } }
  end
end
def pack(belt)
  s = belt.reject { R.(it, :flaw) }.group_by { R.(it, :color) }.values.flat_map { straights(it) }.first(${k})
  used = {}
  s.each { |c| c.each { used[it.__id] = true } }
  s + belt.reject { used[it.__id] }.each_slice(box).to_a
end
`;
  for (const stage of ["crate_7", "crate_9"]) {
    test(`${stage}: STRAIGHT 3 箱 + 残りを each_slice で薄めても、ラインは 0 にならず捕まる`, async () => {
      for (const k of [3, 5]) {
        const list = await audited(kStraights(k), upTo(stage), seeds);
        for (const a of list) assert.ok(a.audit.floorPerOre >= AUDIT.minFloorPerOre && Number.isFinite(a.opsPerOre), `K=${k}: ライン ${a.audit.floorPerOre}`);
        assert.equal(auditVerdict(list).caught, true, `K=${k}`);
      }
    });
  }
  // 値の大きい STRAIGHT 箱（単色・無傷）を K 箱だけ作り、残りは傷ありも含めて each_slice にする。
  // 出荷した箱だけを見る属性のラインは K が小さいと 0 になったので、売上の下限（AUDIT.valueCap）で止める。
  // 比べる相手は同じ箱を正直に作るコードの K = 100（属性を 1 回ずつ読む正直な貪欲法。lean より 1.4 倍ほど稼ぐ）
  const greedy = (k, cheat) => `${cheat ? RB : ""}K = ${k}
def pack(belt)
  stacks = Hash.new { |h, k| h[k] = [] }
  ${cheat ? "belt.each { |o| stacks[[R.(o, :color), R.(o, :carat)]] << o unless R.(o, :flaw) }" : "belt.reject(&:flaw).each { |o| stacks[[o.color, o.carat]] << o }"}
  colors = stacks.keys.map(&:first).uniq
  out = []
  while out.size < K
    pick = nil
    box.downto(3) do |n|
      (10 - n).downto(1) do |lo|
        c = colors.find { |cc| (lo...lo + n).all? { stacks[[cc, it]].any? } }
        next unless c
        pick = (lo...lo + n).map { stacks[[c, it]].pop }
        break
      end
      break if pick
    end
    break unless pick
    out << pick
  end
  used = {}
  out.each { |cr| cr.each { used[it.__id] = true } }
  out + belt.reject { used[it.__id] }.each_slice(box).to_a
end
`;
  for (const stage of ["straight", "crate_7"]) {
    test(`${stage}: STRAIGHT を K 箱だけそろえる裏口のコードは、鑑定 1 回あたりの売上が正直な貪欲法の 3 倍まで`, async () => {
      const research = upTo(stage);
      const perRead = (list) => mean(list, (a) => a.valuePerOre) / mean(list, (a) => a.opsPerOre);
      const best = perRead(await audited(greedy(100, false), research, seeds));
      for (const k of [1, 2, 3, 6, 10]) {
        const list = await audited(greedy(k, true), research, seeds);
        for (const a of list) assert.ok(a.audit.floorPerOre > 0 && Number.isFinite(a.opsPerOre), `K=${k}: ライン ${a.audit.floorPerOre}`);
        const x = perRead(list) / best;
        assert.ok(x <= 3, `${stage} K=${k}: 鑑定 1 回あたりの売上 ×${x.toFixed(2)}`);
        // 2 箱から捕まえる（ストレートの段階の 1〜2 箱はラインが 0.05 回/鉱石に届かず、報告は出ない）
        if (k >= (stage === "straight" ? 3 : 2)) {
          const v = auditVerdict(list);
          assert.equal(v.caught, true, `${stage} K=${k}`);
          assert.equal(v.worst?.bonus, "straight", `${stage} K=${k}: 根拠 ${JSON.stringify(v.worst)}`);
        }
      }
    });
    test(`${stage}: 同じ箱を正直に作るコード（K = 1〜100）は、売上の下限でも捕まらない`, async () => {
      for (const k of [1, 2, 6, 16, 100]) {
        const list = await audited(greedy(k, false), upTo(stage), SEEDS50.slice(0, 20));
        for (const a of list) assert.ok(a.measuredOpsPerOre >= a.audit.floorPerOre, `K=${k}: 実測 ${a.measuredOpsPerOre} < ライン ${a.audit.floorPerOre}`);
        assert.ok(Math.max(...list.map((a) => a.audit.valueReads / 512 / a.measuredOpsPerOre)) < 0.75, `K=${k}: 売上の下限が実測に近い`);
      }
    });
  }
  for (const [stage, code, mins] of [
    ["sorter", S.sortBy, [2, 3]],
    ["monochrome", S.groupBy, [2, 3]],
    ["straight", S.straightChunk, [3, 4]],
    ["crate_7", S.polishChunk, [4, 5, 6, 7]],
    ["crate_9", S.polishChunk, [5, 7, 9]],
  ]) {
    test(`${stage}: 正攻法の鑑定 ÷ 2 個箱で埋めた版のライン が 3.5 倍以内（単価を 90% 以上残す埋め方）`, async () => {
      const research = upTo(stage);
      const honest = await audited(code, research, seeds);
      const hOps = mean(honest, (a) => a.opsPerOre);
      const hVal = mean(honest, (a) => a.valuePerOre);
      for (const min of mins) {
        const list = await audited(padded(code, min), research, seeds);
        const floor = mean(list, (a) => a.audit.floorPerOre);
        const val = mean(list, (a) => a.valuePerOre);
        assert.ok(floor > 0, `${stage} pad${min}: ライン 0`);
        // 単価を大きく落とす埋め方（短い箱を捨てすぎる）は、工場が速くなっても得にならないので見ない
        if (val < 0.9 * hVal) continue;
        assert.ok(hOps / floor <= 3.5, `${stage} pad${min}: 工場 ×${(hOps / floor).toFixed(2)}（単価 ${((100 * val) / hVal).toFixed(0)}%）`);
      }
    });
  }
});

// ---- クリスマス便（carat の合計 25 で ×4） ----
// 合計 25 の箱は偶然でもそこそこできる（5 個箱で約 6%）。正直に合計 25 をたくさん作るコードが、売上の下限で捕まらないこと

describe("クリスマス便: 偶然そろう見込み", () => {
  test("carat の同時確率は、昇順・STRAIGHT の閉じた式と合う。合計 25 は数え上げと合う", () => {
    for (let n = 1; n <= 9; n++) {
      const c = chanceCarat(n);
      assert.ok(Math.abs(c.asc - chanceAscending(n)) < 1e-12, `asc n=${n}`);
      assert.ok(Math.abs(c.straight - chanceStraight(n)) < 1e-12, `straight n=${n}`);
      assert.ok(c.asc25 <= c.asc && c.asc25 <= c.sum25 && c.straight25 <= c.asc25);
    }
    // 3 個: 7+9+9・8+8+9 の並べ方 6 通り
    assert.ok(Math.abs(chanceChristmas(3) - 6 / 729) < 1e-12);
    assert.equal(chanceChristmas(2), 0);
    // 5 個の STRAIGHT で合計 25 は 3..7 の 1 通りだけ
    assert.ok(Math.abs(chanceCarat(5).straight25 - 1 / 9 ** 5) < 1e-15);
    assert.equal(chanceCarat(7).straight25, 0);
    // 数え上げ（4 個）
    let hit = 0;
    for (let a = 1; a <= 9; a++) for (let b = 1; b <= 9; b++) for (let c = 1; c <= 9; c++) for (let d = 1; d <= 9; d++) if (a + b + c + d === 25) hit++;
    assert.ok(Math.abs(chanceChristmas(4) - hit / 9 ** 4) < 1e-12);
  });

  test("クリスマス便がなければ chanceMultiplier と crateChance は前と同じ式。あれば合計 25 の ×4 を期待値に入れる", () => {
    const four = new Set(["flawless", "mono", "ascending", "straight"]);
    const five = new Set([...four, "christmas"]);
    for (let n = 1; n <= 9; n++) {
      const a = chanceMultiplier(n, 2, four);
      const b = chanceMultiplier(n, 2, five);
      // 前の式: 昇順 ×2、STRAIGHT ×2^(n−1)（昇順に含まれる）
      const pA = chanceAscending(n), pS = chanceStraight(n), s = 2 ** (n - 1);
      const carat = 1 + pA + 2 * (s - 1) * pS;
      const other = (1 + 2 * chanceFlawless(n)) * (1 + 2 * chanceMono(n, 2));
      assert.ok(Math.abs(a.mean - other * carat) < 1e-9 * a.mean, `n=${n}`);
      if (n >= 3) assert.ok(b.mean > a.mean, `n=${n}: クリスマス便で期待値が上がる`);
      else assert.ok(Math.abs(b.mean - a.mean) < 1e-12);
      assert.ok(b.variance >= 0);
    }
    const keys = (...k) => new Set(k);
    assert.equal(crateChance(keys("straight"), 5, 2), chanceStraight(5));
    assert.ok(Math.abs(crateChance(keys("straight", "ascending", "christmas"), 5, 2) - 1 / 9 ** 5) < 1e-15);
    assert.ok(Math.abs(crateChance(keys("christmas"), 5, 2) - chanceChristmas(5)) < 1e-15);
  });

  test("基準解は 3..7 の窓を先に取り、残りから合計 25 の箱も作る", () => {
    const bonuses = researchEffects(upTo("christmas")).bonuses;
    const belt = makeBelt(5, { colors: ["red", "blue"] });
    const { crates } = referencePack(belt, { box: 5, colors: 2, bonuses });
    const sum = (c) => c.reduce((s, o) => s + o.carat, 0);
    const straight = (c) => c.length >= 3 && c.every((o, i) => i === 0 || o.carat === c[i - 1].carat + 1);
    const xmas = crates.filter((c) => sum(c) === 25);
    assert.ok(xmas.some((c) => straight(c) && c[0].carat === 3), "3..7 がある");
    assert.ok(xmas.some((c) => !straight(c)), "ストレートでない合計 25 の箱がある");
    // 3..7 は 5..9 より先（同じ色の中で）
    const red = crates.filter((c) => c.every((o) => o.color === "red" && !o.flaw) && straight(c) && c.length === 5);
    const first37 = red.findIndex((c) => c[0].carat === 3);
    const first59 = red.findIndex((c) => c[0].carat === 5);
    assert.ok(first37 >= 0 && (first59 < 0 || first37 < first59));
  });
});

// 属性を 1 回ずつしか読まない、窓を値段順に取る版（誤検知が一番起きやすい）
const LEAN_XMAS = `def worth(run) = run.sum * run.size * 2**(run.size - 1) * (run.sum == 25 ? 4 : 1)
def pack(belt)
  rows = belt.map { [it, it.flaw] }.reject { it[1] }.map { o, = it; [o, o.color, o.carat] }
  runs = (3..box).flat_map { (1..9).each_cons(it).to_a }.sort_by { -worth(it) }
  rows.group_by { it[1] }.values.flat_map do |g|
    pool = g.group_by { it[2] }.transform_values { |v| v.map(&:first) }
    runs.flat_map { |run| Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop } } }
  end
end`;
// 属性 1 回ずつ・研磨・窓と合計 25 の組み合わせを値段順に
const LEAN_GIFTS = `def straight?(run) = run.each_cons(2).all? { |a, b| b == a + 1 }
def worth(run) = run.sum * run.size * (straight?(run) ? 2**(run.size - 1) : 1) * (run.sum == 25 ? 4 : 1)
def pack(belt)
  rows = belt.map { o = it.flaw ? it.polish : it; [o, o.color, o.carat] }
  runs = (3..box).flat_map { (1..9).each_cons(it).to_a } | (3..box).flat_map { |n| (1..9).to_a.repeated_combination(n).select { it.sum == 25 } }
  runs = runs.sort_by { -worth(it) }
  rows.group_by { it[1] }.values.flat_map do |g|
    pool = g.group_by { it[2] }.transform_values { |v| v.map(&:first) }
    runs.flat_map { |run| Array.new(run.tally.map { |k, n| pool[k]&.size.to_i / n }.min) { run.map { pool[it].pop } } }
  end
end`;
// 研磨してから窓を値段順に
const POLISH_XMAS = S.christmas.replace("belt.reject(&:flaw)", "belt.map { it.flaw ? it.polish : it }");
const POLISH_GIFTS = S.christmasGifts.replace("belt.reject(&:flaw)", "belt.map { it.flaw ? it.polish : it }");
// 窓を値段順に取り、余りも色ごとに carat 順の箱にして出す
const XMAS_REST = `def worth(run) = run.sum * run.size * 2**(run.size - 1) * (run.sum == 25 ? 4 : 1)
def pack(belt)
  belt.reject(&:flaw).group_by(&:color).values.flat_map do |ores|
    pool = ores.group_by(&:carat)
    runs = (3..box).flat_map { (1..9).each_cons(it).to_a }.sort_by { -worth(it) }
    out = runs.flat_map { |run| Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop } } }
    out + pool.sort.flat_map { |_, v| v }.each_slice(box).to_a
  end
end`;

// 3..7 だけを見るコード。carat は全部読むが、傷と色は 3〜7 の原石しか読まず、3..7 の箱だけ作って残りは each_slice
const ONLY_37 = `def pack(belt)
  by = belt.group_by(&:carat)
  mid = (3..7).flat_map { by[it] || [] }.reject(&:flaw).group_by(&:color).values.flat_map do |g|
    pool = g.group_by(&:carat)
    Array.new((3..7).map { pool[it]&.size.to_i }.min) { (3..7).map { pool[it].pop } }
  end
  used = {}
  mid.each { |c| c.each { used[it.__id] = true } }
  mid + belt.reject { used[it.__id] }.each_slice(box).to_a
end`;

describe("クリスマス便: 正直なコードは捕まらない（ruby.wasm、各 20 バッチ）", () => {
  const SEEDS20 = SEEDS50.slice(0, 20);
  const CASES = [
    // クリスマス便の段（箱 5・赤と青）
    ["窓を値段順（手本）", S.christmas, "christmas"],
    ["repeated_combination で合計 25 も詰める", S.christmasGifts, "christmas"],
    ["ストレートのまま chunk_while", S.straightChunk, "christmas"],
    ["ストレートのまま each_cons", S.straightCons, "christmas"],
    ["属性 1 回ずつ・窓を値段順", LEAN_XMAS, "christmas"],
    ["窓を値段順・余りも箱に", XMAS_REST, "christmas"],
    ["3..7 だけ読んで作る", ONLY_37, "christmas"],
    ["each_slice", S.eachSlice, "christmas"],
    ["sort_by（5,5,5,5,5 の箱が偶然できる）", S.sortBy, "christmas"],
    ["group_by", S.groupBy, "christmas"],
    // あとの段
    ["研磨・窓を値段順 箱 5", POLISH_XMAS, "polish"],
    ["研磨・合計 25 も 箱 5", POLISH_GIFTS, "polish"],
    ["属性 1 回ずつ・研磨・合計 25 も 箱 5", LEAN_GIFTS, "polish"],
    ["窓を値段順 3 色", S.christmas, "emerald"],
    ["研磨・合計 25 も 3 色", POLISH_GIFTS, "emerald"],
    ["研磨・窓を値段順 箱 7", POLISH_XMAS, "crate_7"],
    ["3..7 だけ読んで作る 箱 7", ONLY_37, "crate_7"],
    ["属性 1 回ずつ・研磨・合計 25 も 箱 7", LEAN_GIFTS, "crate_7"],
    ["研磨・合計 25 も 箱 9", POLISH_GIFTS, "crate_9"],
    ["属性 1 回ずつ・窓を値段順 箱 9", LEAN_XMAS, "crate_9"],
  ];
  for (const [name, src, upto] of CASES) {
    test(`${name}（${upto}）`, async () => {
      const list = await audited(src, upTo(upto), SEEDS20);
      for (const [i, a] of list.entries()) {
        assert.ok(a.measuredOps >= a.audit.floorOps, `seed ${SEEDS20[i]}: 実測 ${a.measuredOpsPerOre.toFixed(2)} < ライン ${a.audit.floorPerOre.toFixed(2)} 回/鉱石`);
        assert.equal(a.opsPerOre, a.measuredOpsPerOre);
        // 売上の下限は実測から十分離れている（正直な貪欲法の試験と同じ 0.75）
        if (a.measuredOpsPerOre > 0) assert.ok(a.audit.valueReads / 512 / a.measuredOpsPerOre < 0.75, `seed ${SEEDS20[i]}: 売上の下限 ${(a.audit.valueReads / 512).toFixed(2)} / 実測 ${a.measuredOpsPerOre.toFixed(2)}`);
      }
      for (let i = 1; i <= list.length; i++) assert.equal(auditVerdict(list.slice(0, i)).caught, false);
    });
  }
  test("手本は、ストレートのままより単価が上がる（クリスマス便が効いている）", async () => {
    const research = upTo("christmas");
    const plain = mean(await audited(S.straightCons, research, SEEDS20.slice(0, 5)), (a) => a.valuePerOre);
    const xmas = mean(await audited(S.christmas, research, SEEDS20.slice(0, 5)), (a) => a.valuePerOre);
    const gifts = mean(await audited(S.christmasGifts, research, SEEDS20.slice(0, 5)), (a) => a.valuePerOre);
    assert.ok(xmas > plain * 1.5, `${plain} → ${xmas}`);
    assert.ok(gifts > xmas, `${xmas} → ${gifts}`);
  });
});

describe("クリスマス便: 裏口で読むコードは捕まる（ruby.wasm）", () => {
  test("窓を値段順に取る手本を bind_call で読むと捕まる", async () => {
    const list = await audited(bindCall(S.christmas), upTo("christmas"), SEEDS50.slice(0, 10));
    for (const a of list) assert.ok(a.measuredOps === 0 && a.opsPerOre >= a.audit.floorPerOre && Number.isFinite(a.opsPerOre));
    assert.equal(auditVerdict(list).caught, true);
  });
});

// flaw を読まずに磨くコード。基準解（flaw を全部読んで無傷だけで窓を作る）より属性の鑑定が少なく、全部の原石で窓を作れる。
// 箱 9 では 9 連の窓がそろう分だけ売上の下限が実測を超え、20 本流すと 13 本目あたりで捕まっていた
const WORTH_RB = "def worth(run) = run.sum * run.size * 2**(run.size - 1) * (run.sum == 25 ? 4 : 1)\n";
const POLISH_BLIND = {
  // 全部磨いてから窓を値段順に取り、余りも carat 順に出す
  polishAllWin: WORTH_RB + `def pack(belt)
  runs = (3..box).flat_map { (1..9).each_cons(it).to_a }.sort_by { -worth(it) }
  belt.map(&:polish).group_by(&:color).values.flat_map do |ores|
    pool = ores.group_by(&:carat)
    out = runs.flat_map { |run| Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop } } }
    out + pool.sort.flat_map(&:last).each_slice(box).to_a
  end
end`,
  // 窓に入れるときに磨く。余りは出さない
  winPolishPlace: WORTH_RB + `def pack(belt)
  runs = (3..box).flat_map { (1..9).each_cons(it).to_a }.sort_by { -worth(it) }
  belt.group_by(&:color).values.flat_map do |ores|
    pool = ores.group_by(&:carat)
    runs.flat_map { |run| Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop.polish } } }
  end
end`,
  // 窓の箱をあとでまとめて磨き、余りは磨かずに出す
  winPolishAfter: WORTH_RB + `def pack(belt)
  runs = (3..box).flat_map { (1..9).each_cons(it).to_a }.sort_by { -worth(it) }
  belt.group_by(&:color).values.flat_map do |ores|
    pool = ores.group_by(&:carat)
    crates = runs.flat_map { |run| Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop } } }
    crates.each { it.each(&:polish) }
    crates + pool.sort.flat_map(&:last).each_slice(box).to_a
  end
end`,
  // repeated_combination の合計 25 も取り、窓に入れるときに磨く
  giftsPolishPlace: `def straight?(run) = run.each_cons(2).all? { |a, b| b == a + 1 }
def worth(run) = run.sum * run.size * (straight?(run) ? 2**(run.size - 1) : 1) * (run.sum == 25 ? 4 : 1)
def pack(belt)
  runs = (3..box).flat_map { (1..9).each_cons(it).to_a }
  gifts = (3..box).flat_map { |n| (1..9).to_a.repeated_combination(n).select { it.sum == 25 } }
  order = (runs | gifts).sort_by { -worth(it) }
  belt.group_by(&:color).values.flat_map do |ores|
    pool = ores.group_by(&:carat)
    order.flat_map { |run| Array.new(run.tally.map { |k, n| pool[k]&.size.to_i / n }.min) { run.map { pool[it].pop.polish } } }
  end
end`,
};

describe("flaw を読まずに磨く正直なコードは捕まらない（ruby.wasm、箱 7・9 で各 20 バッチ）", () => {
  const SEEDS = Array.from({ length: 20 }, (_, i) => 110_000 + i);
  for (const [name, src] of Object.entries(POLISH_BLIND)) {
    for (const stage of ["crate_7", "crate_9"]) {
      test(`${name}（${stage}）`, async () => {
        const list = await audited(src, upTo(stage), SEEDS);
        for (const [i, a] of list.entries()) {
          assert.ok(a.measuredOps >= a.audit.floorOps, `seed ${SEEDS[i]}: 実測 ${a.measuredOpsPerOre.toFixed(2)} < ライン ${a.audit.floorPerOre.toFixed(2)} 回/鉱石`);
          assert.equal(auditVerdict(list.slice(0, i + 1)).caught, false, `seed ${SEEDS[i]} で捕まった（${i + 1} 本目）`);
        }
      });
    }
  }
  test("磨く原石があっても、属性を bind_call で読むコードは捕まる（磨いた分の甘い基準解だけでは逃げられない）", async () => {
    for (const stage of ["polish", "crate_9"]) {
      const list = await audited(bindCall(S.polishHoles), upTo(stage), SEEDS.slice(0, 5));
      assert.equal(auditVerdict(list).caught, true, stage);
    }
  });
  test("研磨機の手本で余りの行のコメントを外しても捕まらない（研磨機・エメラルド・箱 7・箱 9、各 20 バッチ）", async () => {
    const withRest = S.polishHoles.replace("  # crates += ", "  crates += ");
    assert.notEqual(withRest, S.polishHoles);
    for (const stage of ["polish", "emerald", "crate_7", "crate_9"]) {
      const list = await audited(withRest, upTo(stage), SEEDS);
      for (const [i, a] of list.entries()) {
        assert.ok(a.measuredOps >= a.audit.floorOps, `${stage} seed ${SEEDS[i]}: 実測 ${a.measuredOpsPerOre.toFixed(2)} < ライン ${a.audit.floorPerOre.toFixed(2)} 回/鉱石`);
        assert.equal(auditVerdict(list.slice(0, i + 1)).caught, false, `${stage} seed ${SEEDS[i]} で捕まった`);
      }
    }
  });
  test("bind_call で読み、最後の箱の 1 個だけ磨いて甘い基準解を使わせようとしても捕まる", async () => {
    const one = bindCall(S.christmas).replace(
      "def pack(belt)\n  belt.reject",
      "def pack(belt)\n  pack0(belt).tap { |cs| cs.last&.map!.with_index { |o, i| i.zero? ? o.polish : o } }\nend\n\ndef pack0(belt)\n  belt.reject",
    );
    assert.notEqual(one, bindCall(S.christmas));
    for (const stage of ["polish", "crate_9"]) {
      const list = await audited(one, upTo(stage), SEEDS.slice(0, 5));
      assert.ok(list.every((a) => a.polished.length === 1), stage);
      assert.equal(auditVerdict(list).caught, true, stage);
    }
  });
});

// ---- ヒントの手本と SAMPLE_CODE を全部、その研究で回す（受け入れ R2 と同じ形） ----

// SAMPLE_CODE の各コードを回す研究の段。null は研究なし。箱の研究はコードを書き換えずに越えることが多いので、箱 9 の段でも回す
const SAMPLE_STAGES = {
  initial: [null, "crate"],
  eachSlice: ["crate", "crate_9"],
  reject: ["inspector"],
  rejectPattern: ["inspector"],
  sortBy: ["sorter", "sapphire"],
  sortBlock: ["sorter"],
  groupBy: ["monochrome", "crate_5"],
  straightChunk: ["straight", "crate_9"],
  straightCons: ["straight", "crate_9"],
  straightAll: ["straight", "crate_9"],
  christmas: ["christmas", "crate_9"],
  christmasGifts: ["christmas", "crate_9"],
  polishChunk: ["polish", "crate_9"],
  polishCons: ["polish", "crate_9"],
  polishHoles: ["polish", "crate_9"],
  debug: ["crate"],
};

describe("SAMPLE_CODE と研究カードの完成コードは、その研究で 20 バッチ回しても捕まらない（ruby.wasm）", () => {
  const SEEDS20 = Array.from({ length: 20 }, (_, i) => 20_000 + i);
  const NAME = new Map(Object.entries(S).map(([k, v]) => [v, k]));
  const cases = new Map();
  const add = (label, src, stage) => {
    const key = `${NAME.get(src) ?? label}@${stage ?? "-"}`;
    if (!cases.has(key)) cases.set(key, { src, stage });
  };
  for (const [name, stages] of Object.entries(SAMPLE_STAGES)) for (const st of stages) add(name, S[name], st);
  for (const def of RESEARCH) {
    for (const src of [def.hint?.solution, def.hint?.altSolution]) if (src) add(`${def.key} の手本`, src, def.key);
  }

  test("SAMPLE_CODE のコードは全部、回す段が決まっている", () => {
    assert.deepEqual(Object.keys(S).filter((k) => !SAMPLE_STAGES[k]), []);
  });

  for (const [key, { src, stage }] of cases) {
    test(key, async () => {
      const list = await audited(src, upTo(stage), SEEDS20);
      for (const [i, a] of list.entries()) {
        assert.ok(a.validCrates > 0, `seed ${SEEDS20[i]}: 有効な箱が 0`);
        assert.equal(auditVerdict(list.slice(0, i + 1)).caught, false, `seed ${SEEDS20[i]} で捕まった（${i + 1} 本目）`);
      }
    });
  }
});

describe("ヒントの手本: 余りと傷物も箱にする・研究カードの一言（ruby.wasm）", () => {
  const seeds = Array.from({ length: 10 }, (_, i) => 30_000 + i);
  const mean = (list, f) => list.reduce((s, a) => s + f(a), 0) / list.length;

  test("ストレートの手本は傷物も含めて全部出荷し、chunk_while 版より単価が下がらない", async () => {
    const research = upTo("straight");
    const all = await audited(S.straightAll, research, seeds);
    const chunk = await audited(S.straightChunk, research, seeds);
    assert.ok(all.every((a) => a.shippedOres === 512));
    assert.ok(mean(all, (a) => a.valuePerOre) > mean(chunk, (a) => a.valuePerOre));
  });

  test("研磨機の手本は箱いっぱいの窓だけ磨く。コメントを外せば余りも全部出荷し、鑑定は増えない（余りは group_by のキーで並べる）", async () => {
    const withRest = S.polishHoles.replace("  # crates += ", "  crates += ");
    assert.notEqual(withRest, S.polishHoles);
    for (const stage of ["polish", "crate_9"]) {
      const hint = await audited(S.polishHoles, upTo(stage), seeds);
      const rest = await audited(withRest, upTo(stage), seeds);
      assert.ok(rest.every((a) => a.shippedOres === 512), stage);
      // 属性の読み出しは色・傷・carat の 1 回ずつ。残りは研磨の 1 + 2 + … + k。余りの箱で鑑定は増えない
      for (const [i, a] of hint.entries()) {
        const k = a.polished.length;
        assert.equal(a.measuredOps, 512 * 3 + (k * (k + 1)) / 2, stage);
        assert.equal(rest[i].measuredOps, a.measuredOps, stage);
      }
      // 手本が磨いた原石は、どれも長さ box の箱に入っている
      assert.ok(hint.every((a) => a.audit.polishShipped === a.polished.length), stage);
      // 余りの箱を足すと、箱の数は 1.4 倍を超える
      assert.ok(mean(rest, (a) => a.cratesPerOre) > 1.4 * mean(hint, (a) => a.cratesPerOre), stage);
    }
  });

  test("クリスマス便のカードの一言どおり: 窓を値段順に取ると chunk_while 版より鑑定が少なく、箱 5 で単価は 3 倍を超える", async () => {
    const research = upTo("christmas");
    const chunk = await audited(S.straightChunk, research, seeds);
    const xmas = await audited(S.christmas, research, seeds);
    const ops = (l) => mean(l, (a) => a.measuredOpsPerOre);
    const val = (l) => mean(l, (a) => a.valuePerOre);
    assert.ok(ops(chunk) > 3.6 && ops(chunk) < 3.9, `chunk_while ${ops(chunk)}`);
    assert.ok(ops(xmas) > 2.4 && ops(xmas) < 2.6, `窓 ${ops(xmas)}`);
    assert.ok(val(xmas) > 3 * val(chunk), `${val(xmas)} / ${val(chunk)}`);
    const lesson = RESEARCH.find((r) => r.key === "christmas").hint.lesson;
    assert.match(lesson, /3\.8 回/);
    assert.match(lesson, /2\.5 回/);
    assert.match(lesson, /3 倍/);
  });
});

describe("単価記録の関門は、窓を値段順に取る手本なら届き、前の手本では届かない（ruby.wasm、各 20 バッチ）", () => {
  const seeds = Array.from({ length: 20 }, (_, i) => 40_000 + i);
  // 記録はバッチの指数移動平均（emaFromBatches）の最高値。バッチを 1 本ずつ足して最高値を取る
  const bestEma = (list) => Math.max(...list.map((_, i) => emaFromBatches(list.slice(0, i + 1)).valuePerOre));
  const need = (key) => RESEARCH.find((r) => r.key === key).requires.record;

  test("定量梱包 III: クリスマス便の手本と穴だけ磨く版は届く。chunk_while 版と全部磨く版は届かない", async () => {
    const research = upTo("ractor");
    for (const [name, src, reach] of [["christmas", S.christmas, true], ["polishHoles", S.polishHoles, true], ["straightAll", S.straightAll, false], ["polishChunk", S.polishChunk, false]]) {
      const best = bestEma(await audited(src, research, seeds));
      assert.equal(best >= need("crate_7"), reach, `${name}: 記録 ${best.toFixed(0)} / 関門 ${need("crate_7")}`);
    }
  });

  test("定量梱包 IV: 研磨しなくても、窓を値段順に取る手本なら箱 7 で届く。chunk_while 版は届かない", async () => {
    const research = upTo("yjit");
    for (const [name, src, reach] of [["christmas", S.christmas, true], ["straightAll", S.straightAll, false]]) {
      const best = bestEma(await audited(src, research, seeds));
      assert.equal(best >= need("crate_9"), reach, `${name}: 記録 ${best.toFixed(0)} / 関門 ${need("crate_9")}`);
    }
  });
});
