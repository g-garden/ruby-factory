# def pack(belt)

Ruby で磨く宝石工場。原石がベルトを流れ続ける放置系の工場ゲームです。工場の中身は、自分で書く `def pack(belt)` 1 つだけです。Ruby は ruby.wasm でブラウザの中で動きます。

- 研究を進めると、箱の大きさ・色・ボーナス（昇順、STRAIGHT、クリスマス便など）が増えます。書き方しだいで単価と鑑定の回数が変わり、工場のどこが詰まるかも変わります。
- 研究ごとに、使うメソッドと例、雛形、完成コードの 3 段のヒントがあります。
- Ruby に慣れている人向けに、画面には出てこない裏口が 6 つあります。`p Yield.instance_variables` から覗いてみてください。答えは `docs/design/SPEC-rubyist.md` の 2 章に全部書いてあり、`docs/design/SPEC.md` にも一部出てきます。自分で探したい人は、遊び終わってから開いてください。
- HUD の「共有」と、クリア後の成績表の「X で共有」で、研究の進み具合やクリアタイムを X に投稿できます。コードは載りません。

`pack.rb` の Ruby は Worker の中で動き、`require "js"` でブラウザの JS も呼べます。知らない人のコードを貼るときは、その人の JS を実行するのと同じだと思ってください。最後に動いたコードはブラウザに保存され、次に開いたときにも自動で動きます。

## 遊ぶ

```sh
npm run serve   # http://localhost:8940/ruby-factory/
```

`dev/serve.py` は GitHub Pages のサブパス配信を手元で再現します（Python 3 が要ります）。ビルドはありません。

## 開発

```sh
npm install     # テスト用の @ruby/wasm-wasi
npm test        # node:test。Ruby の部分は Node の WASI で ruby.wasm を動かして確かめる
```

ブラウザでの受け入れ確認と通しプレイは、`npm run serve` を立ち上げた状態で次のように動かします。

```sh
npm run acceptance                                  # 受け入れ確認
npm run playthrough -- playthrough-out [--backdoor] # 通しプレイ。出力先を省くと playthrough-out/
```

どちらも Playwright を使いますが、このリポジトリの依存には入れていません。`npm i -D playwright` で入れるか、別の場所にある Playwright を `.env.local` の `PLAYWRIGHT_PKG` と `PW_CHROME` で指します（`dev/pw.mjs`）。`.env.local` はなくても動きます。

仕様は `docs/design/SPEC.md` と `docs/design/SPEC-rubyist.md`、実装の約束事は `docs/ARCHITECTURE.md` にあります。

## ライセンス

このリポジトリのコードは MIT ライセンスです（`LICENSE`）。

`vendor/` に入れている ruby.wasm（@ruby/4.0-wasm-wasi 2.10.1）と `ruby-wasm-browser.umd.js` は ruby.wasm プロジェクトのものです。

| ファイル | 中身 |
|---|---|
| `vendor/RUBY_WASM_LICENSE` | ruby.wasm の MIT ライセンスです |
| `vendor/RUBY_WASM_NOTICE` | バイナリに入っている CRuby（Ruby ライセンスか 2 条項 BSD ライセンス）、LibYAML、zlib、wasi-libc、OpenSSL、wasi-vfs などの表記です。ruby.wasm の NOTICE をそのままコピーしています |
| `vendor/PRISM_LICENSE` | Prism の MIT ライセンスです。バイナリに入っていますが `RUBY_WASM_NOTICE` には載っていないので、prism の `LICENSE.md` を置いています |
| `vendor/APACHE_LICENSE-2.0` | Apache License 2.0 の全文です。OpenSSL などが使っていますが、`RUBY_WASM_NOTICE` には URL しか載っていないので置いています |
| `vendor/BROWSER_WASI_SHIM_LICENSE` | `ruby-wasm-browser.umd.js` に入っている @bjorn3/browser_wasi_shim のライセンスです（MIT か Apache-2.0） |

ゲーム画面の研究パネルのいちばん下にある「使っているソフトウェア」から、これらを `vendor/NOTICES.html` で読めます。

`vendor/` の次の 2 ファイルは npm のパッケージから手を加えずにコピーしています。

| ファイル | 入手元 | sha256 |
|---|---|---|
| `vendor/ruby.wasm` | @ruby/4.0-wasm-wasi@2.10.1 の `dist/ruby.wasm` | `84504b924bbaa5745c8280d711a1f0597d6374969b5a324d7e53994f32a94d32` |
| `vendor/ruby-wasm-browser.umd.js` | @ruby/wasm-wasi@2.10.1 の `dist/browser.umd.js` | `43d796d63912dc7bf45b0a442c2d05a1419249eacee6c188ea9460b31e41c779` |
