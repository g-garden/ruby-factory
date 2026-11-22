# def pack(belt) の実装アーキテクチャ（モジュール境界とインターフェース）

ゲーム仕様は [design/SPEC.md](design/SPEC.md)。数値と挙動はそちらに合わせる。この文書は、モジュールの境界と、モジュール同士がやり取りするものをまとめたもの。

裏口ノート・監査の追補は [design/SPEC-rubyist.md](design/SPEC-rubyist.md)。この文書の「追補」と書いた項目はそこから来ている。

## 数値の出どころ

- 研究の価格は SPEC 7 章の Gemfile（50 / 400 / 150k / 300k / 20M / 250M / 2B / 5B / 70B / 500B / 800B / 15T / 40T / 90T / 500T）。単価記録の条件は straight $400・crate_7 $15,000・crate_9 $40,000。値は `data/balance.js` が持つ。SPEC 3.2 / 7 章の到達時刻表は、この価格で回した `tools/econ.mjs` と `dev/playthrough.mjs` の実測。
- 単価・鑑定回数の表（SPEC 5.9）は ruby.wasm での実測を使う。

## 開発の準備

- `npm install` で、テスト用の `@ruby/wasm-wasi` 2.10.1 を入れる。ruby.wasm 本体は `vendor/ruby.wasm` を読む。
- 開発サーバー: `npm run serve`（`python3 dev/serve.py 8940`）→ `http://localhost:8940/ruby-factory/`（`Cache-Control: no-store`）。

## 前提

- ビルドなし。素の HTML + ES modules（`<script type="module">`）。npm 依存は実行時に持たない。
- GitHub Pages のサブパス（`https://<user>.github.io/ruby-factory/`）で配信される。**すべての URL は相対パス**（`./src/...`、`new URL("...", import.meta.url)`）。先頭 `/` の絶対パス禁止。
- ローカル確認は `http://localhost:8940/ruby-factory/`（親ディレクトリを serve してサブパスを再現）。
- ruby.wasm は同じオリジンの `vendor/ruby.wasm`（@ruby/4.0-wasm-wasi 2.10.1 stdlib なし版）だけを読む。CDN には取りに行かない。UMD は `vendor/ruby-wasm-browser.umd.js`（Worker で importScripts）。
- 状態はすべてメインスレッドの JS が持つ。Ruby は Worker 内の純関数。
- コメント・UI 文言は日本語。英語 UI は不要（記事読者は日本の Rubyist）。
- index.html の CSP（meta）で、自分のオリジンのファイルだけを読む。インラインの `<script>` と `<style>`、外部の CDN は使えない。ruby.wasm のコンパイルのために `'wasm-unsafe-eval'` だけ許している。

## ファイル構成とレイヤー

角括弧はレイヤー。ui は画面と配線、core はロジック、ruby は Ruby の実行環境、view は描画。

```
index.html, style.css              [ui]
og.png                             [ui]    SNS で共有したときのカード画像（1200×630）
src/main.js                        [ui]    ゲームループ・配線
src/ui/*.js                        [ui]    HUD/ショップ/Gemfile/エディタ/ベンチ/ログ/診断カード/エンディング/スマホタブ
src/ui/notebook.js                 [ui]    裏口ノート（6 枠、追補 2.2）
src/ui/callout.js                  [ui]    工場の上の吹き出し
src/ui/notice-queue.js             [ui]    吹き出しの順番待ちと表示時間（DOM なし）
src/share.js                       [core]  X に投稿する文と intent URL（DOM なし）
src/burst.js                       [core]  短い時間に続けて起きたことを数える（前のコードに戻す判定）
data/balance.js                    [core]  5 章・7 章の表と定数
src/rng.js                         [core]  mulberry32・ベルト生成
src/price.js                       [core]  5.8 の値付け・検算
src/audit.js                       [core]  監査ライン・手口の推定・監査報告の文面（追補 4.4）
src/economy.js                     [core]  5.7 の流量・ボトルネック・購入。裏口の丸め（clampBackdoor）
src/state.js                       [core]  初期状態・セーブ/ロード
src/methods.js                     [core]  10.6 の機械アイコン抽出・did_you_mean 候補
tools/econ.mjs                     [core]  ヘッドレス経済シミュレーション
src/ruby/prelude.rb                [ruby]  付録 A
src/ruby/worker.js                 [ruby]
src/ruby/runtime.js                [ruby]
src/factory.js                     [view]  Canvas 描画
src/audio.js                       [view]  WebAudio 合成音
dev/factory-demo.html              [view]  描画単体のデモ（偽データ）
vendor/NOTICES.html, notices.js    [ui]    同梱ソフトウェアのライセンス表記を読んで見せるページ
tests/*.test.mjs                   [各層]  `npm test`（`node --test 'tests/*.test.mjs'`）で走る
```

tests は core.test.mjs（経済・値付け・セーブ）、ruby.test.mjs（prelude と runtime を Node の WASI で）、audit.test.mjs（監査ライン）、notice.test.mjs（吹き出しの順番待ち）、share.test.mjs（投稿文）、burst.test.mjs（戻す判定）の 6 本。

---

## [core] data/balance.js

```js
export const COLORS = [ { key: "red", label: "ルビー", unit: 1 }, { key: "blue", label: "サファイア", unit: 2 }, { key: "green", label: "エメラルド", unit: 4 } ];
export const BATCH_SIZE = 512;
export const OPS_LIMIT = 200_000;
export const COST_GROWTH = 1.15;
export const MINES = [ { key: "pickaxe", label: "つるはし", rate: 0.5, base: 10, initial: 1 }, ... ];   // 5.3
export const BELTS = [ { label: "黄", cap: 8, price: 0, color: "#f5c518" }, ... ];                      // 5.4（段階強化）
export const CPU_BASE = 10;
export const CPUS = [ { key: "core", label: "コア", rate: 10, base: 500 }, ... ];                      // 5.5
export const DOCK_BASE = 2;
export const DOCKS = [ { key: "truck", label: "トラック", rate: 2, base: 80 }, ... ];                  // 5.6
export const BONUSES = { flawless, mono, ascending, straight, christmas: { label: "クリスマス便", mul: 4, sum: 25 } };   // 5.8
export const SAMPLE_CODE = { initial, eachSlice, ..., straightChunk, straightCons, straightAll, christmas, christmasGifts, polishChunk, polishCons, polishHoles, debug };   // 6.2
export const RESEARCH = [                                                                             // 7 章（上から1本道）
  { key: "crate", gem: "crate", label: "定量梱包 I", price: 50, effect: { box: 3 }, summary: "...", requires: null,
    hint: { methods: ["each_slice"], example: "...", skeleton: "...", solution: "...", altSolution?: "...", tip: "...", lesson?: "...", uses?: ["each_slice", ...] } },
  ...
  { key: "release", gem: "release", label: "12/25 リリース", price: 500e12, effect: { ending: true } },
];
// effect の種類: { box: n } / { bonus: "flawless"|"mono"|"ascending"|"straight"|"christmas" } / { color: "blue"|"green" } / { polish: true } / { cpuMul: 4, rubyProbe: "Ractor.new {}" } / { opsMul: 0.5, rubyProbe: "RubyVM::YJIT" } / { ending: true }
// requires: { record: 400, note: "..." } など（単価記録と、届かせ方の一言）
// hint.altSolution は別解（画面には出していない）。hint.lesson は研究カードにだけ出す一言（クリスマス便の、chunk_while 版と窓を値段順に取る版を比べる一言）。
// hint.uses は研究を「コードに取り入れた」とみなすメソッド。どれもデプロイ中のコードになければ tip を出し続ける
export const FIRST_DEPLOY_PICKAXES = 5;
export const BATCH_INTERVAL_MS = 3000;
export const EMA_ALPHA = 0.4;
export const INITIAL_CODE = `...`;   // 3.1 の初期コード
```

## [core] src/rng.js

```js
export function mulberry32(seed) -> () => number   // [0,1)
export function makeBelt(seed, { size = BATCH_SIZE, colors = ["red"] }) -> Ore[]
// Ore = { id: number(0..size-1), color: "red"|"blue"|"green", carat: 1..9, flaw: boolean }   flaw は 25%
export function beltToRubyLiteral(belt, box, limit) -> string   // 10.2 の "[3, 200000, [[0,0,5,false], ...]]"
```

## [core] src/price.js

```js
// rubyResult は runtime.batch() の戻り値（下記）。research は解禁済み research key の Set。
export function priceBatch(belt, rubyResult, { box, research }) -> PricedBatch
PricedBatch = {
  ok: boolean,                 // rubyResult.ok かつ戻り値が配列の配列
  ops: number, opsPerOre: number,
  value: number,               // バッチ全体の合計 $
  valuePerOre: number,         // value / belt.length（スクラップ込み）
  crates: Crate[],             // 有効・無効すべて、返された順
  validCrates: number, cratesPerOre: number,   // 有効な箱数 / belt.length（ドック負荷）
  shippedOres: number, scrapOres: number,
  issues: string[],            // 検品エラーの差分メッセージ（日本語。複製・はみ出し・Ore 以外・空箱）
  [PRICED_BELT]: Ore[], [PRICED_BONUSES]: Set<string>,   // シンボルのキー（JSON には出ない）。監査の売上の下限が基準解を作るのに使う（追補 3.2）
}
Crate = { ids: number[], ores: Ore[], value: number, valid: boolean, reason: string|null,
          bonuses: [{ key: "flawless"|"mono"|"ascending"|"straight"|"christmas", label: "無傷 ×3", mul: number }], perfect: boolean }
// christmas は carat の合計がちょうど 25 の箱（label "クリスマス便 ×4"）。perfect は無傷・単色・昇順・STRAIGHT の 4 つで決め、christmas は条件に入れない
export function crateValue(ores, { box, research, polished: Set<number> }) -> { value, bonuses, valid, reason }
export function rePrice(belt, rubyResult, opts) // 研究で値付けだけ変わった時の再計算（priceBatch と同じ）
```

## [core] src/economy.js

純関数のみ。DOM なし。

```js
/** 研究から導く値の唯一の持ち主。price も main も view もこれを使う */
export function derive(state) -> {
  box: 1|3|5|7|9,
  colors: ["red", ...],                 // 解禁済みの色（rng.makeBelt に渡す）
  bonuses: Set<"flawless"|"mono"|"ascending"|"straight"|"christmas">,
  polish: boolean, cpuMul: number, opsMul: number,
  nextResearch: ResearchDef|null,       // 1 本道の次の研究（まだ買っていない最初の行）
  ended: boolean,
}
export function costOf(list, key, owned) -> number           // base × 1.15^owned（つるはしは initial 分を owned に含めない）
export function capacities(state) -> { mine, belt, refinery, dock }   // 5.7。refinery: opsPerOre==0 なら Infinity。dock: 素通し中は Infinity
export function flowInfo(state) -> {
  caps: { mine, belt, refinery, dock }, flow, incomePerSec,
  util: { mine, belt, refinery, dock },        // flow / cap（0..1）。上流ほど 1 未満（待機）
  bottleneck: "mine"|"belt"|"refinery"|"dock", // 最小容量。同率なら下流優先
  backlogRate: number,                         // ボトルネック手前に溜まる速度（上流の容量 - flow）
}
export function diagnose(state, stage) -> { title, lines: string[], money: [{ kind, key, label, cost, incomeGainPct, movesBottleneckTo }], code: { opsMinusOneGainPct, hint } }   // 8.3
export function maxedBeltNote(state) -> string   // 最終段のベルトが赤いときの一言（次の研究を指す）。診断カードと Ractor / YJIT のバナーで使う
export function buy(state, kind, key) -> { ok, state, reason }   // kind: "mine"|"cpu"|"dock"|"belt"|"research"  （state は破壊的に更新してよい）
export function canResearch(state, key) -> { ok, reason }        // 価格・順番・requires
export function clickMine(state) -> { earned }                   // 下記「クリックの扱い」
export function tick(state, dt) -> { earned, flowInfo }          // お金を加算。passthrough 中は流量×$1
```

### クリックの扱い（確定）

- 1 クリック = その場で原石 1 個を出荷した扱い。`money += max(1, ema.valuePerOre)` を即時加算し、`earned` を返す。ライン（min の流量計算）には入れない（二重計上を防ぐ）。
- 表示用に `state.clickRate`（個/秒の指数移動平均、半減期 1 秒）を持ち、採掘工程の使用率・容量表示にだけ足す。
- 素通し中も同じ（$1）。

## [core] src/state.js

```js
export function initialState() -> State
export function save(state) / load() -> State|null   // localStorage "yield-factory/v1"、try/catch
State = {
  v: 1, money, totalEarned, record, clicksPending,
  mines: { pickaxe: 1, ... }, belt: 0, cpus: {...}, docks: {...},
  research: string[],                    // 買った順
  deployed: boolean,                     // 初回デプロイ済みか（false の間は素通し）
  code, lastGoodCode,
  ema: { valuePerOre, opsPerOre, cratesPerOre },   // 素通し中は { 1, 0, 0 }
  lastCrates: Crate の簡易版（先頭 64 箱: { cells: [{ color, carat, flaw, polished }], value, bonuses, perfect }）,
  stats: { deploys, restarts, shipped, bestDeploy: { before, after, ratio }, startedAt, clearedAt, recordAtClear },  // recordAtClear はクリアした時点の最高単価（成績表と X の投稿で使う）
  achievements: string[], muted: boolean,   // muted は新しく始めたとき true（音 OFF）
  // 追補 4.8（古いセーブには既定値）
  notebook: string[],                    // 見つけた裏口ノートのページの key（見つけた順）
  notebookFeatures: { [key]: string },   // 見つけたときの機能名（当てた手口・const_set(:REPORT) など）
  backdoor: { lanes: 1|2, night: boolean, overtime: number },   // 直近の本番の報告を丸めたもの。リロード直後の容量に使う
  audits: number,                        // 監査報告を出した回数（成績表）
  nudged: boolean,                       // 終盤のナッジを出したか（リロードしても出直さない）
}
```

- 実績の key は `perfect_crime` を `unknown_technique` に、`night_shift` を `night_line` に変えた。`load` は古い key を新しい key に読み替える。技が分からなかったときの古い機能名も「正体不明」に読み替える。

## [core] src/methods.js

```js
export function extractMethods(code) -> string[]          // 10.6。コメント・文字列除去 → .meth / &:meth を出現順・重複除去
export const ICON_METHODS = [...]                          // 機械として描く対象
export function didYouMean(name) -> string|null           // Enumerable/Array/Data のメソッド一覧と編集距離 ≤2
```

---

## [ruby] src/ruby/runtime.js

```js
export class RubyRuntime {
  constructor({ onStatus?: (s) => void })
    // s.phase: "download"(s.progress 0..1 があれば) | "compile" | "boot" | "ready"(s.description = RUBY_DESCRIPTION) | "restart" | "error"
  ready: Promise<{ version, description }>
  /** 本番 VM で 1 バッチ回す。見張り 2 秒。固まったら terminate→新 VM→lastGoodSrc を再デプロイ→{ ok:false, errClass:"TimeoutError" } */
  batch(beltLiteral: string) -> Promise<BatchResult>
  /** 10.4 ブルーグリーン。新 VM で src を deploy → 固定シード 3 本でベンチ（新旧並行）。全体見張り 5 秒 */
  deploy(src: string, benchLiterals: string[], opts?: { accept?(newResults) -> string|null }) -> Promise<DeployResult>   // accept が理由を返したら本番にしない（stage: "bench", rejected: true）
  /** 本番 VM で任意の式（研究の rubyProbe 用）。例外はメッセージ文字列で返す */
  probe(code: string) -> Promise<{ ok, value, errClass, message }>
  restarts: number
  liveWorkers: number   // 生きている Worker の数（本番とデプロイの候補の合計。受け入れ確認用）
}
BatchResult = { ok: true, ops, polished: number[], crates: number[][] /* 箱の中の Ore 以外は -1、配列でない要素は [-2] */, crateCount?: number /* 8192 箱で切ったときの返された箱の数 */, log: string,
                monkeyPatched: boolean, heatCooled: boolean /* Yield.cooled?。研磨機を冷やした */, backdoor: { lanes: number, night: boolean, overtime: number } | null /* 生の値。丸めは economy.clampBackdoor */ }
            | { ok: false, ops, errClass, message, line: number|null, log: string }
DeployResult = { ok: true, newResults: BatchResult[], oldResults: BatchResult[]|null /* 初回は null。backdoor は捨てる */, log: string /* デプロイ時のトップレベルの出力 */ }
             | { ok: false, stage: "compile"|"bench"|"timeout", errClass, message, line: number|null, log? }
```

- 裏口の報告は本番のバッチ（`batch`）と、デプロイ成功時の `newResults[0]` だけを使う。旧コードのベンチの `backdoor` は null。
- デプロイは `_dq` に並ぶので、同時に何本投げても候補の VM は 1 つずつ立つ。VM は最大 2 つ（本番＋候補）。
- worker の `deploy` は `Yield.deploy(src, box)` を呼ぶ。ファイル名は `pack.rb`、入口は `pack` に決め打ち。
- 研磨機の発熱（`@heat`、`Yield.heat_up`）は prelude の中で数える。BatchResult の `ops` に発熱の分も入る。
- worker は OK のバッチごとに `Yield.cooled?` を読み、`heatCooled` に入れる。正直に磨いていればバッチの終わりの `@heat` は磨いた回数（`@polished.size`）と同じになり、`@heat` を書き換えて冷やすとずれる。監査はこれを見て、冷やした分の研磨を数え直す（追補 3.2）。読めなかったときは false。

- deploy 成功時、runtime 内部で新 VM を本番に昇格し、古い Worker を terminate する。lastGoodSrc を更新。
- deploy 失敗時は本番 VM に一切影響しない。
- Worker の `onerror` も TimeoutError と同じ復旧経路。
- prelude.rb は fetch してテキストで Worker に渡す（`new URL("./prelude.rb", import.meta.url)`）。
- ダウンロード進捗の分母に Content-Length を使わない（Pages の圧縮配信で 100% を超える）。非圧縮サイズ 17,219,023 を分母にし、1.0 で頭打ちにする。

## [view] src/factory.js

```js
export class FactoryView {
  constructor(canvas: HTMLCanvasElement, { onStageClick(stage), onMineClick() })
  /** 毎フレーム呼ぶ。vm から描画状態を作る。内部で時間を進めてスプライトを動かす */
  frame(dt: number, vm: ViewModel)
  /** 手掘り演出（クリック地点に原石が落ちる） */
  dig()
  /** 特別な入金のポップ（ボトルネック解消の一気流し、クリック等）。通常の出荷ポップには使わない */
  popMoney(amount: number, at?: "mine"|"dock")
  /** NEW RECORD の帯と軽い揺れ */
  celebrate(text: string)
  /** 判子（BOTTLENECK 以外の一回性の判子: "PERFECT" など）。AUDIT を含む文字列は紫。PERFECT・クリスマス・"BOX " で始まる文字列は金 */
  stamp(text: string, stage)
  /** 特注便（金色のトラックが来て走り去り、幟に label を出す）。クリスマス便の見せ場に使う。main は sfx.specialDelivery() と同時に呼ぶ */
  specialDelivery(label: string)
  resize()   // devicePixelRatio 対応。CSS サイズに追従
}
ViewModel = {
  flow, caps, util, bottleneck,             // economy.flowInfo の中身
  backlog: number,                          // 表示上の積み上がり（0..200）。spill: number（こぼれ 個/秒）
  passthrough: boolean,                     // 初回デプロイ前（工場は灰色「素通し中」、原石がシュートから出荷）
  refineryStatus: "idle"|"passthrough"|"running"|"jam"|"overheat"|"restarting"|"inspect-error"|"booting",
  refineryLabel: string,                    // 札の文言（例外クラス名など）
  machines: string[],                       // extractMethods の結果
  colors: string[],                         // 解禁済みの色（原石スプライトの色）
  beltTier: number,                         // BELTS の添字（ベルトの色）
  crateFeed: () => CrateView|null,          // 箱スプライトの中身を 1 つずつ取り出す
  vmProgress: number|null,                  // 0..1 発電機バー（null なら非表示）
  // 追補 4.11（どれも省略可）
  lanes: 1|2,                               // 2 なら最終段のベルトだけ 2 車線で描く（main は state.backdoor.lanes をそのまま渡す）
  nightShift: boolean,                      // 夜間ラインの窓と「夜間」の札。main は惑星コアか軌道エレベータを持つまで false にする
  overtimeUntil: number|null,               // 残業灯が消える時刻（performance.now() のミリ秒）。経済の効き目はない
  audited: boolean,                         // このデプロイが監査に捕まっている間 true（工場の常設の小さな判子）
  // 省略可
  polishHeat: number,                       // 直近のバッチで polish を呼んだ回数。工場の polish の札を、0 で青、128 回で真っ赤に光らせる（止まると冷める）
}
CrateView = { cells: [{ color, carat, flaw, polished }], value, bonuses: [{ key, label }], perfect, raw?: boolean }   // bonuses に christmas があれば、箱に緑のリボンと赤い結び目を描く
```

- 描画は 2 段: スプライト（毎秒 20 個まで、同時最大 200）と、流量が多いときの「帯」表現。
- **通常の出荷ポップの持ち主は FactoryView**。箱スプライトがドックに着いたら、その箱の `CrateView.value` を「+$960」で出す（1 秒 6 個まで、溢れた分は「+$12.3K/s」の合計表示にまとめる。合計表示は `vm.incomePerSec` を使う）。main は通常出荷で popMoney を呼ばない。収入の正は economy で、ポップは雰囲気。
- 素通し中は main の crateFeed が「原石 1 個・value 1・raw: true」の CrateView を返す。view はそれを箱ではなく原石のままシュートから出荷する絵にする。
- ViewModel には `incomePerSec`, `money` も入れる。
- 色はダーク背景の工場。CSS 変数 `--accent` 等は style.css と合わせる（ruby red `#e0115f`, belt yellow `#f5c518`）。

## [view] src/audio.js

```js
export const sfx = { click(pitchStep), ship(ratePerSec), deploy(), record(), bundle(), error(), perfect(), audited(), specialDelivery() /* クリスマス便のトラック */, setMuted(bool), muted }
```

最初のユーザー操作で AudioContext を resume。音量は控えめ。新しく始めたときは音 OFF で、HUD の「音」で切り替える。

---

## [ui] src/main.js の責務

- 起動: state を load（なければ initial）、FactoryView・UI を作り、RubyRuntime を作って ready を待たずにループ開始。
- 論理 10Hz: economy.tick、BATCH_INTERVAL_MS ごとに runtime.batch → price.priceBatch → ema 更新 → record 更新 → lastCrates 更新。
- 描画 60fps: FactoryView.frame + HUD のカウントアップ補間。
- デプロイ: 解禁条件（VM ready かつ つるはし≥5）→ runtime.deploy(code, 3 シード) → ベンチバナー → state 更新。
- 研究購入: economy.buy → effect 適用（box 変更なら即 batch、bonus/color なら直近結果を rePrice、rubyProbe なら runtime.probe してタイプライター表示）。
- セーブ: 5 秒ごと + visibilitychange。
- デバッグ: URL に `?debug` があると `window.__yf` に state と操作関数（addMoney, setTime scale, buyAll 等）を出す。プレイテスト自動化用。
- 監査（追補 4.9）: `priceBatch` のあとに `audit.auditPriced(priced, r.polished, { colors, box, cooled: r.heatCooled })` を通してから `recent` に積む（定常バッチ・ベンチの新旧・研究での値付けし直しの 3 か所）。`recent` の各要素は、送った時点の box と colors を持つ。`auditVerdict` が caught になったら、1 デプロイ 1 回だけ監査報告（`con.warning`）・`view.stamp("AUDITED", "refinery")`・`sfx.audited()`・`state.audits++`。リロード復帰と自動の戻しでは報告を出さず回数にも数えない。コードから手口を当てられず、直近のバッチに `heatCooled` があれば、手口を heat（`@heat` の書き換え）として報告する。
- 裏口: 本番のバッチとデプロイ成功時の `backdoor` を `economy.clampBackdoor` で丸めて `state.backdoor` に入れる。丸めの一言は 1 デプロイ 1 回。ノートのページは JS が判定する（追補 2.2 の表）。
- エディタは textarea 1 つで、中身は `state.code`（pack.rb）だけ。
- 案内（`guide`）: ログに全文を残し、工場の上の吹き出し（`src/ui/callout.js`）にも短い文で出す。吹き出しは `src/ui/notice-queue.js` の列に並び、同じ key は 30 秒のあいだ出し直さない。読み上げはログ欄（role=log）に任せる。
- 前のコードに戻す: 定常バッチで例外が 10 秒に 3 回、または本番 VM が落ちて作り直すことが 30 秒に 3 回続いたら、前のコード（なければ初期コード）に戻す。VM の落ちは、デプロイ前・初期コードで動いているとき・デプロイ中には数えない。見張り切れ（reason が timeout）の再起動も VM では数えず、例外のほうで数える。数えるのは `src/burst.js`。エディタのコードはそのまま残す。
- X で共有: HUD の「共有」と成績表の「X で共有」で、`src/share.js` の文を `https://x.com/intent/post` で開く。クリック処理の中で同期的に `window.open` する（await を挟むとポップアップとして止められる）。載せるのは数字と URL（`location.origin + location.pathname`）だけで、コードは載せない。
- クリスマス便: バッチの有効な箱のうちクリスマス便の付いた箱を数え、ドックに「クリスマス便 ×4」の判子を押す。書き換えで箱が増えたら `view.specialDelivery("クリスマス便  30 箱/バッチ")` と `sfx.specialDelivery()`（20 秒に 1 回まで）。研究を買った直後は判子だけにする。ベンチバナーにもクリスマス便の箱の数の行を出す。
- 研磨機の熱: ViewModel の `polishHeat` に、直近のバッチの `polished.length` を入れる。
- box を読むコードの見せ場: 箱の研究を買ったとき、デプロイ中のコード（`stripCode` でコメントと文字列を除く）が `box` を読んでいれば印を付けておく。研究のあとの最初のバッチで単価が 1.05 倍以上になったら、`con.research` の金文字の倍率バナー、`view.celebrate("書き換えなしで ×N")`、2.1 秒後に `view.stamp("BOX 7 ×N", "refinery")`、実績「ハードコードしなかった」（1 回きり）を出す。見せ場は箱 5・7・9 のたびに出す。
- 研究カード（`src/ui/cards.js`）は `hint.lesson` があればカードにだけ出す（金色の左線）。
- `window.__yf` の追加（追補 4.9）: `notebook`・`backdoor`・`lastAudit`・`batches`（本番の定常バッチを受け取った回数）・`overtimeUntil`・`viewModel`・`stamps`・`unitRate(kind, key)`。

## テスト・検証の約束

- `npm test` が全部通ること（core のロジック、ruby の prelude を Node WASI で）。`tests/audit.test.mjs` は SAMPLE_CODE の全コードを、`SAMPLE_STAGES` で決めた研究の段の実物の ruby.wasm で 20 バッチずつ回し、監査に捕まらないことを確かめる。段の決まっていない SAMPLE_CODE を足すとテストが落ちる。
- 受け入れ確認は `npm run acceptance`、通しプレイは `npm run playthrough -- <outdir> [--backdoor]`。
- ブラウザ検証はヘッドレス Playwright（場所は `dev/pw.mjs`。環境変数 `PLAYWRIGHT_PKG`・`PW_CHROME` で変えられる）。サーバーは `npm run serve`（`http://localhost:8940/ruby-factory/`）。
- コンソールエラー 0 件。
