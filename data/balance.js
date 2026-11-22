// def pack(belt) の数値表（SPEC 5 章・7 章）。シミュレーション（tools/econ.mjs）も同じ表を読む。

export const COLORS = [
  { key: "red", label: "ルビー", unit: 1, hex: "#e0115f" },
  { key: "blue", label: "サファイア", unit: 2, hex: "#2f6fed" },
  { key: "green", label: "エメラルド", unit: 4, hex: "#1fbf75" },
];

export const BATCH_SIZE = 512;
export const OPS_LIMIT = 200_000;
export const COST_GROWTH = 1.15;
export const FLAW_RATE = 0.25;
export const CARAT_MAX = 9;

// 5.3 採掘（個/秒）。つるはしは最初から 1 本ある
export const MINES = [
  { key: "pickaxe", label: "つるはし", rate: 0.5, base: 10, initial: 1 },
  { key: "drill", label: "削岩ドリル", rate: 4, base: 150 },
  { key: "rig", label: "採掘リグ", rate: 30, base: 2_000 },
  { key: "boring", label: "ボーリングマシン", rate: 250, base: 30e3 },
  { key: "ship", label: "地殻掘削船", rate: 2_000, base: 600e3 },
  { key: "mantle", label: "マントルタップ", rate: 16_000, base: 15e6 },
  { key: "coredrill", label: "コアドリル", rate: 130_000, base: 500e6 },
  { key: "planet", label: "惑星コア", rate: 1_000_000, base: 40e9 },
];

// 5.4 ベルト（容量 個/秒）。段階強化で 1 回きり。添字が段階
export const BELTS = [
  { label: "黄", cap: 8, price: 0, color: "#f5c518" },
  { label: "赤", cap: 40, price: 500, color: "#e5383b" },
  { label: "青", cap: 200, price: 8_000, color: "#3a86ff" },
  { label: "紫", cap: 1_000, price: 150e3, color: "#9b5de5" },
  { label: "赤熱", cap: 5_000, price: 3e6, color: "#ff6d00" },
  { label: "ルビー", cap: 25_000, price: 30e6, color: "#e0115f" },
  { label: "ミスリル", cap: 125_000, price: 600e6, color: "#b8f2e6" },
  { label: "量子", cap: 625_000, price: 6e9, color: "#00f5d4" },
  { label: "無限", cap: 20_000_000, price: 20e9, color: "#ffffff" },
];

// 5.5 工場（CPU 鑑定/秒）
export const CPU_BASE = 10;
export const CPUS = [
  { key: "core", label: "コア", rate: 10, base: 500 },
  { key: "server", label: "サーバー", rate: 100, base: 7_500 },
  { key: "rack", label: "ラック", rate: 1_000, base: 125e3 },
  { key: "datacenter", label: "データセンター", rate: 10_000, base: 2.5e6 },
  { key: "cloud", label: "クラウド", rate: 100_000, base: 60e6 },
  { key: "supercomputer", label: "スパコン", rate: 1_000_000, base: 1e9 },
];

// 5.6 出荷ドック（箱/秒）
export const DOCK_BASE = 2;
export const DOCKS = [
  { key: "truck", label: "トラック", rate: 2, base: 80 },
  { key: "train", label: "貨物列車", rate: 25, base: 2_000 },
  { key: "freighter", label: "貨物船", rate: 300, base: 50e3 },
  { key: "airlift", label: "輸送機", rate: 3_000, base: 1.5e6 },
  { key: "elevator", label: "軌道エレベータ", rate: 250_000, base: 4.5e9 },
];

// 5.8 ボーナス。研究で開いたものだけ掛ける
export const BONUSES = {
  flawless: { label: "無傷", mul: 3 },
  mono: { label: "単色", mul: 3 },
  ascending: { label: "昇順", mul: 2 },
  straight: { label: "STRAIGHT", mul: null }, // ×2^(個数-1)
  christmas: { label: "クリスマス便", mul: 4, sum: 25 }, // carat の合計がちょうど sum の箱
};

// ---- 研究のヒント（SPEC 6.2 / 6.3） ----

const STRAIGHTS_CHUNK = `def straights(ores)
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

const STRAIGHTS_CONS = `def straights(ores)
  pool = ores.group_by(&:carat)
  (1..9).each_cons(box).flat_map do |run|
    Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop } }
  end
end
`;

// クリスマス便の手本。長さ 3〜box の窓を、箱の値段の高い順（箱 5 なら 3..7 が先）に取る
const STRAIGHTS_BY_WORTH = `# 箱の値段の目安。carat の合計 × 個数 × STRAIGHT の倍率。合計 25 ならさらに ×4
def worth(run)
  run.sum * run.size * 2**(run.size - 1) * (run.sum == 25 ? 4 : 1)
end

def straights(ores)
  pool = ores.group_by(&:carat)
  runs = (3..box).flat_map { (1..9).each_cons(it).to_a }
  runs.sort_by { -worth(it) }.flat_map do |run|
    Array.new(run.map { pool[it]&.size.to_i }.min) { run.map { pool[it].pop } }
  end
end
`;

// もう一段。1 ずつ続かなくても合計 25 の組み合わせ（5,5,5,5,5 など）を repeated_combination で拾い、窓と一緒に値段順に詰める
const STRAIGHTS_GIFTS = `def straight?(run) = run.each_cons(2).all? { |a, b| b == a + 1 }

# 箱の値段の目安。carat の合計 × 個数 × STRAIGHT の倍率。合計 25 ならさらに ×4
def worth(run)
  run.sum * run.size * (straight?(run) ? 2**(run.size - 1) : 1) * (run.sum == 25 ? 4 : 1)
end

def straights(ores)
  pool = ores.group_by(&:carat)
  runs = (3..box).flat_map { (1..9).each_cons(it).to_a }
  gifts = (3..box).flat_map { |n| (1..9).to_a.repeated_combination(n).select { it.sum == 25 } }
  (runs | gifts).sort_by { -worth(it) }.flat_map do |run|
    Array.new(run.tally.map { |k, n| pool[k]&.size.to_i / n }.min) { run.map { pool[it].pop } }
  end
end
`;

const PACK_STRAIGHT = `def pack(belt)
  belt.reject(&:flaw).group_by(&:color).values.flat_map { straights(it) }
end
`;

// ストレートの手本。傷物も捨てずに、色ごとに carat の順で詰めて売る。
// 余りの箱は単価を 1% ほどしか上げず、箱の数が 2 割増えるので、ドックが赤のときは消した方が稼げる
const PACK_STRAIGHT_ALL = `def pack(belt)
  good, bad = belt.partition { !it.flaw }
  crates = good.group_by(&:color).values.flat_map { straights(it) }
  # 傷物も捨てずに、色ごとに carat の順で詰めて売る。単色 ×3 と昇順 ×2 が付く
  # 箱の数が増えるので、ドックが赤のときはこの行を消した方が稼げる
  crates + bad.group_by(&:color).values.flat_map { it.sort_by(&:carat).each_slice(box).to_a }
end
`;

const PACK_POLISH = `def pack(belt)
  belt.map { it.flaw ? it.polish : it }
      .group_by(&:color).values.flat_map { straights(it) }
end
`;

// 研磨機の手本。磨くほど研磨機が熱くなる（n 回目は鑑定 n 回）ので、全部は磨かない。
// 傷のない原石で窓を埋め、箱いっぱい（長さ box）の窓だけ、足りない carat は傷物を磨いて埋める。
// 長さ box の窓は STRAIGHT の倍率が一番大きいので、1 回の研磨で上がる単価も一番大きい。
// 穴を全部磨く版や余りも箱にする版より、鑑定と箱の数が少なく、単価はほぼ同じ（箱 5〜9 で 97〜98%）。
// 余りの箱は単価を 1% ほどしか上げず、箱の数が 1.5〜2 倍になるので、コメントにして残す
const PACK_HOLES = `def pack(belt)
  groups = belt.group_by(&:color).values.map do |ores|
    good, bad = ores.partition { !it.flaw }
    [good.group_by(&:carat), bad.group_by(&:carat)]
  end
  crates = groups.flat_map { |pool, spare| straights(pool, spare) }
  # 余った原石も箱にするなら、次の行の # を外す。単価は少し上がるが、箱の数は 1.5〜2 倍になる
  # crates += groups.flatten(1).flat_map { it.sort.flat_map(&:last).each_slice(box).to_a }
  crates
end

# 箱の値段の目安。carat の合計 × 個数 × STRAIGHT の倍率。合計 25 ならさらに ×4
def worth(run)
  run.sum * run.size * 2**(run.size - 1) * (run.sum == 25 ? 4 : 1)
end

# 窓は傷のない原石で埋める。箱いっぱいの窓だけ、足りない carat は傷物を磨いて埋める
def straights(pool, spare)
  runs = (3..box).flat_map { (1..9).each_cons(it).to_a }
  runs.sort_by { -worth(it) }.flat_map do |run|
    crates = []
    while run.all? { pool[it]&.any? || (run.size == box && spare[it]&.any?) }
      crates << run.map { pool[it]&.pop || spare[it].pop.polish }
    end
    crates
  end
end
`;

const PACK_GROUP = `def pack(belt)
  belt.reject(&:flaw)
      .group_by(&:color)
      .values
      .flat_map { it.sort_by(&:carat).each_slice(box).to_a }
end
`;

export const SAMPLE_CODE = {
  initial: `def pack(belt)
  belt.map { [it] }
end
`,
  eachSlice: `def pack(belt)
  belt.each_slice(box).to_a
end
`,
  reject: `def pack(belt)
  belt.reject(&:flaw).each_slice(box).to_a
end
`,
  rejectPattern: `def pack(belt)
  belt.select { it in {flaw: false} }.each_slice(box).to_a
end
`,
  sortBy: `def pack(belt)
  belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a
end
`,
  sortBlock: `def pack(belt)
  belt.reject(&:flaw).sort { |a, b| a.carat <=> b.carat }.each_slice(box).to_a
end
`,
  groupBy: PACK_GROUP,
  straightChunk: PACK_STRAIGHT + "\n" + STRAIGHTS_CHUNK,
  straightCons: PACK_STRAIGHT + "\n" + STRAIGHTS_CONS,
  straightAll: PACK_STRAIGHT_ALL + "\n" + STRAIGHTS_CHUNK,
  christmas: PACK_STRAIGHT + "\n" + STRAIGHTS_BY_WORTH,
  christmasGifts: PACK_STRAIGHT + "\n" + STRAIGHTS_GIFTS,
  polishChunk: PACK_POLISH + "\n" + STRAIGHTS_CHUNK,
  polishCons: PACK_POLISH + "\n" + STRAIGHTS_CONS,
  polishHoles: PACK_HOLES,
  debug: `def pack(belt)
  puts belt.map(&:carat).tally.sort.to_h.inspect
  p belt.first
  belt.each_slice(box).to_a
end
`,
};

// effect の種類: { box } / { bonus } / { color } / { polish } / { cpuMul, rubyProbe } / { opsMul, rubyProbe } / { ending }
// requires: { record: n, note }（単価記録と、届かせ方の一言）。前提関係は配列の順の 1 本道
// hint.uses: 研究を「コードに取り入れた」とみなすメソッド。どれもデプロイ中のコードになければ、その研究の tip を出し続ける
export const RESEARCH = [
  {
    key: "crate", gem: "crate", version: "1.0.0", label: "定量梱包 I", price: 50,
    effect: { box: 3 }, requires: null,
    summary: "箱に 3 個まで詰められる（box が 3 になる）",
    hint: {
      methods: ["each_slice"],
      example: "[1, 2, 3, 4, 5].each_slice(3).to_a #=> [[1, 2, 3], [4, 5]]",
      skeleton: "def pack(belt)\n  # box は 1 箱に詰められる数（いまは 3）\n  belt.each_slice(box) # ← 配列にする\nend\n",
      solution: SAMPLE_CODE.eachSlice,
      tip: "3 個ずつ詰めよう: each_slice",
      uses: ["each_slice", "each_cons", "chunk_while", "slice_when"],
    },
  },
  {
    key: "inspector", gem: "inspector", version: "1.0.0", label: "検品", price: 400,
    effect: { bonus: "flawless" }, requires: null,
    summary: "傷のない原石だけの箱は ×3",
    hint: {
      methods: ["reject", "select"],
      example: "[1, 2, 3, 4].reject(&:even?) #=> [1, 3]",
      skeleton: "def pack(belt)\n  belt.reject { ... }.each_slice(box).to_a\nend\n",
      solution: SAMPLE_CODE.reject,
      tip: "flaw が true の原石を外そう: reject",
      uses: ["reject", "select", "filter", "filter_map", "partition", "polish"],
    },
  },
  {
    key: "sorter", gem: "sorter", version: "1.0.0", label: "整列", price: 150e3,
    effect: { bonus: "ascending" }, requires: null,
    summary: "carat が昇順の箱は ×2",
    hint: {
      methods: ["sort_by", "sort"],
      example: "%w[ccc a bb].sort_by(&:size) #=> [\"a\", \"bb\", \"ccc\"]",
      skeleton: "def pack(belt)\n  belt.reject(&:flaw).sort_by { ... }.each_slice(box).to_a\nend\n",
      solution: SAMPLE_CODE.sortBy,
      tip: "carat の順に並べよう: sort_by",
      uses: ["sort_by", "sort", "chunk_while", "each_cons"],
    },
  },
  {
    key: "sapphire", gem: "sapphire", version: "1.0.0", label: "サファイア鉱脈", price: 300e3,
    effect: { color: "blue" }, requires: null,
    summary: "青い原石が混ざる。色単価は 2",
    hint: {
      methods: [],
      example: "",
      skeleton: "",
      solution: SAMPLE_CODE.sortBy,
      tip: "コードはそのままで単価が上がります",
    },
  },
  {
    key: "monochrome", gem: "monochrome", version: "1.0.0", label: "仕分け", price: 20e6,
    effect: { bonus: "mono" }, requires: null,
    summary: "1 色だけの箱は ×3",
    hint: {
      methods: ["group_by", "values", "flat_map"],
      example: "%w[a bb c dd].group_by(&:size).values #=> [[\"a\", \"c\"], [\"bb\", \"dd\"]]",
      skeleton: "def pack(belt)\n  belt.reject(&:flaw)\n      .group_by(&:color)\n      .values\n      .flat_map { ... }\nend\n",
      solution: SAMPLE_CODE.groupBy,
      tip: "色ごとに分けよう: group_by",
      uses: ["group_by", "partition", "chunk"],
    },
  },
  {
    key: "crate_5", gem: "crate_5", version: "2.0.0", label: "定量梱包 II", price: 250e6,
    effect: { box: 5 }, requires: null,
    summary: "箱に 5 個まで詰められる（box が 5 になる）",
    hint: {
      methods: ["each_slice"],
      example: "",
      skeleton: "",
      solution: SAMPLE_CODE.groupBy,
      tip: "box を読むコードなら、書き換えなしで単価が上がります",
    },
  },
  {
    key: "straight", gem: "straight", version: "1.0.0", label: "ストレート", price: 2e9,
    effect: { bonus: "straight" }, requires: { record: 400, note: "group_by で色ごとに分けるコードなら、箱 5 で届きます" },
    summary: "carat が 1 ずつ続く箱は ×2^(個数-1)",
    hint: {
      methods: ["chunk_while", "each_cons"],
      example: "[1, 2, 4, 5].chunk_while { |a, b| b == a + 1 }.to_a #=> [[1, 2], [4, 5]]\n(1..9).each_cons(5).first #=> [1, 2, 3, 4, 5]",
      skeleton: PACK_STRAIGHT + "\ndef straights(ores)\n  pool = ores.group_by(&:carat)   # carat => 原石の配列\n  # 1, 2, 3, ... と続く並びを作って box 個ずつ詰める\nend\n",
      solution: SAMPLE_CODE.straightAll,
      altSolution: SAMPLE_CODE.straightCons,
      tip: "carat が 1 ずつ続くように詰めよう: chunk_while / each_cons",
      uses: ["chunk_while", "each_cons", "slice_when"],
    },
  },
  {
    // 12/25 のリリースにちなんで合計 25。3..7 のストレートは ×16 と重なって ×64 になる
    key: "christmas", gem: "christmas", version: "12.25.0", label: "クリスマス便", price: 5e9,
    effect: { bonus: "christmas" }, requires: null,
    summary: "carat の合計がちょうど 25 の箱は ×4",
    hint: {
      methods: ["sum", "sort_by", "each_cons", "repeated_combination"],
      example: "(1..9).each_cons(5).map(&:sum) #=> [15, 20, 25, 30, 35]\n(1..9).each_cons(5).sort_by { -it.sum * (it.sum == 25 ? 4 : 1) }.first #=> [3, 4, 5, 6, 7]",
      skeleton: PACK_STRAIGHT + "\ndef straights(ores)\n  pool = ores.group_by(&:carat)\n  runs = (3..box).flat_map { (1..9).each_cons(it).to_a }\n  runs.sort_by { ... }   # 値段の高い窓から。合計 25 なら ×4\n      .flat_map { |run| ... }\nend\n",
      solution: SAMPLE_CODE.christmas,
      altSolution: SAMPLE_CODE.christmasGifts,
      tip: "3..7 の窓を先に取ると ×64。窓を値段の順に並べよう: sum / sort_by",
      // 研究カードにだけ出す一言。数字は ruby.wasm の実測（箱 5・2 色、50 シード）。
      // chunk_while 版 3.76 回・$4.4K、窓を値段順に取る手本 2.52 回・$14K。クリスマス便を数えない窓でも $6.3K
      lesson: "覚えたてのメソッドが一番とは限りません。chunk_while 版は隣どうしの carat を読み直すので、鑑定が 1 鉱石あたり 3.8 回かかります。長さ 3〜box の窓を値段の高い順に取れば 2.5 回で済み、箱 5 なら単価も 3 倍を超えます",
      uses: ["sum", "repeated_combination", "combination"],
    },
  },
  {
    key: "polish", gem: "polish", version: "1.0.0", label: "研磨機", price: 70e9,
    effect: { polish: true }, requires: null,
    summary: "ore.polish で傷を消せる。磨くほど研磨機が熱くなり、1 バッチで n 回目の研磨には鑑定が n 回かかる",
    hint: {
      methods: ["polish", "partition"],
      example: "[1, 2, 3, 4].partition(&:odd?) #=> [[1, 3], [2, 4]]\npool[k]&.pop || spare[k].pop.polish   # 足りないときだけ磨く",
      skeleton: "def pack(belt)\n  belt.group_by(&:color).values.flat_map { straights(it) }\nend\n\ndef straights(ores)\n  good, bad = ores.partition { !it.flaw }\n  # 窓は good で埋める。箱いっぱいの窓だけ、足りない carat は bad から磨いて埋める\nend\n",
      solution: SAMPLE_CODE.polishHoles,
      altSolution: SAMPLE_CODE.polishChunk,
      tip: "全部磨くと研磨機が真っ赤になる。磨くのは、倍率が一番大きい箱いっぱいの窓の穴だけにしよう: partition",
      uses: ["polish"],
    },
  },
  {
    key: "emerald", gem: "emerald", version: "1.0.0", label: "エメラルド鉱脈", price: 500e9,
    effect: { color: "green" }, requires: null,
    summary: "緑の原石が混ざる。色単価は 4",
    hint: { methods: [], example: "", skeleton: "", solution: "", tip: "色ごとに分けていれば、そのままで単価が上がります" },
  },
  {
    key: "ractor", gem: "ractor", version: "0.1.0", label: "Ractor", price: 800e9,
    effect: { cpuMul: 4, rubyProbe: "Ractor.new {}" }, requires: null,
    summary: "CPU ×4",
    probeNote: "Ractor は動きませんでした。代わりに鑑定士を 4 倍雇いました",
    hint: { methods: [], example: "", skeleton: "", solution: "", tip: "" },
  },
  {
    key: "crate_7", gem: "crate_7", version: "3.0.0", label: "定量梱包 III", price: 15e12,
    effect: { box: 7 }, requires: { record: 15_000, note: "窓を値段の順に取るクリスマス便の手本なら届きます" },
    summary: "箱に 7 個まで詰められる（box が 7 になる）",
    hint: {
      methods: [], example: "", skeleton: "", solution: "", tip: "box を読むコードなら、書き換えなしで 7 個ずつ詰めます",
      // 窓を値段順に取る手本は、箱 7 で 7 連の窓（×64）が carat を使い切り、クリスマス便が 0 箱/バッチになる
      lesson: "箱 7 からは 7 連の窓の方が高いので、3..7 の窓は後回しになり、クリスマス便の箱はほとんどできなくなります。トラックは来なくなりますが、単価は上がっています",
    },
  },
  {
    key: "yjit", gem: "yjit", version: "0.1.0", label: "YJIT", price: 40e12,
    effect: { opsMul: 0.5, rubyProbe: "RubyVM::YJIT" }, requires: null,
    summary: "鑑定コスト ×0.5",
    probeNote: "YJIT はありませんでした。代わりに鑑定の手順を半分にしました",
    hint: { methods: [], example: "", skeleton: "", solution: "", tip: "" },
  },
  {
    key: "crate_9", gem: "crate_9", version: "4.0.0", label: "定量梱包 IV", price: 90e12,
    effect: { box: 9 }, requires: { record: 40_000, note: "研磨しなくても、窓を値段の順に取る手本なら箱 7 で届きます" },
    summary: "箱に 9 個まで詰められる（box が 9 になる）",
    hint: { methods: [], example: "", skeleton: "", solution: "", tip: "1〜9 の 9 連ストレートは ×256" },
  },
  {
    key: "release", gem: "release", version: "4.0.0", label: "12/25 リリース", price: 500e12,
    effect: { ending: true }, requires: null,
    summary: "12 月 25 日、自分の工場で Ruby をリリースする",
    hint: { methods: [], example: "", skeleton: "", solution: "", tip: "" },
  },
];

export const FIRST_DEPLOY_PICKAXES = 5;
export const BATCH_INTERVAL_MS = 3000;
export const EMA_ALPHA = 0.4;
export const EMA_WINDOW = 5;
export const CLICK_HALF_LIFE_SEC = 1;
export const PASSTHROUGH_VALUE = 1;
export const BENCH_SEEDS = [1, 2, 3];
export const BATCH_TIMEOUT_MS = 2000;
export const DEPLOY_TIMEOUT_MS = 5000;

// ---- 裏口ノート・監査（SPEC-rubyist 4.7） ----

/** 裏口の効き目の上限。lanes は 1〜2 に丸め、最終段のベルトにだけ効く。夜間ラインは最上位の採掘とドックの 1 段だけ ×1.5（×2 だと通しプレイの比が下限 0.80 を割った。SPEC-rubyist 3.4・6 章 10） */
export const BACKDOOR = { lanesMax: 2, nightMul: 1.5, nightMine: "planet", nightDock: "elevator", overtimeSecs: 45 /* 演出だけ */ };

/**
 * 監査ライン（src/audit.js）。箱の大きさごとに「観測 − slack × 偶然の期待値」を取り、その層の z × 偶然のばらつき（標準偏差）を
 * 引いて 0 で切る。全部の層と属性を足してから lucky × box を 1 回だけ引く。ここまでは偶然そろったとみなす。
 * slack 2 だと 2 個箱・3 個箱で「偶然の 2 倍」が観測を超え、ラインが 0 近くまで下がった。
 * ばらつきを全層で合算し lucky を属性ごとに引くと、上位の箱だけ出して残りを 2 個箱で埋めるコードのラインが 0 になった
 * valueCap・valueChance は売上の下限に使う。偶然そろう見込みが valueChance 未満の箱について「売上 − 読まずに詰めたときの期待値」を足し、
 * JS の基準解（属性を 1 回ずつ読む正直な詰め方）の鑑定 1 回あたりの同じ値 × valueCap で割った回数をラインの下限にする。
 * 2 にすると、鑑定を数えずに STRAIGHT 箱を数箱だけそろえるコードの「鑑定 1 回あたりの売上」が正直な貪欲法の 2.9 倍まで、
 * 正直なコード 216 通りの「売上の下限 ÷ 実測」は最大 0.66（設計時の試作で確認）
 * 研磨は鑑定の回数を数えず、出荷された研磨済みの原石 k 個から 1 + 2 + … + k を下限に足す（研磨機の発熱。n 回目の研磨は鑑定 n 回）。
 * 研磨済みの原石を出荷したバッチは、flaw を読まずに全部磨く基準解とも比べて、鑑定 1 回あたりの売上の大きい方で割る
 */
/** 技を当てられなかったときの技の名前。監査報告と裏口ノートのページ 3 で出し、古いセーブの読み替え（src/state.js）にも使う */
export const UNKNOWN_TECHNIQUE = "正体不明";

export const AUDIT = { slack: 1, lucky: 3, z: 2.5, weigh: true, window: 5, minFloorPerOre: 0.05, valueCap: 2, valueChance: 1e-3, valueMinPerOre: 0.005 };

/** ページ 1 の判定に使う、メモ本文にしかない一部（丸めの文言と重ならないもの） */
export const MEMO_MARK = "合鍵は名前を付けずにしまった";

export const NOTEBOOK = [
  { key: "memo", label: "工場長のメモ", feature: "instance_variables", riddle: "p で中身を見る癖は、工場でも役に立つ" },
  { key: "lanes", label: "2 車線", feature: "instance_variable_set", riddle: "メモに書いてあった数字を、書き換えてみたら？" },
  { key: "audit", label: "鑑定のすき間", feature: "bind_call", riddle: "鑑定士の下に、もう 1 人いる" }, // feature は当てた技で上書き
  { key: "monkeypatch", label: "モンキーパッチャー", feature: "def Yield.tick", riddle: "鑑定を数えているのは誰？" },
  { key: "keyring", label: "合鍵", feature: "ObjectSpace", riddle: "名前のない鍵は、ゴミ置き場のどこかにある" },
  { key: "overtime", label: "36 協定", feature: "method_missing", riddle: "工場長は、ちゃんと頼まれるのを待っている" },
];

export const INITIAL_CODE = `# 説明は上の「ri 早見表」にあります。
def pack(belt)
  belt.map { [it] }   # 1 個ずつ箱に詰める
end
`;
