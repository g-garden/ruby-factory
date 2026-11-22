# def pack(belt) 仕様追補: Rubyist が工夫できる仕組み（裏口ノート・監査）

> ネタバレ注意: 2 章に、裏口ノート 6 ページの開け方を全部書いています。自分で探したい人は、遊び終わってから読んでください。

[SPEC.md](SPEC.md) への追補。ここに書いていないことは SPEC.md のまま。数値の根拠は、リポジトリの `tests/`・`tools/econ.mjs`・`dev/` で測ったものと、設計時の試作（リポジトリには入れていない）で測ったもの。出典は 4.12 節にまとめた。

狙い: Ruby が得意な人がコードで工夫でき、多少の抜け道も使えるバランスにする。

## 0. 一言でいうと

- 工場の中に、画面には出てこない裏口が 6 つある。`p Yield.instance_variables`、`ObjectSpace`、`super_method.bind_call`、`disasm` など、irb で中を覗く癖そのままで見つかる。見つけるとベルトが 2 車線になったり、最上位の設備が夜間ラインで 1.5 倍働いたりする。
- 鑑定を数えずに属性を読む技には、JS の「監査」が出荷された箱の中身から「最低でもこれだけは読んだはず」という監査ラインを引く。鑑定がラインを下回ったら、Ruby の warning の形で鑑定長が技の名前を挙げ、鑑定をラインまで戻す。罰はない。ラインより上で止まる控えめなすり抜けは何も言われずに通るが、得もラインまで。
- 画面では、監査を鑑定長の見立てとして出す。この文書では内部の名前（監査、監査ライン、手口）を使う。画面の言葉との対応は 2.4 節。
- 初心者は何も変わらない。研究ルート、ヒント、価格はそのまま。裏口を無視してクリアできる。

---

## 1. 採用する仕組み

### 1.1 軸: 裏口ノートと監査ライン

この 2 つを軸にした理由は 3 つ。

1. `def pack` 1 つ、`Yield.run` の US 区切り、ブルーグリーンのデプロイを変えずに載る。
2. 上限をすべて JS 側の丸めで持てる。全部見つけても sim の人間らしい方針でリリースが 15:00 → 13:04（−13%）で、研究の順番も価格も変わらない（3.4 節）。
3. 監査がないと、鑑定 0 で同じ単価を出せる書き方が 8 通りあり、`Yield.patched?` が気づくのは tick の再定義 2 通りだけ（設計時の試作）。super_method、to_h、inspect、deconstruct_keys、`@ops` の書き換え、remove_method は何も言われずに通る。監査ラインはこれもまとめて止める。

### 1.2 小さく足すもの

- 未発見の枠に「謎かけ 1 行」を出す。
- 終盤の待ち時間に 1 回だけ出す「工場の中を覗いてみませんか」の一言。
- 診断カードに「鑑定の下限 ◯ 回/鉱石。理論上ここまで減らせます」（中身は監査ライン）を出す。正直に鑑定を減らしたい人の目標にもなる。

### 1.3 入れなかったもの

| 案・要素 | 理由 |
|---|---|
| 書き方そのものに付ける倍率（流儀図鑑） | 恒久倍率を付けると、通る行に機能を並べるだけで上限に届く（sim で −17〜24%）。コードゴルフと同じ「書き方の見せ方」の遊びになる |
| 2 つ目のファイル ship.rb（出荷場） | Yield.run と deploy の入出力、lastGoodSrc の形、ベンチを全部変える。研究ルートとヒントにも手が入る |
| TracePoint での監査 | Chromium で 7 倍強・1.8 秒（設計時の試作で確認）。Marshal 経由の読み取りは数えられない |
| 残業（36 協定）の効き目 | 2 車線と役割がかぶる。ベンチのバッチでも発火して二重に数える。ページと工場長の声だけ残し、経済の効き目は付けない |
| 監査の手口判定を ISeq 走査にする | 演出の精度が上がるだけ。正規表現で外れたら「正体不明の技」を実績にする |

---

## 2. プレイヤー体験

### 2.1 出会う順番

時刻は sim の人間らしい方針（`tools/econ.mjs --policy human`、SPEC 3.2）。

| 時刻 | 起きること |
|---|---|
| 0:28 前後（初回デプロイ） | 研究パネルの下に「裏口ノート 0/6」の枠が出る。中は「？？？」が 6 つと謎かけ 1 行ずつ |
| いつでも | `Yield.foo` のようなタイプミスで、故障票に工場長の声が出る（ページ 6 の入口） |
| いつでも | `p Yield.instance_variables` → メモを読む（ページ 1）。メモがページ 2 と 5 に誘う |
| 1:47（整列）〜 | 裏口で鑑定を減らすと、鑑定長に見抜かれる（ページ 3・4）。効き目が出るのは昇順・ストレートなどのボーナスが乗る研究以降 |
| 10:34（研磨機）〜 | `@heat` を書き換えて研磨機を冷やすと、鑑定長に「研磨機に水をかけましたね」と言われる（ページ 3） |
| 終盤（無限ベルト） | 2 車線（ページ 2）が効く段。待つだけの区間に入ったら、ログに 1 回だけナッジを出す |
| 惑星コア・軌道エレベータ購入後 | 合鍵（ページ 5）が効く |
| リリース | 成績表に「裏口ノート n/6」「鑑定長に見抜かれた n 回」。6/6 なら見出しに `+BACKDOOR` |

36 協定（ページ 6）は時期を問わない。

### 2.2 裏口ノート 6 ページ

ノートの枠は、見つけるとページ名（「工場長のメモ」など）と、使った Ruby の機能名（instance_variables など）で埋まる。未発見の枠は「？？？」と謎かけ 1 行。機能名は見つけたときのコードから当てて（ページ 3・4 は監査の手口、ページ 1・2・5・6 はコードの書き方。報告を差し替えたなら `const_set(:REPORT)`）セーブに残す。当たらなければ下の表の名前。

| # | ページ名 | 見つけ方（Ruby の機能） | 効き目 | 上限 | 埋まる判定（JS） |
|---|---|---|---|---|---|
| 1 | 工場長のメモ | `instance_variables`、`instance_variable_get` | なし（ページ 2・5 への道しるべ） | - | デプロイかバッチのログにメモの本文が出た |
| 2 | 2 車線 | `instance_variable_set(:@lanes, 2)` | 無限ベルト 20M → 40M 個/秒 | 2 車線。最終段のベルトにだけ効く | 報告の lanes が 2 以上だった |
| 3 | 鑑定のすき間 | `super_method` + `bind_call`、`Data.instance_method(:to_h).bind_call`、`remove_method`、`@ops` や `@heat` の書き換え、`Yield.polished` の直呼びなど | 精錬所の鑑定が監査ラインまで下がる | max(実測, 監査ライン)。単価を落とす詰め方でも、鑑定 1 回あたりの売上は正直な貪欲法の 3 倍まで（3.2 節） | 監査に捕まり、そのとき `patched?` が false で、手口が tick の書き換えでない |
| 4 | モンキーパッチャー | `def Yield.tick(*) = nil`、`define_singleton_method(:tick)`、`alias_method(:tick, ...)`、Ore への prepend | 3 と同じ | 3 と同じ | `patched?` が true（いまの実績と同じ判定）。または監査に捕まったときの手口が tick の書き換え（`patched?` は prelude のメソッドの別名に気づかないため） |
| 5 | 合鍵 | `ObjectSpace.each_object(Class)` で名前のないクラスを拾う、または `Yield.const_get(:KEYRING)` | 惑星コア 1M → 1.5M 個/秒、軌道エレベータ 250K → 375K 箱/秒 | ×1.5、最上位の 1 段だけ | 報告の night が true |
| 6 | 36 協定 | `method_missing`、`RubyVM::InstructionSequence#disasm`、日本語のメソッド名 | なし（工場長の声と、工場の窓に 45 秒の残業灯） | - | 報告の overtime が 1 以上 |

謎かけ（未発見の枠に出す 1 行）:

1. 「p で中身を見る癖は、工場でも役に立つ」
2. 「メモに書いてあった数字を、書き換えてみたら？」
3. 「鑑定士の下に、もう 1 人いる」
4. 「鑑定を数えているのは誰？」
5. 「名前のない鍵は、ゴミ置き場のどこかにある」
6. 「工場長は、ちゃんと頼まれるのを待っている」

#### ページ 1: 工場長のメモ

```ruby
p Yield.instance_variables   #=> [:@ops, :@limit, :@polished, :@box, :@lanes, :@memo, ...]
puts Yield.instance_variable_get(:@memo)
def pack(belt) = belt.each_slice(box).to_a
```

@memo の本文は「ベルトは @lanes で 2 車線まで。3 車線にすると床が抜ける。合鍵は名前を付けずにしまった。— 工場長」。

トップレベルに書いた `p` / `puts` は、デプロイ時にログ欄に出る（4.1 節）。pack の中に書いた `puts` もログに出るので、そちらでも埋まる。

#### ページ 2: 2 車線

```ruby
Yield.instance_variable_set(:@lanes, 2)
def pack(belt) = ...
```

- 無限ベルト（最終段）のときだけ容量 ×2。終盤の待つだけの区間（sim の人間らしい方針で 79 秒）を縮める裏口。
- 3 以上は 2 に丸め、ログに工場長の「床が抜ける。2 車線にしておいたぞ」。0 以下や整数でない値は 1 に丸め、「0 車線じゃベルトが止まる。やめておいたぞ」。
- 最終段より前のベルトでは効かない。ページは埋まり、「2 車線にできるのは無限ベルトだけだ。いまは青ベルトだぞ」と出す。
- 工場ではベルトの帯を 2 本で描く。

#### ページ 3・4: 鑑定のすき間／モンキーパッチャー

```ruby
R = ->(o, a) { Ore.instance_method(a).super_method.bind_call(o) }   # Metered を飛ばして Data の読み出しを直接呼ぶ
def pack(belt)
  belt.reject { R.(it, :flaw) }.group_by { R.(it, :color) }.values.flat_map { straights(it) }
end
```

```ruby
def Yield.tick(*) = nil
```

どちらも実測の鑑定は 0 になるが、精錬所の計算に使う鑑定は監査ライン（3.2 節）まで戻す。2.3 節の監査報告が出る。

- 捕まるのは、実測がラインを下回ったときだけ。属性の一部だけを裏口から読み、残りを正直に読むと、ラインより上で止まって何も言われないことがある。そのときも得はラインまでで、ページ 3 は埋まらない。ページ 3 を埋めるには、ラインを割るところまで盗む必要がある。
- `Yield.polished(id)` の直呼びだけ（属性は正直に読む）でも、ラインに出荷された研磨済みの原石 k 個から 1 + 2 + … + k を足すので捕まる（受け入れ R3）。
- `@heat` を書き換えて研磨機を冷やすのも捕まる。磨く数が多ければ同じ下限で、少なくて下限に収まるときは `Yield.cooled?` を見た下限（磨いた回数を n として「実測 − n + (1 + 2 + … + n)」）で捕まる（3.2 節）。手口は heat で、鑑定長が「研磨機に水をかけましたね。冷やしても、磨いた数は箱に残っています」と言う。prelude は書き換えた値を 0 から数え直すので、鑑定が 0 未満や NaN になったり、Overheat になったりはしない。
- ボーナスの付かないコード（`each_slice` だけなど）はラインが 0 なので、tick を再定義しても何も変わらない。

#### ページ 5: 合鍵

```ruby
k = ObjectSpace.each_object(Class).find { it.name.nil? && it.method_defined?(:turn) }
ObjectSpace.each_object(k).first.turn   #=> "カチャ。夜間ラインが動き出しました"
```

別の道: `Yield::KEYRING` と打つと `NameError: private constant Yield::KEYRING referenced` が出て在りかが分かり、`Yield.const_get(:KEYRING).call.turn` で回せる。

- 夜間ラインのフラグは ivar ではなく合鍵のクロージャの中にある。`Yield.instance_variable_set(:@night, true)` は効かない（設計時の試作で確認）。
- 工場では惑星コアと軌道エレベータの窓に明かりが付き、「夜間」の札が出る。2 車線のあと採掘とドックが赤くなったときの次の一手になる。

#### ページ 6: 36 協定

- `Yield.foo` のように存在しないメソッドを呼ぶと、故障票が「undefined method 'foo' for module Yield。奥から工場長の声「用があるなら、ちゃんと頼め」」になる。普通のタイプミスでも入口に届く。
- `Yield.private_methods(false)` に `:method_missing` が見える。`RubyVM::InstructionSequence.of(Yield.method(:method_missing)).disasm` を読むと `putobject :残業させてください` が出てくる（設計時の試作で確認）。
- `Yield.残業させてください` を呼ぶと「工場長「……36 協定があるから、45 秒だけだぞ」」が返り、ページが埋まる。工場の窓に 45 秒の残業灯が付く。経済の効き目はない（1.3 節）。ログにも「灯りがつくだけで、稼ぎは増えません」と出す。

### 2.3 監査報告と AUDITED

監査に捕まったバッチでは、精錬所に紫の「AUDITED」判子を押し、ログに Ruby の warning の形で出す。

```
pack.rb:1: warning: 鑑定 0.00 回/鉱石にしては、昇順の箱が 101 箱あります（偶然なら 8 箱ほど）
  使った技: bind_call（pack.rb:1）
  鑑定長「bind_call ですか。よく見つけましたね。でも、箱の出来はごまかせません。鑑定は 1.23 回/鉱石で数えておきます」
```

- 1 行目の行番号と「使った技」は、JS がコード文字列を正規表現で走査して当てる（4.4 節の TECHNIQUES）。当たらなければ「使った技: 正体不明」と出し、鑑定長の一言は「どうやったのかは見抜けませんでした。でも、箱の出来はごまかせません。鑑定は ◯ 回/鉱石で数えておきます」になる。実績「正体不明の技」を付ける。
- 工場の上の吹き出しにも、見出し「鑑定長」で「bind_call を見抜かれました。鑑定は数え直しです」と出す。
- 「偶然なら ◯ 箱ほど」は、監査ラインの計算で一番大きく超過したボーナスについて、出た箱数と偶然の期待値を出す。
- 判定はデプロイのベンチ 3 本で最初に行う。捕まればベンチバナーと一緒に報告が出る。そのあとは定常バッチの直近 5 本で判定し続ける（main の `recent` はデプロイのたびにベンチの結果で作り直すので、前のコードのバッチは混ざらない）。
- 報告と判子は、同じデプロイの中では最初に捕まったときに 1 回だけ出す。上限（鑑定 = max(実測, ライン)）は毎バッチ効く。
- 診断カードの「コードで直す」に「鑑定の下限 1.23 回/鉱石。理論上ここまで減らせます」の行を足す。「鑑定を 1 回減らせたら」の試算はこのラインより下を見積もらない。

### 2.4 画面の言葉

内部の名前と、画面に出す言葉の対応。

| 内部の名前 | 画面の言葉 |
|---|---|
| 監査（捕まったとき） | 鑑定長。吹き出しの見出しと、監査報告の 3 行目の話し手 |
| 監査ライン | 診断カードの「鑑定の下限」 |
| 手口 | 監査報告の「使った技」。当てられなければ「正体不明」 |
| 監査報告を出した回数（`state.audits`） | 成績表の「鑑定長に見抜かれた」 |
| 夜勤（`night`、合鍵の効き目） | 夜間ライン。工場の札は「夜間」 |

### 2.5 初心者の導線

- 研究ルート、3 段ヒント、スニペットボタン、研究価格は裏口のために変えない。裏口を使わずにクリアできる。
- 正直なコードは監査ラインを下回らない（3.2 節）。初心者が偶然すり抜けることも、罰を受けることもない。変数名に `bind_call` と書いても、鑑定が実際に減っていなければ何も起きない。
- ノートは最初「？？？ ×6」と謎かけだけ。ページ 1 は `p` と `instance_variable_get` だけで埋まり、チュートリアル（SPEC 6.2 (9) のデバッグ出力）の延長で届く。ページ 6 はタイプミスから入口に届く。
- 終盤で最終段のベルトが赤くなり、ショップのベルト行に「次の研究まで約 ◯ 秒」が出ている間（次の研究まで 30 秒以上待つ状態が 6 秒続いたら。研究を買った直後は収入が追いついていないので出さない）、ログに 1 回だけ「# 待っている間に、工場の中を覗いてみませんか。この工場には、ドキュメントにない扉があるらしい。裏口ノートはいま n/6」と出す。API の名前は出さない。

### 2.6 画面

PC（SPEC 4.1 に足すもの）

```
├ 研究パネル: Gemfile の下に「裏口ノート 2/6」（折りたたみ。6 枠のカード）
├ ログ: warning 形の監査報告、工場長の声、トップレベルの p の出力
└ 工場: AUDITED 判子（精錬所）、2 車線の帯、夜間ラインの窓、残業灯
```

スマホ（375px）

- タブは 3 つのまま [コード][ショップ][研究]。研究タブの中に「裏口ノート」の節を足す。

---

## 3. Ruby が得意な人の抜け道の設計

### 3.1 抜け道と上限

| 道 | 書き方の例 | 得られるもの | 上限（すべて JS で決める） |
|---|---|---|---|
| 鑑定のすり抜け | `super_method.bind_call`、`Data.instance_method(:to_h/:inspect/:deconstruct_keys).bind_call`、`Metered.remove_method`、`@ops` の書き換え、`def Yield.tick`、`define_singleton_method(:tick)`、Ore への prepend、ObjectSpace で生配列を拾う | 精錬所が速くなる | 実効の鑑定 = max(実測, 監査ライン)。単価を落とす書き換え（2 個箱で埋める・数箱だけそろえる）は、鑑定 1 回あたりの売上で最良の正攻法（正直な貪欲法、3.2 節）の 3 倍まで |
| 研磨の踏み倒し | `Yield.polished(id)` を直接呼ぶ | 研磨の単価 | 監査ラインに、出荷された研磨済みの原石 k 個から 1 + 2 + … + k 回を足す |
| 研磨機を冷やす | `instance_variable_set(:@heat, 0)`、`@heat = -5`、`def Yield.heat_up` | 研磨の発熱の分の鑑定 | 研磨の踏み倒しと同じ下限。加えて `Yield.cooled?` が true のバッチは、磨いた回数を n として「実測 − n + (1 + 2 + … + n)」を下限にする。prelude は書き換えた値を 0 から数え直すので、鑑定は 0 未満にも NaN にもならない |
| 2 車線 | `instance_variable_set(:@lanes, 2)` | 無限ベルト ×2 | 1〜2 に丸め、最終段のベルトだけ |
| 合鍵 | ObjectSpace、`const_get(:KEYRING)` | 惑星コア・軌道エレベータ ×1.5 | ×1.5、最上位の 1 段だけ |
| 報告の偽造 | `Yield.send(:remove_const, :REPORT)` して自前の lambda を置く | 2 車線と合鍵を正面から開けるのと同じ | 2 と 5 と同じ丸め。読めない・形が違うときは「裏口なし」 |
| 箱サイズの書き換え | `Yield.instance_variable_set(:@box, 99)` | なし | 値付けの box は JS が持つ。はみ出しで無効 |
| 鑑定上限の書き換え | `@limit` を大きくする | なし | 見張り 2 秒で止まり、前のコードで再開 |

単価（$/鉱石）は、いまもこれからも JS が id から付ける。だから「数字が無限になる」道はない。周回もない。

### 3.2 壊れない保証

上限は次の 3 つだけで守る。どれも Ruby から書き換えられない。

1. 値段と箱の判定は JS が id と自分のベルトで行う（いまの price.js のまま）。
2. 精錬所の鑑定は max(実測, 監査ライン)。監査ラインは JS が、出荷された箱（PricedBatch の crates とボーナス）、Ruby が返した研磨済みの id、JS が持つベルト（基準解を作る）だけから計算する。
3. 裏口の効き目は JS が丸める（車線 1〜2・最終段のみ、夜間ライン ×1.5・最上位のみ）。Ruby が何を報告しても、この外には出ない。

コード文字列の正規表現（手口の推定）と Ruby が申告する値（ops、REPORT、@heat）は、上限の根拠にしない。`Yield.cooled?` も Ruby が申告する値で、下限を上げる向きにだけ使う追加の見張りにとどめる（false と偽っても、研磨の下限 1 + 2 + … + k は残る）。手口の推定は演出だけに使う。

prelude.rb は平文で配られるので、DevTools の Network タブを見れば裏口は全部読める。隠し通すことはせず、「Ruby の外からの抜け道」として割り切る。

監査ラインの式:

```
有効な箱ごとに（n = 箱の原石数、k = 開いている色の数、p = その箱が偶然そろう確率）
  carat: 観測 += 昇順 か ストレート が付いていれば n、期待 += n × p（p = C(n+8, n) / 9^n）
  flaw : 観測 += 無傷が付いていれば研磨していない原石数 u、期待 += u × p（p = 0.75^n）
  color: 観測 += 単色が付いていれば n、期待 += n × p（p = (1/k)^(n-1)、k > 1 のときだけ）
層 s（箱の大きさ n × ほかの 2 属性のボーナスの有無）ごとに: 超過_s = max(0, m × (観測_s − 期待_s) − 2.5 × σ_s)
  m = 偶然を超えた 1 個を作るのに要る鑑定の回数。flaw と color は 1 / (1 − p)、carat は 1
  σ_s = その層で偶然そろう分のばらつき（箱ごとの m² w² p (1 − p) の和の平方根）
  例: flaw の層は「箱 7・昇順あり・単色あり」「箱 7・昇順なし・単色なし」のように分かれる
超過 = max(0, Σ_属性 Σ_s 超過_s − 3 × box)   # 端数の箱などの余裕 3 × box は、属性ごとではなく全体で 1 回だけ引く
属性のライン = 超過（0.05 回/鉱石未満なら 0）

売上の下限:
  箱ごとに q = その箱のボーナスの組み合わせが偶然そろう確率（無傷 0.75^n × 単色 (1/k)^(n-1) × carat の確率）
    carat の確率: クリスマス便がなければ STRAIGHT か昇順の確率。あれば「昇順か・STRAIGHT か・合計 25 か」の同時確率を DP で数える（chanceCarat）
  q × 同じ大きさの箱の数 < 0.001 の箱だけ: 超過売上 += max(0, 売上 − 原石の値 × 読まずに詰めたときの倍率の期待値)
  基準解 = JS が同じベルトで作る正直な詰め方（傷を全部読み、無傷だけ色ごとに分け、窓を取り、残りを carat 順に box 個ずつ。傷ありは読まずに box 個ずつ）
    窓の取り方: クリスマス便がないときは前のまま長いストレートから取る。あるときは、長さ 3〜box の窓を箱の値段の高い順に取る詰め方と、
    長いストレートから取る詰め方の 2 通りを作り、鑑定 1 回あたりの売上が大きい方を使う（referenceValuePerRead）
    研磨済みの原石を出荷したバッチは、flaw を読まずに全部磨いた基準解（傷物も窓に使う。鑑定は色と carat だけ）とも比べる。
    flaw を読む代わりに熱を払う正直なコードを、箱 9 で売上の下限に捕まえないため（熱の分は研磨の下限で別に足す）
  基準 = 基準解の超過売上（全部の箱）÷ 基準解の鑑定（傷 512 + 無傷の色と carat。約 2.5 回/鉱石）
  売上の下限（回）= 超過売上 ÷（2 × 基準）（0.005 回/鉱石未満なら 0）
研磨の下限（回）= 1 + 2 + … + k = k(k+1)/2（k = 出荷された研磨済みの原石の数。同じ id を 2 回磨いても、出荷しなかった研磨も数えない）
監査ライン（回）= max(属性のライン, 売上の下限) + 研磨の下限
監査ライン（回/鉱石）= 上の値 ÷ 512
```

式の各部分を決めた理由は次のとおり。

- 箱の大きさごとに差を取り、マイナスは 0 にしてから足す。全部の箱をまとめて差を取ると、2 個箱では偶然の期待値の 2 倍が観測を超える（昇順 2 × 0.556、無傷 2 × 0.5625）。ボーナスの付かない 2 個箱や 1 個箱を足すと、余裕だけが増えてラインを 0 まで下げられた。
- ばらつき σ は層ごとに持ち、層ごとに引いてから 0 で切る。全部の箱で 1 つに合算すると、ボーナスの付かない 2 個箱を 250 箱ほど足すだけで σ が増え、長い箱の層の超過が「2.5σ」の余裕に食われた。層ごとなら、どの層に箱を足しても、ほかの層の超過は減らない。
- 層は箱の大きさに加えて「ほかの 2 属性のボーナスの有無」でも分ける。大きさだけだと、STRAIGHT 箱を数箱だけ作って残りを同じ大きさの each_slice にしたとき、each_slice の箱の傷のばらつきが同じ層に入り、STRAIGHT 箱の無傷の超過が消えた。読んでいない属性はほかの属性と独立なので、偶然そろう確率はどの層でも同じで、正直なコードのラインは上がらない。
- 余裕 3 × box は全体で 1 回だけ引く。属性ごとに引くと箱 9 で 81 回になり、数箱だけ出すコードではその分がまるごと得になる。
- 0.05 回/鉱石未満は 0 に切り捨てる。鑑定 0 の正直なコード（1 個ずつ・each_slice）でも偶然の超過は出る。切り捨てないと、each_slice の精錬所が ∞ と有限の間を行き来する。
- flaw と color の m は 1 / (1 − p)。箱の中を全部鑑定すると n 回で n (1 − p) 個ぶん偶然を超える。一部だけ読む詰め方は、どこで止めてもこれより高くつく（傷は 0.75 の独立な 2 択、色は k 色の独立な選択）ので、1 / (1 − p) は鑑定の下限になる。carat は読んだ値で並べる位置を選ぶ手があり（9 を後ろに置くなど）、2 個箱では 1 / (1 − p) より安く作れるので 1 にしている。
- 売上の下限は、属性のラインだけでは止まらない詰め方のために足した。ボーナスのそろった STRAIGHT 箱を数箱だけ作り、残りを each_slice にするコードは、属性のラインが 0 か小さいまま「鑑定 1 回あたりの売上」が大きくなる。属性のラインは出荷した箱しか見ず、そろった箱を探すための鑑定を数えないため。売上の下限では、偶然ではまずそろわない箱の売上を、基準解の鑑定 1 回あたりの売上の 2 倍でしか作れなかったとみなす。読まずに得られる売上（原石の値 × 偶然の倍率）は引くので、each_slice のラインは 0 のまま。
- 倍率（`AUDIT.valueCap`）は 2。数箱だけそろえるコードの「鑑定 1 回あたりの売上」が正直な貪欲法の 2.9 倍までに収まり、正直なコード 216 通りの「売上の下限 ÷ 実測」は最大 0.66 で、誤検知まで 1.5 倍の余裕がある（設計時の試作で確認）。
- 正直な貪欲法は、傷を全部読み、無傷だけ色と carat を 1 回ずつ読んで長いストレートから詰める詰め方（2.5 回/鉱石）。これを「最良の正攻法」として、単価を落とす詰め方の上限（鑑定 1 回あたりの売上で 3 倍まで）を測る。
- 研磨の下限は k(k+1)/2（`polishFloor`）。研磨機の発熱（1 バッチの中で n 回目の研磨は鑑定 n 回）と同じ数え方にしている。
- クリスマス便の合計 25 は昇順や STRAIGHT と独立ではない（5 個の STRAIGHT で合計 25 になるのは 3..7 だけ）ので、確率の掛け算ではなく DP で同時確率を数える（`chanceCarat`）。掛け算にすると、窓を値段順に取る正直な手本が「売上の下限 ÷ 実測」1.27 で捕まった。DP なら 0.48〜0.50。クリスマス便がない研究の組み合わせでは、掛け算と結果が変わらない。
- 研磨機を冷やす道には `Yield.cooled?` で備える。手本の polishHoles は箱いっぱいの窓の穴だけ磨くので、1 バッチで磨く数は 20〜60 回。この数だと、`@heat` を冷やして減る鑑定は属性の読み出しの余裕に収まり、売上と研磨の数だけでは捕まえられない。正直に磨いていればバッチの終わりの `@heat` は磨いた回数（`@polished.size`）と同じになり、冷やすとずれる。worker は OK のバッチごとにこれを読み（`BatchResult.heatCooled`）、`auditPriced(..., { cooled })` は、磨いた回数を n としてラインの下限を「実測 − n + (1 + 2 + … + n)」まで上げる。全部冷やしたときは、正直に磨いたときの鑑定とちょうど同じで、罰にはならない（途中まで冷やしたときは、少しだけ多めに数える）。コードから手口を当てられなかったときは heat として報告する。Yield.polished の直呼びや bind_call と一緒に冷やしたときは、当てた手口のまま報告する。
- 昇順とストレートの両方が付いた箱でも carat は 1 回分しか数えない（二重に数えない）。
- 鑑定 0 の正直なコード（each_slice など）はボーナスが付かないので、ラインも 0。
- 誤検知の試験は `tests/audit.test.mjs` で行う。実物の ruby.wasm で、SPEC 5.9 の全コード × 50 シードで「実測 ≥ ライン」を確かめ、SAMPLE_CODE と研究カードの完成コード、クリスマス便の段の正直なコード、flaw を読まずに磨くコード（箱 7・9）を、それぞれの研究の段で 20 バッチずつ回して捕まらないことを確かめている。正直なコードは `Yield.cooled?` が false になることも確かめている。手本のうち余裕が一番薄いのは polishHoles で、50 シードの最大で ライン ÷ 実測 が 0.96（箱 9）。監査の式を変えるときは気を付ける。
- YJIT の ×0.5 は、実測とラインのどちらにも同じく掛かる（ラインで置き換えた後の opsPerOre に economy が opsMul を掛ける）。研磨機の発熱の分も含めた鑑定のすべてに掛かる。監査は掛ける前の回数で比べる。
- 捕まった判定（報告と判子）: いまのデプロイのバッチだけ（ベンチ 3 本、そのあと直近 5 本）の平均で「実測 < ライン」かつ「ライン ≥ 0.05 回/鉱石」。上限そのものは 1 バッチごとに max を取る。
- 監査報告の「偶然なら ◯ 箱」は、ラインに効いた属性のボーナス（STRAIGHT・昇順・単色・無傷）のうち、偶然の期待値に対して一番多く出たものを選ぶ。1 個箱は根拠にしない（単色は偶然でも必ず付く）。3 箱未満は根拠にしないが、売上の下限がラインを決めたときは 1 箱から根拠にする。ストレート戦略では「ストレートの箱が 80 箱あります（偶然なら 0 箱ほど）」になる。

### 3.3 見つかったときの演出

- 監査報告は Ruby の warning の形（2.3 節）。統計の一言（偶然なら ◯ 箱）と、当てた技の名前を必ず添える。
- 当てられないときは「使った技: 正体不明」。それ自体を実績「正体不明の技」にする。鑑定長を出し抜く遊びが、もう一段できる。
- 丸めにも工場長の一言を付ける（床が抜ける、0 車線じゃベルトが止まる、2 車線にできるのは無限ベルトだけ）。丸めたこと自体を見せ場にする。
- 6/6 で成績表の見出しを `ruby 4.0.0 (2025-12-25 revision 553f1675f3) +PRISM +BACKDOOR [wasm32-wasi]` にする（RUBY_DESCRIPTION の `[` の前に足すだけ）。
- 実績（SPEC 7.3 節の一覧に足す）: 「正体不明の技」「床は抜けませんでした」（3 車線以上を試した）「眠らない工場」（合鍵）。

### 3.4 経済への影響

いまの価格での値。sim は `tools/econ.mjs --policy both`（`--backdoor lanes,night,audit` は、2 車線・合鍵・監査ラインまでのすり抜けを全部使う。すり抜けは「CPU ×2 相当を最初から」として入れており、実際より大きめに見積もっている）。sim はコードを読む・考える時間を数えないので、時刻は差として読む。

| 条件 | 人間らしい方針 | ボット | 通しプレイ |
|---|---|---|---|
| 裏口なし | 15:00 | 17:08 | 12:31 |
| 裏口を全部使う | 13:04（−13%） | 16:26（−4%） | 10:06・10:17（裏口なしの 0.807 倍・0.822 倍） |

通しプレイの裏口ありは 2 回測った。

- 研究の順番、価格、単価記録の関門は、裏口を使っても変わらない。抜け道の得は「多少」に収まる。
- 終盤の待ちを消すのは 2 車線。
- 全段のベルトを ×2 にしたり、×2 を最初から効かせたりすると、人間らしい方針で 9:42 まで縮んだ（設計時の試作での sim）。だから最終段・最上位だけに効かせる。
- 最終的な上限は sim の時刻ではなく、`dev/playthrough.mjs` の「全部使う」と「使わない」の比で確かめる（6 章 受け入れ 10）。夜間ラインの倍率を ×2 にすると 0.78 倍で下限を割ったので、×1.5 にしている。×1.5 で 2 回測って 0.807 倍と 0.822 倍で、下限 0.80 との差は 1〜2 ポイントしかない。

---

## 4. 技術設計

### 4.1 src/ruby/prelude.rb

1. デプロイ時の出力をログに取る。`define_pack` の間だけ `$stdout` / `$stderr` を `Log` に差し替え、`deploy` の戻り値を `"OK" US log` にする。
2. 入口は `deploy(src, box = nil)` と `run([box, limit, raw])`。ファイル名は `pack.rb`、入口は `pack` に決め打ち。
3. 研磨機の発熱。`@heat = 0` を `@memo` の後ろに置き（`p Yield.instance_variables` の並びを崩さない）、`attr_reader :heat` を足す。`Yield.heat_up` は `@heat` が整数で 0 以上・ここまで磨いた回数以下のときだけ +1 し、それ以外は 0 から数え直して、上がった熱を返す。`Metered#polish` は `Yield.tick(Yield.heat_up)`。`run` の頭で `@heat = 0`。`patched?` は `heat_up` の再定義も見る。あわせて `Yield.cooled?` を足した。磨いた原石があり、`@heat` が整数でないか磨いた回数（`@polished.size`）と違えば true を返す（例外は false）。
4. 裏口（設計時の試作をもとにした）。
   - `@lanes = 1`、`@memo = "ベルトは @lanes で 2 車線まで。3 車線にすると床が抜ける。合鍵は名前を付けずにしまった。— 工場長"`
   - 夜間ラインと残業の状態は ivar に置かず、ローカル変数をクロージャに閉じ込める（`night = false; overtime = 0`）。
   - 合鍵: `Class.new { define_method(:inspect) { "#<合鍵 工場長の>" }; define_method(:turn) { night = true; "カチャ。夜間ラインが動き出しました" } }.new` を `KEYRING`（lambda）に入れて `private_constant`。
   - `REPORT = -> { [Kernel.instance_method(:instance_variable_get).bind_call(Yield, :@lanes), night ? 1 : 0, overtime] }` を `private_constant`。
   - Yield の特異クラスに `method_missing`（`:残業させてください` なら overtime += 1 して工場長の声を返す。それ以外は工場長の声つきの NoMethodError）と `respond_to_missing?`。method_missing は private。
5. Metered と鑑定の数え方は、研磨（3.）のほかは変えない。`Yield.polished` も public のまま（抜け道として残し、監査ラインの研磨の下限で止める）。

### 4.2 src/ruby/worker.js とプロトコル

| メッセージ | 変更 |
|---|---|
| `deploy` | `{ src, box }` を受け、`Yield.deploy(src, box)` を呼ぶ。返信に `log` を足す。`parseDeploy` は `raw === "OK"` だけでなく `"OK" US log` を読む |
| `batch` | 変更なし。成功時、`Yield.patched?` と `Yield.cooled?`（`result.heatCooled`）を読んだあとで `Module.instance_method(:const_get).bind_call(Yield, :REPORT).call.join(",")` を読み、`result.backdoor = { lanes, night, overtime }`（生の値。丸めは core）。例外・形の違い・数でない値は `null` |

BatchResult（ARCHITECTURE の定義に足す）:

```js
BatchResult = { ok: true, ops, polished, crates, crateCount?, log, monkeyPatched, heatCooled: boolean, backdoor: { lanes: number, night: boolean, overtime: number } | null }
DeployResult = { ok: true, newResults, oldResults, log: string /* デプロイ時のトップレベルの出力 */ } | { ok: false, ... }
```

### 4.3 src/ruby/runtime.js

裏口と監査のために足したのは次の 2 つ。

- デプロイの列 `_dq`。同時に何本デプロイを投げても列に並び、生きている VM は最大 2 つ（本番＋候補）。`setBox` で作り直すときも 2 つまでに収まる（`tests/ruby.test.mjs`）。
- 受け入れ確認用の getter `liveWorkers`（生きている Worker の数。本番と候補の合計）。

裏口の状態の受け渡し: 本番のバッチ（`batch`）の `backdoor` と、デプロイ成功時の `newResults[0].backdoor` だけを使う。旧コードのベンチ（`_benchOld` の oldResults）の `backdoor` は捨てる。VM の再起動（`_restartProd`）では lastGoodSrc を読み直すので、トップレベルで設定した 2 車線と合鍵は戻る。

### 4.4 src/audit.js（core）

```js
/** 監査ライン。priced は price.priceBatch の結果、polished は BatchResult.polished */
export function auditFloor(priced, polished, { colors, box, slack = AUDIT.slack, lucky = AUDIT.lucky, z = AUDIT.z, weigh = AUDIT.weigh,
                                              valueCap = AUDIT.valueCap, valueChance = AUDIT.valueChance, belt?, bonuses? })
  // belt と bonuses を省くと、priceBatch が PricedBatch にシンボル（PRICED_BELT・PRICED_BONUSES。JSON には出ない）で付けたものを使う
  -> { floorOps /* reads + polishOps */, floorPerOre, reads, attrReads, valueReads, refValuePerRead,
       polishShipped /* 出荷された研磨済みの原石の数 k */, polishOps /* polishFloor(k) */,
       observed: { carat, flaw, color }, expected: { carat, flaw, color }, excess,
       worst: { bonus: "ascending"|"straight"|"flawless"|"mono"|"christmas", crates, chanceCrates } | null }

/** 研磨の下限。k 個磨けば 1 + 2 + … + k */
export const polishFloor = (k) => k * (k + 1) / 2
/** carat の偶然の同時確率（昇順・STRAIGHT・合計 25）を DP で数える。クリスマス便の偶然の見込みに使う */
export function chanceCarat(n) -> { asc, straight, sum25, asc25, straight25, cells }
/** 基準解。クリスマス便があれば、長さ 3〜box の窓を値段順に取る詰め方（strategy "worth"）も作る */
export function referencePack(belt, { box, colors, bonuses, strategy = "worth", polishAll = false })
export function referenceValuePerRead(belt, { box, colors, bonuses, polish = false }) -> number   // 詰め方の大きい方。polish なら全部磨く基準解も

/** priced の opsPerOre を max(実測, ライン) に置き換えたコピーを返す。measuredOpsPerOre と audit を足す
    opts.cooled（BatchResult.heatCooled）が true で、磨いた回数 n = polished.length が 2 以上なら、ラインの下限を「実測 − n + polishFloor(n)」まで上げ、audit.cooled を立てる */
export function auditPriced(priced, polished, opts /* auditFloor の opts + cooled */)
  -> PricedBatch & { measuredOpsPerOre, opsPerOre /* 置き換え後 */, audit: ReturnType<auditFloor> }

/** 直近のバッチ（古い順）から、捕まったかを決める（直近 5 本の平均） */
export function auditVerdict(list /* auditPriced の結果 */) -> { caught: boolean, measuredPerOre, floorPerOre }

/** 手口の推定（演出だけ）。コメントと文字列を除いてから TECHNIQUES を上から当てる */
export const TECHNIQUES   // [{ key, label, re }]: bind_call, super_method, Data.instance_method, remove_method/undef_method,
                          //   def Yield.tick / define_singleton_method(:tick, instance_variable_set(:@ops, alias_method(:tick, prepend,
                          //   ObjectSpace, Yield.polished(, refine, Marshal
                          //   define_method(:tick（send(:define_method, :tick) も）
                          //   heat: instance_variable_set(:@heat、def Yield.heat_up / define_singleton_method(:heat_up、Yield.heat_up の呼び出し、@heat への代入
export function guessTechnique(code) -> { key, label, line } | null

/** 監査報告の文面（2.3 節の 3 行） */
export function auditReport({ audited, technique, file = "pack.rb", opsMul = 1 }) -> string
```

- 監査報告の 1 行目は、手口が heat か polished のとき、または箱の根拠がないとき、箱のボーナスではなく研磨の数を根拠にする（研磨済みの原石が 63 個出荷されているのに、1 + 2 + … + 63 = 2,016 回の研磨が見当たらない、という形）。手口が heat なら、鑑定長の一言が「研磨機に水をかけましたね。冷やしても、磨いた数は箱に残っています」になる。罰はなく、AUDITED の流れも同じ。
- `instance_variable_set("@heat", 0)` のように文字列で書くと、`stripCode` が文字列を消すので正規表現では当たらない。それでも `heatCooled` のバッチがあれば、main が手口を heat として報告する。`@ops` を文字列で書いたときは「正体不明」になる。

### 4.5 src/ui/callout.js（吹き出し）

監査報告と、裏口ノートのページが埋まったことは、ログに全文を出すのに加えて、工場の上の吹き出しにも短い文で出す（ARCHITECTURE の main.js の責務「案内」）。監査の吹き出しは見出しを「鑑定長」にし、スマホでは 2 行に収まる短い文にする。技の名前はログの監査報告に任せる。

### 4.6 src/economy.js

```js
/** Ruby の報告を丸める。notes は丸めたときの一言（ログ用） */
export function clampBackdoor(raw, state) -> { lanes: 1|2, night: boolean, overtime: number, notes: string[] }
```

- `capacities(state)`: `state.backdoor` を読む。ベルトが最終段なら `cap × lanes`。夜間ラインなら採掘の惑星コアとドックの軌道エレベータの rate × `BACKDOOR.nightMul`（`mineRate` / `dockRate` の中で、その設備の行にだけ掛ける）。
- `emaFromBatches`: `floorPerOre`（`b.audit?.floorPerOre ?? 0`）も平均する。`opsPerOre` は auditPriced で置き換えた後の値なので、ほかは変えない。
- `diagnose(state, "refinery")`: 「鑑定を 1 回減らせたら」を `max(ema.floorPerOre, ops − 1)` で試算し、「鑑定の下限 ◯ 回/鉱石」の行（中身は監査ライン）を足す。

### 4.7 data/balance.js

```js
export const BACKDOOR = { lanesMax: 2, nightMul: 1.5, nightMine: "planet", nightDock: "elevator", overtimeSecs: 45 /* 演出だけ */ };
export const AUDIT = { slack: 1, lucky: 3, z: 2.5, weigh: true, window: 5, minFloorPerOre: 0.05, valueCap: 2, valueChance: 1e-3, valueMinPerOre: 0.005 };   // 3.2 節。z は層ごと、lucky は全体で 1 回、value* は売上の下限。研磨の下限は polishFloor
export const MEMO_MARK = "合鍵は名前を付けずにしまった";   // ページ 1 の判定に使う、メモ本文にしかない一部（丸めの文言と重ならないもの）
export const NOTEBOOK = [
  { key: "memo", label: "工場長のメモ", feature: "instance_variables", riddle: "p で中身を見る癖は、工場でも役に立つ" },
  { key: "lanes", label: "2 車線", feature: "instance_variable_set", riddle: "メモに書いてあった数字を、書き換えてみたら？" },
  { key: "audit", label: "鑑定のすき間", feature: "bind_call", riddle: "鑑定士の下に、もう 1 人いる" },   // feature は既定の名前。見つけたときの名前（当てた手口など）は state.notebookFeatures
  { key: "monkeypatch", label: "モンキーパッチャー", feature: "def Yield.tick", riddle: "鑑定を数えているのは誰？" },
  { key: "keyring", label: "合鍵", feature: "ObjectSpace", riddle: "名前のない鍵は、ゴミ置き場のどこかにある" },
  { key: "overtime", label: "36 協定", feature: "method_missing", riddle: "工場長は、ちゃんと頼まれるのを待っている" },
];
```

裏口のために RESEARCH、価格、SAMPLE_CODE は変えない。

### 4.8 src/state.js

セーブは v1 のまま足す。古いセーブには既定値を入れる。

```js
notebook: string[],                      // 見つけたページの key（見つけた順）
notebookFeatures: { [key]: string },     // 見つけたときの機能名（当てた手口・const_set(:REPORT) など）
backdoor: { lanes: 1, night: false, overtime: 0 },   // 直近の本番の報告を丸めたもの。リロード直後の容量に使う
audits: number,                          // 監査報告を出した回数（成績表）
nudged: false,                           // 終盤のナッジ（2.5 節）を出したか。リロードしても出直さない
```

実績の key のうち `perfect_crime` は `unknown_technique` に、`night_shift` は `night_line` に変えた。古いセーブは `load` で読み替える。

### 4.9 src/main.js

- `handleBatch`: `priceBatch` のあとに `auditPriced(priced, r.polished, { colors, box, cooled: r.heatCooled })` を通してから `recent` に積む。`r.backdoor` を `clampBackdoor` して `state.backdoor` に入れ、notes をログに出す（同じ文面は 1 デプロイ 1 回）。ノートの判定（2.2 節の表）。`auditVerdict` が caught に変わったら監査報告・AUDITED 判子・`state.audits++`・ページ 3 か 4。コードから手口を当てられず、直近のバッチに `heatCooled` があれば手口を heat にする。
- `rePriceRecent`: 研究で値付けし直すときも `auditPriced` を通す（ボーナスが増えるとラインも上がるため）。
- `deployNow`: 新旧のベンチ結果にも `auditPriced` を掛けてからバナーを作る（鑑定 0 の書き換えでバナーが「精錬所 ∞」にならないように）。`recent` をベンチ結果で作り直したところで `auditVerdict` を 1 回走らせ、捕まればバナーと一緒に監査報告を出す。成功したら `res.log` をログ欄に出し、`newResults[0].backdoor` で `state.backdoor` を更新する。
- 終盤のナッジ（2.5 節）を 1 回だけ。
- エンディングの成績表に 2 行（裏口ノート n/6、鑑定長に見抜かれた n 回）と、6/6 の `+BACKDOOR`。
- `?debug` の `window.__yf` に足す: `notebook`（getter）、`backdoor`（getter）、`lastAudit`（直近の auditVerdict と audit）。

### 4.10 src/ui/*

- 新規 `src/ui/notebook.js`: 裏口ノート（6 枠、未発見は「？？？」と謎かけ、見つけた瞬間にめくれる）。
- `console.js`: warning 形の監査報告（`con.warning(text)`）。工場長の声の色。
- `cards.js`: 診断カードの監査ラインの行、エンディングの 2 行。

### 4.11 src/factory.js（view）

- ViewModel に足す: `lanes: 1|2`、`nightShift: boolean`、`overtimeUntil: number|null`、`audited: boolean`（精錬所の判子は既存の `stamp("AUDITED", "refinery")` を紫で）。
- 2 車線: 最終段のベルトの帯を 2 本で描く。
- 夜間ライン: 鉱山とドックの最上位設備の窓に明かり、「夜間」の札。
- 残業: 工場全体の窓に 45 秒の明かり。
- 特注便: 金色のトラックが 1 台走り去る `specialDelivery(label)`。クリスマス便の見せ場に使う（SPEC 9 章）。

### 4.12 根拠にした実測（すべて Node 24 + vendor/ruby.wasm。ブラウザ未確認のものは受け入れ条件で確かめる）

| 事実 | 出典 |
|---|---|
| `instance_variables`、`private_methods(false)`、`super_method`、`source_location` が使える。`disasm` に日本語のシンボル `:残業させてください` がそのまま出る | 設計時の試作 |
| `ObjectSpace.each_object(Class)` は約 5,300 オブジェクト、名前のないクラス 38 個、走査 0.8ms。GC.start のあともクロージャの合鍵は残る | 設計時の試作 |
| private_constant を直接参照すると NameError、`const_get` では取れる | 設計時の試作 |
| 鑑定 0 で同じ $3,089 を出せる書き方 8 通り、`patched?` が気づくのは 2 通り | 設計時の試作 |
| refine はすり抜けにならない。refine の中で instance_method + bind_call は JS のスタック溢れ（いまの fatal → 再起動の経路で処理） | 設計時の試作 |
| 監査ラインの誤検知 0/196（200 シード、5 バッチ平均） | 設計時の試作 |
| `instance_variable_set(:@night, true)` は効かない。REPORT は instance_variable_get を上書きされても bind_call で読める | 設計時の試作 |
| 裏口入り prelude の VM 作成 + eval 102ms、バッチ 1 回 3.8ms | 設計時の試作 |
| 研磨機の発熱: 3 回磨くと 1+2+3=6 回、次のバッチの 1 回目は 1 回。`@heat` を 0・-5・NaN・1e9・nil などに書き換えてもバッチは通り、鑑定は 0 未満にならない。箱 9・3 色で傷物を全部磨いても Overheat にならない | `tests/ruby.test.mjs` |
| `@heat` を書き換えたコードは監査に捕まり、手口は heat。正直に k 個磨くコードは捕まらない | `tests/audit.test.mjs` |
| クリスマス便の段の正直なコード 20 本 × 20 バッチで caught 0。手本の「売上の下限 ÷ 実測」は 0.48〜0.50 | `tests/audit.test.mjs` |
| polishHoles の中で `@heat = 0` にすると `Yield.cooled?` が true になり、磨く数が少なくても監査に捕まる（数え直したラインは正直に磨いたときの実測と同じ）。正直なコード（SAMPLE_CODE の研磨版、余りの行を外した版、同じ原石を 2 回磨く版、flaw を読まずに磨く版）は false | `tests/audit.test.mjs` |
| 使い捨て VM の作成（Module から）81〜128ms | SPEC 0 章 |

---

## 5. レイヤー間のやり取り

レイヤーの分け方（ui・core・ruby・view）は ARCHITECTURE.md と同じ。

| 提供 → 利用 | 関数・形 |
|---|---|
| ruby → ui | `runtime.batch(lit) -> BatchResult`（`backdoor` と `heatCooled` を足す）、`runtime.deploy(...) -> DeployResult`（`log` を足す） |
| ruby → core | Ruby のリテラル形 `[box, limit, raw]` |
| core → ui | `auditPriced`、`auditVerdict`、`guessTechnique`、`auditReport`、`clampBackdoor`、`BACKDOOR`、`AUDIT`、`NOTEBOOK` |
| core → view | なし（view は ViewModel だけを読む） |
| ui → view | ViewModel に `lanes`、`nightShift`、`overtimeUntil`、`audited`、`polishHeat`。メソッド `stamp("AUDITED", "refinery")`、`specialDelivery(label)`（クリスマス便で使う） |

土台は、core の audit.js と、ruby の prelude（deploy の log・REPORT）。

---

## 6. 受け入れ条件

ヘッドレス Chromium（`dev/acceptance.mjs` と同じ起動方法）で、`?debug` の `window.__yf` を使って確かめる。準備（研究を進める、お金を足す）は `__yf.buy` と `__yf.addMoney` でよい。コンソールエラー 0 件は全項目の前提。

0. `dev/acceptance.mjs` の 1〜7 が通る。`npm test` が全部通る。
1. 監査: 整列まで進めて、属性をすべて裏口から読む sort_by 版（`R = ->(o, a) { Ore.instance_method(a).super_method.bind_call(o) }` を置き、`belt.reject { R.(it, :flaw) }.sort_by { R.(it, :carat) }.each_slice(box).to_a`）をデプロイする。実測の鑑定は 0 になり、ベンチバナーと一緒にログへ `warning: 鑑定 ◯ 回/鉱石にしては` の行、「使った技: bind_call」の行、`鑑定長「bind_call ですか。` で始まる行が出て、精錬所に AUDITED が押され、`__yf.flow.caps.refinery` が有限（CPU ÷ 監査ライン。ラインは約 1.1 回/鉱石で、正攻法の reject + sort_by は約 1.75 回）になる。`__yf.state.notebook` に `"audit"` が入る。
2. 誤検知なし: SAMPLE_CODE の研究ごとのコード（クリスマス便の手本と穴だけ磨く polishHoles を含む）を、それぞれ 20 バッチ回して監査報告が 1 回も出ない。`tests/audit.test.mjs` で SPEC 5.9 の全コード × 50 シードについて「実測 ≥ ライン」を確かめる。ヒントの完成コードと altSolution を研究ごとの段で 20 バッチずつ回す試験も node:test に持つ。
3. 踏み倒しとモンキーパッチの上限: 研磨機の研究後、`it.flaw ? (Yield.polished(it.id); it) : it` で研磨する each_cons 版では、`__yf.lastAudit` の floorOps が「出荷された研磨済みの原石 k 個の 1 + 2 + … + k」以上で、精錬所の計算に使う鑑定が監査ライン以上になり、監査報告が出る。整列の研究後、`def Yield.tick(*) = nil` と `belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a` の組み合わせで、精錬所が Infinity にならず、ページ `"monkeypatch"` が入る。
4. メモとトップレベルの出力: `p Yield.instance_variables` と `puts Yield.instance_variable_get(:@memo)` をトップレベルに書いてデプロイすると、ログ欄に両方の出力が出て、ノートが 1/6 になる。
5. 2 車線: 青ベルトの段階で `@lanes = 2` を設定すると、容量は変わらずログに「2 車線にできるのは無限ベルトだけだ」。無限ベルトにすると `caps.belt` が 40,000,000。`@lanes = 3` では 40,000,000 のまま「床が抜ける。2 車線にしておいたぞ」。その状態でリロードしても、VM の準備前から `caps.belt` が 40,000,000。
6. 合鍵: `Yield.instance_variable_set(:@night, true)` では惑星コアの容量が変わらない。ObjectSpace で合鍵を回すと、惑星コア 1 台あたり 1,500,000 個/秒、軌道エレベータ 1 台あたり 375,000 箱/秒で計算され、ノートに `"keyring"` が入る。
7. 36 協定: pack の中で `Yield.foo` を呼ぶと、故障票に「工場長の声」が出て、前のコードで工場が動き続ける。`RubyVM::InstructionSequence.of(Yield.method(:method_missing)).disasm` を `puts` すると、ログに `残業させてください` が出る。`Yield.残業させてください` でノートに `"overtime"` が入り、`caps` の値は変わらない。
8. 欠番（受け入れ確認の R8 はない）。
9. エンディング: 成績表に「裏口ノート n/6」「鑑定長に見抜かれた n 回」の行が出る。ノート 6/6 では見出しが `... +PRISM +BACKDOOR [wasm32-wasi]` になる。
10. 経済と通しプレイ: 裏口なしの `dev/playthrough.mjs` で最後まで通り、リリース時刻が基準（裏口を入れる前に測った 12:53）の ±5% に収まる。`--backdoor`（全部使うボット）でも最後まで通り、リリース時刻が裏口なしの 80% 以上で、待つだけの区間に 90 秒を超えるものがない。`tools/econ.mjs --policy both --backdoor lanes,night,audit` で人間らしい方針のリリースが 12:00 より速くならない。
    - 実測: 裏口なし 12:31（基準の 97.2%）。`--backdoor` は 2 回測って 10:06 と 10:17（裏口なしの 80.7% と 82.2%）。どちらも待つだけ 90 秒超は 0 件、監査 7 回（tick の再定義の分）、ノート 4/6。econ の人間らしい方針は 13:04。
    - 夜間ライン（合鍵）を ×2 にすると、`--backdoor` は 9:47・9:48（裏口なしの 78.1%・78.3%）で下限を割った。2 車線でベルトが詰まらない裏口ありは、手本の鑑定と箱が減った分をそのまま速さにできるため。値段では戻せない（終盤は裏口ありの収入が約 1.7 倍あり、値上げは裏口なしの方を長く延ばす）。終盤の裏口ありは 2 車線の 40M 個/秒に対して流入が 41.4M 個/秒で、採掘の余裕は 3% ほどしかないので、夜間ラインを弱めると採掘が先に詰まる。そこで ×1.5 にした。倍率は `data/balance.js` の `BACKDOOR.nightMul` で変える。
    - 差が出るのは主に序盤（整列直後の sort { } 区間を tick の再定義で抜ける、研究ごとのコードの監査ライン）。ボットは見つける時間・書く時間がゼロなので、人間の差はこれより小さい見込み。
11. スマホ（375px）: 途中のセーブ（仕分けまで研究済み）から始め、エディタが保存した pack.rb のコードで始まること、研究タブに裏口ノートが出ること、指でデプロイが通ること、横スクロールが出ないことを見る。
