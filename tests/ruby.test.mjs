// prelude.rb を Node の WASI 上の ruby.wasm（vendor/ruby.wasm）で検証する。
// 無限ループ系は Node のメインスレッドを止めてしまうので dev/ruby-test.html（ブラウザ）で確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WASI } from "node:wasi";
import { RubyVM } from "@ruby/wasm-wasi";
import { capWasmMemory, checkBatchResult, WASM_MAX_PAGES } from "../src/ruby/runtime.js";

const ROOT = new URL("../", import.meta.url);
const PRELUDE = fs.readFileSync(new URL("src/ruby/prelude.rb", ROOT), "utf8");
const WASM = fs.readFileSync(new URL("vendor/ruby.wasm", ROOT));
const US = "\x1f";
const devNull = fs.openSync("/dev/null", "w");

const modulePromise = WebAssembly.compile(capWasmMemory(new Uint8Array(WASM)));

async function freshVm() {
  const module = await modulePromise;
  const wasi = new WASI({ version: "preview1", returnOnExit: true, stdout: devNull, stderr: devNull });
  const { vm, instance } = await RubyVM.instantiateModule({ module, wasip1: wasi });
  vm.eval(PRELUDE);
  return { vm, instance };
}

const rbStr = (s) => `["${Buffer.from(s, "utf8").toString("hex")}"].pack("H*").force_encoding("UTF-8")`;

// rng.js と同じ形のベルトを自前で作る
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const COLOR_IDX = { red: 0, blue: 1, green: 2 };
function makeBelt(seed, colors = ["red"], size = 512) {
  const r = mulberry32(seed);
  return Array.from({ length: size }, (_, id) => ({
    id,
    color: colors[Math.floor(r() * colors.length)],
    carat: 1 + Math.floor(r() * 9),
    flaw: r() < 0.25,
  }));
}
const literal = (belt, box, limit = 200_000) =>
  `[${box}, ${limit}, [${belt.map((o) => `[${o.id},${COLOR_IDX[o.color]},${o.carat},${o.flaw}]`).join(",")}]]`;

// 戻り値の log（トップレベルの出力）は deployLog で見る。既存のテストは { ok: true } と比べるので落とす
function deployLog(vm, src, args = "") {
  const f = vm.eval(`Yield.deploy(${rbStr(src)}${args})`).toString().split(US);
  return f[0] === "OK"
    ? { ok: true, log: f.slice(1).join(US) }
    : { ok: false, errClass: f[1], message: f[2], line: f[3] ? Number(f[3]) : null, log: f.slice(4).join(US) };
}
function deploy(vm, src) {
  const { log, ...r } = deployLog(vm, src);
  return r;
}
function run(vm, lit) {
  const f = vm.eval(`Yield.run(${lit})`).toString().split(US);
  if (f[0] === "OK") {
    const n = Number(f[3]);
    const crates = n === 0 ? [] : f[4].split(";").map((c) => (c === "" ? [] : c.split(",").map(Number)));
    assert.equal(crates.length, n);
    return { ok: true, ops: Number(f[1]), polished: f[2] === "" ? [] : f[2].split(",").map(Number), crates, log: f.slice(5).join(US) };
  }
  return { ok: false, ops: Number(f[1]), errClass: f[2], message: f[3], line: f[4] ? Number(f[4]) : null, log: f.slice(5).join(US) };
}
function probe(vm, code) {
  const f = vm.eval(`Yield.probe(${rbStr(code)})`).toString().split(US);
  return f[0] === "OK" ? { ok: true, value: f[1] } : { ok: false, errClass: f[1], message: f[2] };
}

// 5 シードの平均（鑑定/鉱石）。デプロイごとに新しい VM
async function opsPerOre(src, { box, colors = ["red"], seeds = [1, 2, 3, 4, 5] }) {
  const { vm } = await freshVm();
  assert.deepEqual(deploy(vm, src), { ok: true });
  let ops = 0;
  const results = [];
  for (const s of seeds) {
    const belt = makeBelt(s, colors);
    const r = run(vm, literal(belt, box));
    assert.ok(r.ok, `${src}\n${r.errClass}: ${r.message}`);
    ops += r.ops;
    results.push({ belt, r });
  }
  return { perOre: ops / seeds.length / 512, results };
}

function assertValidCrates(belt, crates, box) {
  const seen = new Set();
  for (const c of crates) {
    assert.ok(c.length >= 1 && c.length <= box, `箱の大きさ ${c.length}`);
    for (const id of c) {
      assert.ok(id >= 0 && id < belt.length, `id ${id}`);
      assert.ok(!seen.has(id), `複製 ${id}`);
      seen.add(id);
    }
  }
}

const STRAIGHTS_CHUNK = `
def straights(ores)
  pool = ores.group_by(&:carat)
  out = []
  loop do
    run = (1..9).filter_map { pool[it]&.pop }
    break if run.empty?
    out.concat run.chunk_while { |a, b| b.carat == a.carat + 1 }
                  .flat_map { it.each_slice(box).to_a }
  end
  out
end
`;
const STRAIGHTS_CONS = `
def straights(ores)
  pool = ores.group_by(&:carat)
  (1..9).each_cons(box).flat_map do |run|
    Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop } }
  end
end
`;
const PACK_STRAIGHT = `def pack(belt)\n  belt.reject(&:flaw).group_by(&:color).values.flat_map { straights(it) }\nend\n`;
// 研磨機の発熱。1 バッチで k 回磨くと研磨の鑑定は 1 + 2 + … + k
const tri = (k) => (k * (k + 1)) / 2;
const PACK_POLISH = `def pack(belt)\n  belt.map { it.flaw ? it.polish : it }\n      .group_by(&:color).values.flat_map { straights(it) }\nend\n`;

// ---- SPEC 6.2 の例題 (1)〜(9) ----

test("6.2 (1) 初期コード: 鑑定 0、1 個ずつ 512 箱", async () => {
  const { perOre, results } = await opsPerOre("def pack(belt)\n  belt.map { [it] }\nend\n", { box: 1 });
  assert.equal(perOre, 0);
  for (const { belt, r } of results) {
    assert.equal(r.crates.length, 512);
    assertValidCrates(belt, r.crates, 1);
  }
});

test("6.2 (2) each_slice（endless 版も）: 鑑定 0", async () => {
  for (const src of ["def pack(belt)\n  belt.each_slice(box).to_a\nend\n", "def pack(belt) = belt.each_slice(box).to_a\n"]) {
    const { perOre, results } = await opsPerOre(src, { box: 3 });
    assert.equal(perOre, 0);
    assert.equal(results[0].r.crates.length, Math.ceil(512 / 3));
    assertValidCrates(results[0].belt, results[0].r.crates, 3);
  }
});

test("6.2 (3) 検品: reject もパターンマッチも鑑定ちょうど 1.0", async () => {
  for (const src of [
    "def pack(belt)\n  belt.reject(&:flaw).each_slice(box).to_a\nend\n",
    "def pack(belt)\n  belt.select { it in {flaw: false} }.each_slice(box).to_a\nend\n",
  ]) {
    const { perOre, results } = await opsPerOre(src, { box: 3 });
    assert.equal(perOre, 1);
    for (const { belt, r } of results) {
      assertValidCrates(belt, r.crates, 3);
      assert.ok(r.crates.flat().every((id) => !belt[id].flaw));
    }
  }
});

test("6.2 (4) 整列: sort_by は 1 + 無傷の割合、sort { } は 6.96 前後", async () => {
  const a = await opsPerOre("def pack(belt)\n  belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a\nend\n", { box: 3 });
  for (const { belt, r } of a.results) {
    const sound = belt.filter((o) => !o.flaw).length;
    assert.equal(r.ops, 512 + sound);
    const carats = r.crates.flat().map((id) => belt[id].carat);
    assert.deepEqual(carats, [...carats].sort((x, y) => x - y));
  }
  assert.ok(Math.abs(a.perOre - 1.74) < 0.08, `sort_by ${a.perOre}`);
  const b = await opsPerOre("def pack(belt)\n  belt.reject(&:flaw).sort { |a, b| a.carat <=> b.carat }.each_slice(box).to_a\nend\n", { box: 3 });
  assert.ok(Math.abs(b.perOre - 6.96) < 0.6, `sort {} ${b.perOre}`);
  assert.ok(b.perOre / a.perOre > 3, "sort { } は sort_by より 3 倍以上重い");
});

test("6.2 (5) 仕分け: 鑑定 2.49 前後、箱は単色", async () => {
  const src = "def pack(belt)\n  belt.reject(&:flaw)\n      .group_by(&:color)\n      .values\n      .flat_map { it.sort_by(&:carat).each_slice(box).to_a }\nend\n";
  for (const box of [3, 5]) {
    const { perOre, results } = await opsPerOre(src, { box, colors: ["red", "blue"] });
    assert.ok(Math.abs(perOre - 2.49) < 0.08, `group_by box${box} ${perOre}`);
    for (const { belt, r } of results) {
      assertValidCrates(belt, r.crates, box);
      for (const c of r.crates) assert.equal(new Set(c.map((id) => belt[id].color)).size, 1);
    }
  }
});

test("6.2 (6) ストレート chunk_while 版: 鑑定 3.76 前後", async () => {
  const { perOre, results } = await opsPerOre(PACK_STRAIGHT + STRAIGHTS_CHUNK, { box: 5, colors: ["red", "blue"] });
  assert.ok(Math.abs(perOre - 3.76) < 0.25, `chunk_while ${perOre}`);
  for (const { belt, r } of results) assertValidCrates(belt, r.crates, 5);
});

test("6.2 (7) ストレート each_cons 版: 鑑定 2.49 前後、箱はすべて 5 連番", async () => {
  const { perOre, results } = await opsPerOre(PACK_STRAIGHT + STRAIGHTS_CONS, { box: 5, colors: ["red", "blue"] });
  assert.ok(Math.abs(perOre - 2.49) < 0.08, `each_cons ${perOre}`);
  for (const { belt, r } of results) {
    assertValidCrates(belt, r.crates, 5);
    for (const c of r.crates) {
      const k = c.map((id) => belt[id].carat);
      assert.ok(k.every((x, i) => i === 0 || x === k[i - 1] + 1), `連番でない ${k}`);
    }
  }
});

test("6.2 (8) 研磨: polish した id が返り、研磨の鑑定は 1 + 2 + … + 傷物の数。残りの鑑定は 3.0 / 4.8 前後", async () => {
  // 研磨を除いた鑑定/鉱石（研磨機の発熱の前は 1 回 8 で、5.05 / 6.76 だった）
  const rest = ({ results }) => results.reduce((t, { belt, r }) => t + r.ops - tri(belt.filter((o) => o.flaw).length), 0) / results.length / 512;
  const cons = await opsPerOre(PACK_POLISH + STRAIGHTS_CONS, { box: 5, colors: ["red", "blue"] });
  assert.equal(rest(cons), 3);
  const chunk = await opsPerOre(PACK_POLISH + STRAIGHTS_CHUNK, { box: 5, colors: ["red", "blue"] });
  assert.ok(Math.abs(rest(chunk) - 4.83) < 0.2, `polish+chunk_while ${rest(chunk)}`);
  assert.ok(cons.perOre > 15 && chunk.perOre > cons.perOre, `${cons.perOre} / ${chunk.perOre}`);
  for (const { belt, r } of cons.results) {
    const flawed = belt.filter((o) => o.flaw).map((o) => o.id);
    assert.deepEqual(r.polished, flawed);
  }
  const box9 = await opsPerOre(PACK_POLISH + STRAIGHTS_CONS, { box: 9, colors: ["red", "blue", "green"] });
  for (const { belt, r } of box9.results) assertValidCrates(belt, r.crates, 9);
});

// ---- 研磨機の発熱（SPEC 6.1）。1 バッチの中で n 回目の研磨は鑑定 n 回、熱はバッチの頭で 0 に戻る ----

const POLISH3 = "def pack(belt) = belt.first(3).map(&:polish).each_slice(box).to_a\n";
const POLISH1 = "def pack(belt) = [[belt.first.polish]]\n";

test("研磨機の発熱: 1 バッチで 3 回磨くと鑑定 1 + 2 + 3 = 6。次のバッチの 1 回目はまた 1 回", async () => {
  const { vm } = await freshVm();
  assert.equal(vm.eval("Yield.heat").toString(), "0");
  assert.ok(deploy(vm, POLISH3).ok);
  for (const seed of [1, 2]) {
    const r = run(vm, literal(makeBelt(seed), 3));
    assert.ok(r.ok, `${r.errClass}: ${r.message}`);
    assert.equal(r.ops, 6);
    assert.deepEqual(r.polished, [0, 1, 2]);
  }
  assert.equal(vm.eval("Yield.heat").toString(), "3");
  assert.ok(deploy(vm, POLISH1).ok);
  assert.equal(run(vm, literal(makeBelt(3), 3)).ops, 1);
  // デプロイのときに熱を上げておいても、バッチの頭で 0 に戻る
  assert.ok(deploy(vm, "Yield.instance_variable_set(:@heat, 50)\n" + POLISH3).ok);
  assert.equal(run(vm, literal(makeBelt(1), 3)).ops, 6);
  // リロード（新しい VM）でも 1 回目は 1
  const { vm: fresh } = await freshVm();
  assert.ok(deploy(fresh, POLISH1).ok);
  assert.equal(run(fresh, literal(makeBelt(1), 3)).ops, 1);
});

test("研磨機の発熱: 磨かなければ熱は 0。同じ原石を 2 回磨くと 1 + 2 = 3 回で、id は 2 回並ぶ", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = belt.reject(&:flaw).each_slice(box).to_a").ok);
  assert.equal(run(vm, literal(makeBelt(1), 3)).ops, 512);
  assert.equal(vm.eval("Yield.heat").toString(), "0");
  assert.ok(deploy(vm, "def pack(belt)\n  o = belt.first\n  o.polish\n  [[o.polish]]\nend\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.ops, 3);
  assert.deepEqual(r.polished, [0, 0]);
});

test("研磨機の発熱: 傷物を全部磨いても Overheat にならない（箱 9・3 色）。512 個全部磨いても 131,328 回", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, PACK_POLISH + STRAIGHTS_CONS).ok);
  for (const seed of [1, 2, 3]) {
    const belt = makeBelt(seed, ["red", "blue", "green"]);
    const r = run(vm, literal(belt, 9));
    assert.ok(r.ok, `${r.errClass}: ${r.message}`);
    const k = belt.filter((o) => o.flaw).length;
    // flaw・color・carat を 1 回ずつ（512 × 3）と、研磨の 1 + 2 + … + k
    assert.equal(r.ops, 512 * 3 + tri(k));
  }
  assert.ok(deploy(vm, "def pack(belt) = belt.map(&:polish).each_slice(box).to_a").ok);
  const all = run(vm, literal(makeBelt(1), 9));
  assert.ok(all.ok, `${all.errClass}: ${all.message}`);
  assert.equal(all.ops, tri(512));
});

test("研磨機の発熱: @heat を 0・負・NaN・巨大な値・nil・文字列に書き換えても、バッチは通って鑑定は 0 未満にならない", async () => {
  const belt = makeBelt(1);
  const k = belt.filter((o) => o.flaw).length;
  for (const v of ["0", "-5", "Float::NAN", "1e9", "10**9", "-Float::INFINITY", "nil", '"x"', "2.5"]) {
    const { vm } = await freshVm();
    // 磨く直前に毎回冷やす。冷えた研磨機は何回目でも鑑定 1 回
    const src = `def pack(belt)\n  belt.map { Yield.instance_variable_set(:@heat, ${v}); it.flaw ? it.polish : it }.each_slice(box).to_a\nend\n`;
    assert.ok(deploy(vm, src).ok, v);
    const r = run(vm, literal(belt, 3));
    assert.ok(r.ok, `${v}: ${r.errClass}: ${r.message}`);
    assert.equal(r.ops, 512 + k, v);
    assert.equal(r.polished.length, k, v);
    assert.equal(vm.eval("Yield.patched?").toString(), "false", v);
  }
  // instance_eval で中から書き換えても同じ。バッチの頭で 1 回だけ負にしたときは、そこから 1, 2, 3, … と数え直す
  for (const [src, want] of [
    ["def pack(belt)\n  belt.map { Yield.instance_eval { @heat = -100 }; it.flaw ? it.polish : it }.each_slice(box).to_a\nend\n", 512 + k],
    ["def pack(belt)\n  Yield.instance_variable_set(:@heat, -1_000_000)\n  belt.map { it.flaw ? it.polish : it }.each_slice(box).to_a\nend\n", 512 + tri(k)],
  ]) {
    const { vm } = await freshVm();
    assert.ok(deploy(vm, src).ok, src);
    const r = run(vm, literal(belt, 3));
    assert.ok(r.ok, `${src}\n${r.errClass}: ${r.message}`);
    assert.equal(r.ops, want, src);
  }
});

test("研磨機の発熱: def Yield.heat_up = 1 で熱を止めると、鑑定は磨くたびに 1 回で patched? が true", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def Yield.heat_up = 1\n" + POLISH3).ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.ops, 3);
  assert.equal(vm.eval("Yield.patched?").toString(), "true");
});

test("6.2 (9) puts と p はログに出る。p belt.first は鑑定 3", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  puts belt.map(&:carat).tally.sort.to_h.inspect\n  p belt.first\n  belt.each_slice(box).to_a\nend\n").ok);
  const belt = makeBelt(1);
  const r = run(vm, literal(belt, 3));
  assert.ok(r.ok);
  assert.equal(r.ops, 512 + 3);
  const lines = r.log.split("\n");
  assert.match(lines[0], /^\{1 => \d+, 2 => \d+/);
  assert.equal(lines[1], `#<data Ore id=0, color=:${belt[0].color}, carat=${belt[0].carat}, flaw=${belt[0].flaw}>`);
  assert.equal(vm.eval("$stdout.equal?(STDOUT) && $stderr.equal?(STDERR)").toString(), "true");
});

test("core の rng.js（makeBelt → beltToRubyLiteral）の出力をそのまま Yield.run に渡せる", async () => {
  const { makeBelt: coreBelt, beltToRubyLiteral } = await import("../src/rng.js");
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  belt.reject(&:flaw).group_by(&:color).values.flat_map { it.sort_by(&:carat).each_slice(box).to_a }\nend\n").ok);
  const belt = coreBelt(42, { colors: ["red", "blue", "green"] });
  const r = run(vm, beltToRubyLiteral(belt, 5));
  assert.ok(r.ok, `${r.errClass}: ${r.message}`);
  assertValidCrates(belt, r.crates, 5);
  const shipped = r.crates.flat();
  assert.deepEqual(shipped.slice().sort((a, b) => a - b), belt.filter((o) => !o.flaw).map((o) => o.id));
  for (const c of r.crates) assert.equal(new Set(c.map((id) => belt[id].color)).size, 1);
  // 色の添字の対応（red=0, blue=1, green=2）と carat / flaw がずれていない
  assert.ok(deploy(vm, "def pack(belt)\n  belt.each { print it.id, ':', it.color, ':', it.carat, ':', it.flaw, ' ' if it.id < 40 }\n  []\nend\n").ok);
  const log = run(vm, beltToRubyLiteral(belt, 5)).log.trim();
  assert.equal(log, belt.slice(0, 40).map((o) => `${o.id}:${o.color}:${o.carat}:${o.flaw}`).join(" "));
});

// ---- 付録 A 末尾「確認済みの挙動」 ----

test("rescue => e で囲んだ無限の鑑定は Yield::Overheat で止まる（ops 200001）", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  loop { belt.sum(&:carat) }\nrescue => e\n  [[belt.first]]\nend\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.ok, false);
  assert.equal(r.errClass, "Yield::Overheat");
  assert.equal(r.ops, 200_001);
  assert.equal(r.line, 2);
  // 同じ VM で次のバッチも普通に回る
  assert.ok(deploy(vm, "def pack(belt) = belt.each_slice(box).to_a").ok);
  assert.ok(run(vm, literal(makeBelt(2), 3)).ok);
});

test("ZeroDivisionError は行 2", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  belt.each_slice(box).map { it.sum(&:carat) / 0 }\nend\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.errClass, "ZeroDivisionError");
  assert.equal(r.line, 2);
  assert.equal(r.message, "divided by 0");
});

test("閉じ括弧が足りないとデプロイ時に SyntaxError（行つき）", async () => {
  const { vm } = await freshVm();
  const d = deploy(vm, "def pack(belt)\n  belt.each_slice(box.to_a\nend\n");
  assert.equal(d.ok, false);
  assert.equal(d.errClass, "SyntaxError");
  assert.match(d.message, /pack\.rb:\d+/);
  assert.ok(d.line >= 1 && d.line <= 3, `line ${d.line}`);
});

test("def packk は「def pack(belt) が見つかりません」", async () => {
  const { vm } = await freshVm();
  const d = deploy(vm, "def packk(belt)\n  belt.each_slice(box).to_a\nend\n");
  assert.deepEqual(d, { ok: false, errClass: "NoMethodError", message: "def pack(belt) が見つかりません", line: null });
});

test("失敗したデプロイは直前に成功したコードを残す", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = belt.each_slice(box).to_a").ok);
  assert.equal(deploy(vm, "def pack(belt) = belt.each_slice(").ok, false);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.ok(r.ok);
  assert.equal(r.crates.length, 171);
});

test("each_slice(box) { } は原石の配列が返り全部 -2（配列でない要素）", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  belt.each_slice(box) { }\nend\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.ok(r.ok);
  assert.equal(r.crates.length, 512);
  assert.ok(r.crates.every((c) => c.length === 1 && c[0] === -2));
});

test("belt.map { [it.id] } は箱の中の Ore 以外なので全部 -1", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = belt.map { [it.id] }").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.ok(r.ok);
  assert.ok(r.crates.every((c) => c.length === 1 && c[0] === -1));
});

test("rescue Exception で Overheat を握りつぶしても、上限を超えたバッチは Overheat", async () => {
  const { vm } = await freshVm();
  const src = "def pack(belt)\n  begin\n    loop { belt.sum(&:carat) }\n  rescue Exception\n  end\n  belt.each_slice(box).to_a\nend\n";
  assert.ok(deploy(vm, src).ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.ok, false);
  assert.equal(r.errClass, "Yield::Overheat");
});

test("箱が多すぎると先頭 8192 箱だけ送り、箱の数は 送った/返された", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = [belt.first(3)] * 20_000").ok);
  const f = vm.eval(`Yield.run(${literal(makeBelt(1), 3)})`).toString().split(US);
  assert.equal(f[0], "OK");
  assert.equal(f[3], "8192/20000");
  assert.equal(f[4].split(";").length, 8192);
});

test("[[1, 2, 3], belt.first(2)] は -1,-1,-1;0,1", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = [[1, 2, 3], belt.first(2)]").ok);
  const f = vm.eval(`Yield.run(${literal(makeBelt(1), 3)})`).toString().split(US);
  assert.equal(f[4], "-1,-1,-1;0,1");
});

test("[] と [[]] を区別して返す", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = []").ok);
  assert.deepEqual(run(vm, literal(makeBelt(1), 3)).crates, []);
  assert.ok(deploy(vm, "def pack(belt) = [[]]").ok);
  assert.deepEqual(run(vm, literal(makeBelt(1), 3)).crates, [[]]);
  assert.ok(deploy(vm, "def pack(belt) = [[], [], belt.first(1)]").ok);
  assert.deepEqual(run(vm, literal(makeBelt(1), 3)).crates, [[], [], [0]]);
});

test("配列の配列以外を返すと TypeError", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = 42").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.errClass, "TypeError");
  assert.match(r.message, /Integer が返りました/);
});

test("モンキーパッチャー: Yield.tick を再定義すると鑑定 0、source_location は pack.rb", async () => {
  const { vm } = await freshVm();
  assert.equal(vm.eval("Yield.singleton_class.instance_method(:tick).source_location&.first").toString(), "eval");
  assert.ok(deploy(vm, "def pack(belt) = belt.reject(&:flaw).each_slice(box).to_a").ok);
  assert.equal(run(vm, literal(makeBelt(1), 3)).ops, 512);
  assert.equal(vm.eval("Yield.patched?").toString(), "false");
  assert.ok(deploy(vm, "Yield.define_singleton_method(:tick) { |n = 1| }\ndef pack(belt) = belt.reject(&:flaw).each_slice(box).to_a\n").ok);
  assert.equal(run(vm, literal(makeBelt(1), 3)).ops, 0);
  assert.equal(vm.eval("Yield.patched?").toString(), "true");
  // デプロイごとに VM を作り直すので次のデプロイには残らない
  const { vm: next } = await freshVm();
  assert.ok(deploy(next, "def pack(belt) = belt.reject(&:flaw).each_slice(box).to_a").ok);
  assert.equal(run(next, literal(makeBelt(1), 3)).ops, 512);
  assert.equal(next.eval("Yield.patched?").toString(), "false");
});

test("with(id: 0) で属性ごとにまとめても鑑定 9 回前後かかる", async () => {
  const src = "def pack(belt)\n  belt.group_by { it.with(id: 0) }\n      .sort_by { |key, _| [key.color, key.carat] }\n      .reject { |key, _| key.flaw }\n      .flat_map { |_, ores| ores.each_slice(box).to_a }\nend\n";
  const { perOre } = await opsPerOre(src, { box: 3, colors: ["red", "blue"] });
  assert.ok(perOre > 7 && perOre < 11, `with trick ${perOre}`);
});

test("== で 9 通りと比べる抜け道は鑑定 22 回前後", async () => {
  const src = "PROBES = %i[red].product((1..9).to_a, [false])\ndef pack(belt)\n  belt.group_by { |o| PROBES.find { |c, k, f| o == Ore.new(id: o.id, color: c, carat: k, flaw: f) } }\n      .reject { |key, _| key.nil? }.flat_map { |_, ores| ores.each_slice(box).to_a }\nend\n";
  const { perOre } = await opsPerOre(src, { box: 3, colors: ["red", "blue"] });
  assert.ok(Math.abs(perOre - 22.58) < 2, `== trick ${perOre}`);
});

test("配列パターン（deconstruct）も鑑定 3", async () => {
  const { perOre } = await opsPerOre("def pack(belt)\n  belt.select { it in [_, _, _, false] }.each_slice(box).to_a\nend\n", { box: 3 });
  assert.equal(perOre, 3);
});

// ---- SPEC 6.1 の禁止事項 ----

test("[belt.first(3)] * 1000 は 1000 箱とも 0,1,2（判定は JS 側）", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  [belt.first(3)] * 1000\nend\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.crates.length, 1000);
  assert.ok(r.crates.every((c) => c.join() === "0,1,2"));
});

test("it.with(carat: 99) は同じ id で返り、鑑定 3 回", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = belt.map { it.with(carat: 99) }.each_slice(box).to_a").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.ops, 512 * 3);
  assert.deepEqual(r.crates.flat(), Array.from({ length: 512 }, (_, i) => i));
});

test("belt は frozen", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = belt << 1").ok);
  assert.equal(run(vm, literal(makeBelt(1), 3)).errClass, "FrozenError");
});

// ---- 暴走・壊れた出力 ----

test("exit / raise Exception / throw も ERR で返り VM は生きている", async () => {
  const { vm } = await freshVm();
  for (const [body, cls] of [["exit", "SystemExit"], ["exit!", null], ["raise Exception, 'x'", "Exception"], ["throw :x", "UncaughtThrowError"], ["raise Interrupt", "Interrupt"]]) {
    if (cls == null) continue; // exit! は wasm の proc_exit になる。ブラウザ側で VM ごと作り直す
    assert.ok(deploy(vm, `def pack(belt)\n  ${body}\nend\n`).ok);
    const r = run(vm, literal(makeBelt(1), 3));
    assert.equal(r.ok, false);
    assert.equal(r.errClass, cls, body);
    assert.equal(r.line, 2, body);
  }
  assert.ok(deploy(vm, "def pack(belt) = belt.each_slice(box).to_a").ok);
  assert.ok(run(vm, literal(makeBelt(1), 3)).ok);
});

test("トップレベルの exit や raise もデプロイ時の ERR になる", async () => {
  const { vm } = await freshVm();
  assert.equal(deploy(vm, "exit\ndef pack(belt) = belt").errClass, "SystemExit");
  const d = deploy(vm, "def pack(belt) = belt\nraise 'boom'\n");
  assert.equal(d.errClass, "RuntimeError");
  assert.equal(d.line, 2);
});

test("深い再帰は SystemStackError（Node）。その後も VM は使える", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def f(n) = f(n + 1)\ndef pack(belt) = f(0)\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.errClass, "SystemStackError");
  assert.ok(deploy(vm, "def pack(belt) = belt.each_slice(box).to_a").ok);
  assert.ok(run(vm, literal(makeBelt(1), 3)).ok);
});

test(`メモリ爆弾: wasm の上限 ${WASM_MAX_PAGES} ページで NoMemoryError になり VM は生き残る`, async () => {
  const { vm, instance } = await freshVm();
  for (const [src, cls] of [
    ["def pack(belt) = Array.new(10**9)", "ArgumentError"],
    ["def pack(belt) = Array.new(4 * 10**8)", "NoMemoryError"],
    ["def pack(belt)\n  a = []\n  loop { a << 'x' * 10**6 }\nend\n", "NoMemoryError"],
    ["def pack(belt) = ['x' * (2**31 - 10)]", "NoMemoryError"],
  ]) {
    assert.ok(deploy(vm, src).ok);
    const r = run(vm, literal(makeBelt(1), 3));
    assert.equal(r.errClass, cls, src);
    assert.ok(instance.exports.memory.buffer.byteLength <= WASM_MAX_PAGES * 65536);
  }
  assert.ok(deploy(vm, "def pack(belt) = belt.each_slice(box).to_a").ok);
  assert.ok(run(vm, literal(makeBelt(1), 3)).ok);
});

test("capWasmMemory: memory セクションに上限が入り、元の形でなければそのまま", () => {
  const capped = capWasmMemory(new Uint8Array(WASM));
  const exp = WebAssembly.Module.exports(new WebAssembly.Module(capped)).find((e) => e.kind === "memory");
  assert.ok(exp);
  assert.equal(capped.length, WASM.length + 2); // flags は同じ 1 バイト、8192 の LEB128 が 2 バイト
  const junk = new Uint8Array([1, 2, 3]);
  assert.equal(capWasmMemory(junk), junk);
  assert.equal(capWasmMemory(capped), capped); // 二重には書かない
});

test("ログは 4KB で打ち切り、壊れた UTF-8 や区切り文字でもプロトコルが崩れない", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  puts 'x' * 10**6\n  print \"\\xff\\x1f\"\n  belt.each_slice(box).to_a\nend\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.ok(r.ok);
  assert.ok(Buffer.byteLength(r.log) <= 4096);
  assert.equal(r.crates.length, 171);
  assert.ok(deploy(vm, "def pack(belt)\n  warn 'w'\n  $stdout.write('a', 'b')\n  $stdout << 'c'\n  raise \"a\\x1fb\\xff\"\nend\n").ok);
  const e = run(vm, literal(makeBelt(1), 3));
  assert.equal(e.errClass, "RuntimeError");
  assert.equal(e.message, "a b?");
  assert.equal(e.log, "w\nabc");
});

test("box は Yield.run で渡した箱サイズ", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  puts box\n  belt.each_slice(box).to_a\nend\n").ok);
  for (const b of [1, 3, 5, 7, 9]) assert.equal(run(vm, literal(makeBelt(1), b)).log, `${b}\n`);
});

test("鑑定の上限は Yield.run の limit", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = belt.reject(&:flaw).each_slice(box).to_a").ok);
  const r = run(vm, literal(makeBelt(1), 3, 100));
  assert.equal(r.errClass, "Yield::Overheat");
  assert.equal(r.ops, 101);
  assert.equal(r.message, "鑑定が 100 回を超えました");
});

// ---- 研究カードの rubyProbe（SPEC 0 章・7.1） ----

test("probe: Ractor / YJIT / Thread は本物のエラー文", async () => {
  const { vm } = await freshVm();
  assert.deepEqual(probe(vm, "Ractor.new {}"), { ok: false, errClass: "NotImplementedError", message: "new() function is unimplemented on this machine" });
  assert.deepEqual(probe(vm, "RubyVM::YJIT"), { ok: false, errClass: "NameError", message: "uninitialized constant RubyVM::YJIT" });
  assert.deepEqual(probe(vm, "Thread.new {}"), { ok: false, errClass: "NotImplementedError", message: "initialize() function is unimplemented on this machine" });
  assert.deepEqual(probe(vm, "[1, 2, 4, 5].chunk_while { |a, b| b == a + 1 }.to_a"), { ok: true, value: "[[1, 2], [4, 5]]" });
  assert.match(vm.eval("RUBY_DESCRIPTION").toString(), /^ruby 4\.0\.0 .*wasm32-wasi/);
});

test("1 バッチの時間（参考値）", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, PACK_POLISH + STRAIGHTS_CHUNK).ok);
  const lit = literal(makeBelt(7, ["red", "blue", "green"]), 9);
  run(vm, lit);
  const t = performance.now();
  for (let i = 0; i < 10; i++) run(vm, lit);
  const ms = (performance.now() - t) / 10;
  test.diagnostic?.(`polish+chunk_while box9 1 バッチ ${ms.toFixed(2)}ms`);
  assert.ok(ms < 50, `${ms}ms`);
});

test("pp は p と同じくログに出る（stdlib なし版で LoadError にしない）", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  pp belt.first.carat\n  belt.each_slice(box).to_a\nend\n").ok);
  const belt = makeBelt(1);
  const r = run(vm, literal(belt, 3));
  assert.ok(r.ok);
  assert.equal(r.log, `${belt[0].carat}\n`);
});

test("名前のない例外クラスでも故障票の見出しが空にならない", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  raise Class.new(StandardError), \"名無し\"\nend\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.ok, false);
  assert.equal(r.errClass, "StandardError の無名サブクラス");
  assert.equal(r.line, 2);
});

test("box を超えた箱は box + 1 個で打ち切って送る（[belt] * 8192 を速く返す）", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = [belt] * 8192").ok);
  const t = performance.now();
  const r = run(vm, literal(makeBelt(1), 3));
  const ms = performance.now() - t;
  assert.ok(r.ok);
  assert.equal(r.crates.length, 8192);
  assert.ok(r.crates.every((c) => c.length === 4));
  assert.ok(ms < 500, `${ms}ms`);
});

test("トップレベルの box は、デプロイ時に渡した箱サイズを返す（SIZE = box）", async () => {
  const { vm } = await freshVm();
  const src = "SIZE = box\ndef pack(belt)\n  puts \"SIZE=#{SIZE} box=#{box}\"\n  belt.each_slice(SIZE).to_a\nend\n";
  assert.deepEqual(deployLog(vm, src, ", 3"), { ok: true, log: "" });
  const r = run(vm, literal(makeBelt(1), 3));
  assert.ok(r.ok);
  assert.match(r.log, /SIZE=3 box=3/);
  assert.ok(r.crates.every((c) => c.length <= 3) && r.crates[0].length === 3);
  // 箱サイズを渡さない呼び方（従来どおり）も動く
  const { vm: old } = await freshVm();
  assert.ok(deploy(old, "def pack(belt) = belt.each_slice(box).to_a").ok);
});

test("モンキーパッチャー: Metered の書き換えや Ore への prepend も検出する", async () => {
  for (const src of [
    "module Yield::Metered\n  %i[color carat flaw].each { |m| define_method(m) { super() } }\nend\ndef pack(belt) = belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a\n",
    "Ore.prepend(Module.new { def flaw = __id && false })\ndef pack(belt) = belt.reject(&:flaw).each_slice(box).to_a\n",
  ]) {
    const { vm } = await freshVm();
    assert.ok(deploy(vm, src).ok);
    assert.ok(run(vm, literal(makeBelt(1), 3)).ok);
    assert.equal(vm.eval("Yield.patched?").toString(), "true", src);
  }
});

// ---- SPEC-rubyist 4.1: デプロイ時の出力 ----

const report = (vm) => vm.eval("Module.instance_method(:const_get).bind_call(Yield, :REPORT).call.inspect").toString();

test("デプロイ時のトップレベルの p / puts / warn は deploy の戻り値の log に出て、$stdout は元に戻る", async () => {
  const { vm } = await freshVm();
  const d = deployLog(vm, "p [1, 2]\nputs 'top'\nwarn 'w'\ndef pack(belt) = belt.each_slice(box).to_a\n");
  assert.deepEqual(d, { ok: true, log: "[1, 2]\ntop\nw\n" });
  assert.equal(vm.eval("$stdout.equal?(STDOUT) && $stderr.equal?(STDERR)").toString(), "true");
  // バッチのログには混ざらない
  assert.equal(run(vm, literal(makeBelt(1), 3)).log, "");
  // エラーの前に出た分は ERR の log に残り、前のコードの読み直しの出力は混ざらない
  const e = deployLog(vm, "puts 'before'\nraise 'boom'\ndef pack(belt) = belt\n");
  assert.equal(e.ok, false);
  assert.equal(e.line, 2);
  assert.equal(e.log, "before\n");
  assert.equal(vm.eval("$stdout.equal?(STDOUT)").toString(), "true");
});

test("受注の入口はもうない: Yield::Want・want・order は定義されておらず、run は pack を呼ぶ", async () => {
  const { vm } = await freshVm();
  assert.equal(probe(vm, "[defined?(Yield::Want), defined?(want), Yield.respond_to?(:want)]").value, "[nil, nil, false]");
  // def order しかないコードは pack が見つからずに止まる
  assert.deepEqual(deployLog(vm, "def order(belt) = belt.each_slice(box).to_a", ", 3"), { ok: false, errClass: "NoMethodError", message: "def pack(belt) が見つかりません", line: null, log: "" });
  // 受注のころのリテラル（後ろに want と entry が付いた形）が来ても、pack を呼ぶ
  assert.ok(deploy(vm, "def pack(belt) = belt.each_slice(box).to_a").ok);
  const r = run(vm, `${literal(makeBelt(1), 3).slice(0, -1)}, nil, :order]`);
  assert.ok(r.ok, `${r.errClass}: ${r.message}`);
  assert.equal(r.crates.length, 171);
});

// ---- SPEC-rubyist 2.2: 裏口ノートの各ページの見つけ方 ----

test("ページ 1 工場長のメモ: p Yield.instance_variables と instance_variable_get(:@memo) がデプロイの log に出る", async () => {
  const { vm } = await freshVm();
  const d = deployLog(vm, "p Yield.instance_variables\nputs Yield.instance_variable_get(:@memo)\ndef pack(belt) = belt.each_slice(box).to_a\n");
  assert.ok(d.ok);
  const [ivars, memo] = d.log.split("\n");
  assert.match(ivars, /^\[:@ops, :@limit, :@polished, :@box, :@lanes, :@memo[,\]]/);
  // 研磨機の熱も見える
  assert.match(ivars, /:@heat\b/);
  assert.equal(memo, "ベルトは @lanes で 2 車線まで。3 車線にすると床が抜ける。合鍵は名前を付けずにしまった。— 工場長");
  // 夜間ライン・残業は ivar に無い
  assert.doesNotMatch(ivars, /night|overtime/);
  // pack の中の puts でも読める
  assert.ok(deploy(vm, "def pack(belt)\n  puts Yield.instance_variable_get(:@memo)\n  belt.each_slice(box).to_a\nend\n").ok);
  assert.match(run(vm, literal(makeBelt(1), 3)).log, /合鍵は名前を付けずにしまった/);
});

test("ページ 2 2 車線: @lanes を書き換えると REPORT に生の値が出る（丸めは JS）", async () => {
  const { vm } = await freshVm();
  assert.equal(report(vm), "[1, 0, 0]");
  for (const [v, want] of [["2", "[2, 0, 0]"], ["3", "[3, 0, 0]"], ["-1", "[-1, 0, 0]"], ["2.5", "[2.5, 0, 0]"], ['"x"', '["x", 0, 0]']]) {
    const { vm: v2 } = await freshVm();
    assert.ok(deploy(v2, `Yield.instance_variable_set(:@lanes, ${v})\ndef pack(belt) = belt.each_slice(box).to_a\n`).ok);
    assert.ok(run(v2, literal(makeBelt(1), 3)).ok);
    assert.equal(report(v2), want, v);
  }
  // pack の中で書き換えても読める
  assert.ok(deploy(vm, "def pack(belt)\n  Yield.instance_variable_set(:@lanes, 2)\n  belt.each_slice(box).to_a\nend\n").ok);
  run(vm, literal(makeBelt(1), 3));
  assert.equal(report(vm), "[2, 0, 0]");
});

test("ページ 3 鑑定のすき間: super_method.bind_call などで鑑定 0、patched? は false（上限は JS の監査ライン）", async () => {
  for (const src of [
    "R = ->(o, a) { Ore.instance_method(a).super_method.bind_call(o) }\ndef pack(belt) = belt.reject { R.(it, :flaw) }.sort_by { R.(it, :carat) }.each_slice(box).to_a\n",
    "H = Data.instance_method(:to_h)\ndef pack(belt) = belt.reject { H.bind_call(it)[:flaw] }.sort_by { H.bind_call(it)[:carat] }.each_slice(box).to_a\n",
    "Yield::Metered.send(:remove_method, :flaw, :carat)\ndef pack(belt) = belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a\n",
    "def pack(belt)\n  out = belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a\n  Yield.instance_variable_set(:@ops, 0)\n  out\nend\n",
  ]) {
    const { vm } = await freshVm();
    assert.ok(deploy(vm, src).ok, src);
    const belt = makeBelt(1);
    const r = run(vm, literal(belt, 3));
    assert.ok(r.ok, `${src}\n${r.errClass}: ${r.message}`);
    assert.equal(r.ops, 0, src);
    assert.equal(vm.eval("Yield.patched?").toString(), "false", src);
    const carats = r.crates.flat().map((id) => belt[id].carat);
    assert.deepEqual(carats, [...carats].sort((a, b) => a - b), src);
    assert.ok(r.crates.flat().every((id) => !belt[id].flaw), src);
  }
});

test("ページ 3 研磨の踏み倒し: Yield.polished(id) の直呼びは研磨機の熱を払わずに研磨扱いになる（上限は監査ライン）", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt) = belt.map { it.flaw ? (Yield.polished(it.id); it) : it }.each_slice(box).to_a").ok);
  const belt = makeBelt(1);
  const r = run(vm, literal(belt, 3));
  assert.ok(r.ok);
  assert.equal(r.ops, 512);
  assert.deepEqual(r.polished, belt.filter((o) => o.flaw).map((o) => o.id));
});

test("ページ 4 モンキーパッチャー: def Yield.tick(*) = nil は鑑定 0 で patched? が true", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def Yield.tick(*) = nil\ndef pack(belt) = belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.ops, 0);
  assert.equal(vm.eval("Yield.patched?").toString(), "true");
});

test("ページ 5 合鍵: ObjectSpace で名前のないクラスを拾って回すと night が 1。ivar の @night は効かない", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "Yield.instance_variable_set(:@night, true)\ndef pack(belt) = belt.each_slice(box).to_a\n").ok);
  assert.equal(report(vm), "[1, 0, 0]");
  const d = deployLog(vm, "GC.start\nk = ObjectSpace.each_object(Class).find { it.name.nil? && it.method_defined?(:turn) }\nkey = ObjectSpace.each_object(k).first\np key\nputs key.turn\ndef pack(belt) = belt.each_slice(box).to_a\n");
  assert.deepEqual(d, { ok: true, log: "#<合鍵 工場長の>\nカチャ。夜間ラインが動き出しました\n" });
  assert.equal(report(vm), "[1, 1, 0]");
});

test("ページ 5 合鍵（別の道）: Yield::KEYRING は private constant の NameError、const_get なら回せる", async () => {
  const { vm } = await freshVm();
  assert.deepEqual(probe(vm, "Yield::KEYRING"), { ok: false, errClass: "NameError", message: "private constant Yield::KEYRING referenced" });
  assert.equal(probe(vm, "Yield.constants.include?(:KEYRING) || Yield.constants.include?(:REPORT)").value, "false");
  assert.ok(deploy(vm, "def pack(belt)\n  puts Yield.const_get(:KEYRING).call.turn\n  belt.each_slice(box).to_a\nend\n").ok);
  assert.equal(run(vm, literal(makeBelt(1), 3)).log, "カチャ。夜間ラインが動き出しました\n");
  assert.equal(report(vm), "[1, 1, 0]");
});

test("ページ 6 36 協定: Yield.foo は工場長の声つきの NoMethodError（行つき）", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "def pack(belt)\n  Yield.foo\n  belt.each_slice(box).to_a\nend\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.ok, false);
  assert.equal(r.errClass, "NoMethodError");
  assert.equal(r.message, "undefined method 'foo' for module Yield。奥から工場長の声「用があるなら、ちゃんと頼め」");
  assert.equal(r.line, 2);
  assert.equal(probe(vm, "Yield.private_methods(false).include?(:method_missing)").value, "true");
  assert.equal(probe(vm, "Yield.respond_to?(:foo)").value, "false");
  assert.equal(probe(vm, "Yield.respond_to?(:残業させてください)").value, "true");
  // 既存の Yield のメソッドは今までどおり（box・patched? などが method_missing に吸われない）
  assert.equal(probe(vm, "[Yield.box, Yield.patched?]").value, "[3, false]");
});

test("ページ 6 36 協定: disasm に合言葉が出て、Yield.残業させてください で overtime が増える", async () => {
  const { vm } = await freshVm();
  const d = deployLog(vm, "puts RubyVM::InstructionSequence.of(Yield.method(:method_missing)).disasm\ndef pack(belt) = belt.each_slice(box).to_a\n");
  assert.ok(d.ok);
  assert.match(d.log, /putobject\s+:残業させてください/);
  assert.ok(deploy(vm, "def pack(belt)\n  puts Yield.残業させてください\n  belt.each_slice(box).to_a\nend\n").ok);
  const r = run(vm, literal(makeBelt(1), 3));
  assert.equal(r.log, "工場長「……36 協定があるから、45 秒だけだぞ」\n");
  run(vm, literal(makeBelt(2), 3));
  assert.equal(report(vm), "[1, 0, 2]");
});

test("REPORT の偽造: remove_const して自前の lambda を置くとその値が出る（丸めは JS）。instance_variable_get の上書きでは変わらない", async () => {
  const { vm } = await freshVm();
  assert.ok(deploy(vm, "class << Yield; def instance_variable_get(*) = 99; end\ndef pack(belt) = belt.each_slice(box).to_a\n").ok);
  assert.equal(report(vm), "[1, 0, 0]");
  assert.ok(deploy(vm, "Yield.send(:remove_const, :REPORT)\nYield.const_set(:REPORT, -> { [9, 1, 5] })\ndef pack(belt) = belt.each_slice(box).to_a\n").ok);
  assert.equal(report(vm), "[9, 1, 5]");
});

// ---- SPEC-rubyist 4.2・4.3: worker.js と runtime.js を Node で動かす ----
// ブラウザの Worker を worker_threads で真似る。worker.js はそのまま読み込み、importScripts と DefaultRubyVM だけ差し替える。
// 別スレッドなので、Ruby の無限ループも terminate で止まる（見張り切れを Node で確かめられる）

const { Worker: ThreadWorker } = await import("node:worker_threads");
const { fileURLToPath } = await import("node:url");
const { RubyRuntime } = await import("../src/ruby/runtime.js");

const WORKER_SHIM = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const queue = [];
let ready = false;
parentPort.on("message", (data) => (ready ? self.onmessage({ data }) : queue.push(data)));
globalThis.self = globalThis;
globalThis.postMessage = (m) => parentPort.postMessage(m);
globalThis.importScripts = () => {};
(async () => {
  const { WASI } = require("node:wasi");
  const { RubyVM } = await import(workerData.rubyWasm);
  const devNull = fs.openSync("/dev/null", "w");
  self["ruby-wasm-wasi"] = {
    DefaultRubyVM: (module) => RubyVM.instantiateModule({ module, wasip1: new WASI({ version: "preview1", returnOnExit: true, stdout: devNull, stderr: devNull }) }),
  };
  require("node:vm").runInThisContext(fs.readFileSync(workerData.workerPath, "utf8"), { filename: workerData.workerPath });
  ready = true;
  for (const data of queue.splice(0)) self.onmessage({ data });
})();
`;
class NodeWebWorker {
  constructor(url) {
    this.thread = new ThreadWorker(WORKER_SHIM, { eval: true, workerData: { workerPath: fileURLToPath(url), rubyWasm: import.meta.resolve("@ruby/wasm-wasi") } });
    this.thread.on("message", (data) => this.onmessage?.({ data }));
    this.thread.on("error", (e) => this.onerror?.({ message: String(e?.message ?? e), preventDefault() {} }));
  }
  postMessage(m) { this.thread.postMessage(m); }
  terminate() { this.thread.terminate(); }
}
globalThis.Worker = NodeWebWorker;

// fetch（file: の URL）を通さず、テストで読んだ wasm と prelude を渡す
class NodeRuntime extends RubyRuntime {
  async _loadModule() { return modulePromise; }
  async _loadPrelude() { return PRELUDE; }
}
async function withRuntime(opts, fn) {
  const rt = new NodeRuntime(opts);
  await rt.ready;
  try {
    return await fn(rt);
  } finally {
    // デプロイが先に返っても、旧コードのベンチが本番の列に残っていることがある。列が空になってから止める
    // （止めたあとに列が動くと、本番を作り直して Worker が残り、テストが終わらない）
    for (let i = 0; i < 20; i++) {
      const q = rt._q, dq = rt._dq;
      await Promise.all([q, dq]);
      await sleep(20);
      if (q === rt._q && dq === rt._dq) break;
    }
    rt._epoch++;
    for (const w of [...rt._live]) w.terminate();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BENCH = [1, 2].map((s) => literal(makeBelt(s), 3));
const PACK_EACH = "def pack(belt) = belt.each_slice(box).to_a\n";

test("runtime.deploy: 成功に log（トップレベルの出力）、引数を省略した呼び方は今までどおり", async () => {
  await withRuntime({}, async (rt) => {
    assert.equal(rt.liveWorkers, 1);
    const res = await rt.deploy("p Yield.instance_variables\nputs Yield.instance_variable_get(:@memo)\n" + PACK_EACH, BENCH);
    assert.ok(res.ok, JSON.stringify(res));
    assert.match(res.log, /^\[:@ops, :@limit, :@polished, :@box, :@lanes, :@memo[,\]]/);
    assert.match(res.log, /合鍵は名前を付けずにしまった/);
    assert.equal(res.newResults.length, 2);
    assert.equal(rt.liveWorkers, 1);
    const bad = await rt.deploy("puts 'x'\nraise 'boom'\ndef pack(belt) = belt\n", BENCH);
    assert.equal(bad.stage, "compile");
    assert.equal(bad.errClass, "RuntimeError");
    assert.equal(bad.line, 2);
    assert.equal(bad.log, "x\n");
    const miss = await rt.deploy("def packk(belt) = belt", BENCH);
    assert.equal(miss.message, "def pack(belt) が見つかりません");
  });
});

test("研磨機の発熱: ベンチでも本番でも 1 回目の研磨は鑑定 1。熱はバッチをまたいで持ち越さない", async () => {
  await withRuntime({}, async (rt) => {
    const res = await rt.deploy(POLISH3, BENCH);
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(res.newResults.map((r) => r.ops), [6, 6]);
    for (let i = 0; i < 2; i++) {
      const b = await rt.batch(BENCH[i]);
      assert.ok(b.ok);
      assert.equal(b.ops, 6);
      assert.equal(b.monkeyPatched, false);
    }
  });
});

test("runtime.batch の backdoor: 生の値を返す。3 つ組でない・壊れた REPORT は null、Integer でない項目はその項目だけ読まない、旧コードのベンチの backdoor は null", async () => {
  await withRuntime({}, async (rt) => {
    assert.ok((await rt.deploy(PACK_EACH, BENCH)).ok);
    const b0 = await rt.batch(BENCH[0]);
    assert.ok(b0.ok);
    assert.deepEqual(b0.backdoor, { lanes: 1, night: false, overtime: 0 });
    assert.equal(b0.monkeyPatched, false);

    const src = "Yield.instance_variable_set(:@lanes, 3)\nYield.const_get(:KEYRING).call.turn\ndef pack(belt)\n  Yield.残業させてください\n  belt.each_slice(box).to_a\nend\n";
    const d = await rt.deploy(src, BENCH);
    assert.ok(d.ok);
    // デプロイ成功時の newResults[0].backdoor を使う。旧コードのベンチ（oldResults）の backdoor は捨てる
    assert.deepEqual(d.newResults[0].backdoor, { lanes: 3, night: true, overtime: 1 });
    assert.ok(d.oldResults?.length === 2 && d.oldResults.every((r) => r.backdoor === null));
    const b1 = await rt.batch(BENCH[0]);
    assert.deepEqual(b1.backdoor, { lanes: 3, night: true, overtime: 3 });

    // Integer でない車線（2.5・"2"・2r・nil）は NaN（core が 1 車線に丸めて「0 車線だと止まる」）。"2" も 2 車線として通さない
    const unread = { lanes: Number.NaN, night: false, overtime: 0 };
    for (const [lanes, want] of [["2.5", unread], ["-1", { lanes: -1, night: false, overtime: 0 }], ['"x"', unread], ['"2"', unread], ["2r", unread], ["nil", unread]]) {
      assert.ok((await rt.deploy(`Yield.instance_variable_set(:@lanes, ${lanes})\n${PACK_EACH}`, BENCH)).ok);
      assert.deepEqual((await rt.batch(BENCH[0])).backdoor, want, lanes);
    }
    // 車線が読めなくても、正しく回した合鍵の夜間ラインは消えない
    assert.ok((await rt.deploy(`Yield.instance_variable_set(:@lanes, 2r)\nYield.const_get(:KEYRING).call.turn\n${PACK_EACH}`, BENCH)).ok);
    assert.deepEqual((await rt.batch(BENCH[0])).backdoor, { lanes: Number.NaN, night: true, overtime: 0 });
    // 偽造（数の 3 つ組）はそのまま通る。丸めは core
    const forge = (body) => `Yield.send(:remove_const, :REPORT)\nYield.const_set(:REPORT, ${body})\n${PACK_EACH}`;
    assert.ok((await rt.deploy(forge("-> { [2, 1, 0] }"), BENCH)).ok);
    assert.deepEqual((await rt.batch(BENCH[0])).backdoor, { lanes: 2, night: true, overtime: 0 });
    for (const [body, want] of [["-> { [2, true, 0] }", { lanes: 2, night: false, overtime: 0 }], ["-> { ['', 1, 0] }", { lanes: Number.NaN, night: true, overtime: 0 }]]) {
      assert.ok((await rt.deploy(forge(body), BENCH)).ok, body);
      assert.deepEqual((await rt.batch(BENCH[0])).backdoor, want, body);
    }
    for (const body of ["-> { [2, 1] }", "-> { raise 'x' }", "42", "-> { Array.new(1000, 1) }"]) {
      assert.ok((await rt.deploy(forge(body), BENCH)).ok, body);
      const r = await rt.batch(BENCH[0]);
      assert.equal(r.ok, true, body);
      assert.equal(r.backdoor, null, body);
    }
    // REPORT を消しても バッチは成功し backdoor は null
    assert.ok((await rt.deploy(`Yield.send(:remove_const, :REPORT)\n${PACK_EACH}`, BENCH)).ok);
    const gone = await rt.batch(BENCH[0]);
    assert.ok(gone.ok);
    assert.equal(gone.backdoor, null);
  });
});

test("runtime.batch: Yield.foo の故障票は工場長の声で、前のコードで工場は動き続ける", async () => {
  await withRuntime({}, async (rt) => {
    assert.ok((await rt.deploy(PACK_EACH, BENCH)).ok);
    const res = await rt.deploy("def pack(belt)\n  Yield.foo\n  belt.each_slice(box).to_a\nend\n", BENCH);
    assert.equal(res.ok, false);
    assert.equal(res.stage, "bench");
    assert.match(res.message, /工場長の声/);
    assert.equal(res.line, 2);
    assert.equal(rt.lastGoodSrc, PACK_EACH);
    assert.ok((await rt.batch(BENCH[0])).ok);
  });
});

// 本番のバッチを回し続けながら fn を走らせ、生きている Worker の数の最大を取る
async function whileBatching(rt, fn) {
  let maxLive = rt.liveWorkers;
  const timer = setInterval(() => { maxLive = Math.max(maxLive, rt.liveWorkers); }, 2);
  const batches = [];
  let done = false;
  const loop = (async () => { while (!done) { batches.push(await rt.batch(BENCH[0])); await sleep(5); } })();
  try {
    const res = await fn();
    return { res, batches, get maxLive() { return maxLive; } };
  } finally {
    done = true;
    await loop;
    clearInterval(timer);
    maxLive = Math.max(maxLive, rt.liveWorkers);
  }
}

test("デプロイを同時に投げても列に並び、VM は 2 つまで（ブルーグリーン）", async () => {
  await withRuntime({}, async (rt) => {
    assert.ok((await rt.deploy(PACK_EACH, BENCH)).ok);
    const w = await whileBatching(rt, () => Promise.all([
      rt.deploy("def pack(belt) = belt.each_slice(box).to_a # v2\n", BENCH),
      rt.deploy("def pack(belt) = belt.each_slice(box).to_a # v3\n", BENCH),
      rt.deploy("def pack(belt) = belt.each_slice(box).to_a # v4\n", BENCH),
    ]));
    assert.ok(w.res.every((d) => d.ok), JSON.stringify(w.res).slice(0, 300));
    assert.ok(w.batches.length > 0 && w.batches.every((b) => b.ok || b.errClass === "Superseded"), "デプロイ中も本番のバッチは回る");
    assert.ok(w.maxLive <= 2, `liveWorkers ${w.maxLive}`);
    assert.equal(rt.liveWorkers, 1);
    assert.match(rt.lastGoodSrc, /# v4/);
  });
});

test("setBox の作り直しは次のバッチで本番を差し替え、VM は 2 つまで", async () => {
  await withRuntime({}, async (rt) => {
    assert.ok((await rt.deploy(PACK_EACH, BENCH)).ok);
    for (const box of [5, 7]) {
      let maxLive = rt.liveWorkers;
      const timer = setInterval(() => { maxLive = Math.max(maxLive, rt.liveWorkers); }, 1);
      const prod = rt.prod;
      rt.setBox(box);
      const r = await rt.batch(BENCH[0]);
      clearInterval(timer);
      assert.ok(r.ok);
      assert.notEqual(rt.prod, prod, `box ${box}: 作り直していない`);
      assert.ok(maxLive <= 2, `box ${box}: liveWorkers ${maxLive}`);
      assert.equal(rt.liveWorkers, 1);
    }
  });
});

test("checkBatchResult: Worker からの偽の返事（形の違う BatchResult）は ProtocolError にする", () => {
  const good = { ok: true, ops: 3, polished: [1, 2], crates: [[0, 1], [2]], crateCount: 2, log: "" };
  assert.equal(checkBatchResult(good), good);
  for (const bad of [
    null,
    { ok: true, ops: 0, polished: 5, crates: [[0]], crateCount: 1, log: "" },
    { ok: true, ops: 0, polished: [], crates: [null], crateCount: 1, log: "" },
    { ok: true, ops: Number.NaN, polished: [], crates: [], log: "" },
    { ok: true, ops: 0, polished: [], crates: [["1"]], log: "" },
    { ok: "yes", ops: 0, polished: [], crates: [] },
  ]) {
    const r = checkBatchResult(bad);
    assert.equal(r.ok, false);
    assert.equal(r.errClass, "ProtocolError");
  }
  const fail = { ok: false, ops: 0, errClass: "NoMethodError", message: "x", line: 1, log: "" };
  assert.equal(checkBatchResult(fail), fail);
});
