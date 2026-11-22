import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOTEBOOK, RESEARCH } from "../data/balance.js";
import { initialState } from "../src/state.js";
import { elapsed, intentUrl, pageUrl, shareText, weightedLength, X_LIMIT } from "../src/share.js";

const URL = "https://g-garden.github.io/ruby-factory/";
const opts = { url: URL, notebookTotal: NOTEBOOK.length };
const SECRET_CODE = "def pack(belt)\n  Yield.instance_variable_set(:@secret_token, 42)\n  belt.each_slice(box).to_a\nend\n";

/** 終盤の状態。数字は表示がいちばん長くなる値にする */
function cleared({ notebook = NOTEBOOK.map((p) => p.key), hours = 1 } = {}) {
  const s = initialState(0);
  s.research = RESEARCH.map((r) => r.key);
  s.record = 123.4e15;
  s.totalEarned = 999.9e15;
  s.notebook = notebook;
  s.stats.clearedAt = hours * 3600_000 + 59 * 60_000 + 59_000;
  s.code = SECRET_CODE;
  s.lastGoodCode = SECRET_CODE;
  s.codeHistory = [SECRET_CODE];
  s.stats.bestDeploy = { before: SECRET_CODE, after: SECRET_CODE, ratio: 3 };
  return s;
}

describe("X に投稿する文", () => {
  it("ページの URL からクエリと # 以降を落とす", () => {
    assert.equal(pageUrl({ origin: "https://g-garden.github.io", pathname: "/ruby-factory/", search: "?debug", hash: "#x" }), URL);
    assert.equal(pageUrl(new globalThis.URL("http://localhost:8940/ruby-factory/?debug&a=1#top")), "http://localhost:8940/ruby-factory/");
  });
  it("クエリ付きの URL を渡しても、投稿の文には ? も # も入らない", () => {
    const url = pageUrl(new globalThis.URL(`${URL}?debug#hash`));
    for (const s of [initialState(0), cleared()]) {
      const text = shareText(s, { ...opts, url });
      assert.ok(text.includes(URL), text);
      assert.ok(!/[?#]/.test(text.replace("#def_pack", "")), text);
      assert.ok(!text.includes("debug"), text);
    }
  });
  it("クリア後はクリアタイム・最高単価・裏口ノートを出し、URL と #def_pack は行を分ける", () => {
    const text = shareText(cleared({ hours: 0 }), opts);
    assert.equal(text, [
      "def pack(belt) を 59:59 でクリアしました",
      "最高単価 $123Qa/ore",
      "裏口ノート 6/6",
      URL,
      "#def_pack",
    ].join("\n"));
  });
  it("成績表のカードからは、カードと同じクリアした時点の最高単価を出す。HUD の共有はいまの記録", () => {
    const s = cleared({ hours: 0 });
    s.stats.recordAtClear = 140e3;
    s.record = 191e3;
    const card = { ...opts, atClear: true };
    assert.ok(shareText(s, card).includes("最高単価 $140K/ore"), shareText(s, card));
    // HUD の「共有」（いまの記録を共有）はクリアのあとに伸びた記録を出す
    assert.ok(shareText(s, opts).includes("最高単価 $191K/ore"), shareText(s, opts));
    // クリア時の記録がない古いセーブは、カードからでもいまの記録を出す
    s.stats.recordAtClear = null;
    assert.ok(shareText(s, card).includes("最高単価 $191K/ore"), shareText(s, card));
    // クリア前の途中経過は、いまの記録のまま
    const p = initialState(0);
    p.record = 191e3;
    p.stats.recordAtClear = 140e3;
    assert.ok(shareText(p, { ...opts, atClear: true }).includes("最高単価 $191K/ore"), shareText(p, opts));
  });
  it("クリア前は投稿した時点の累計売上と最高単価を出す。研究の数は出さない。記録がまだないときは単価の行を出さない", () => {
    const s = initialState(0);
    assert.equal(shareText(s, opts), ["def pack(belt) をプレイ中", "累計売上 $0", URL, "#def_pack"].join("\n"));
    s.research = ["crate", "inspector"];
    s.record = 400;
    s.totalEarned = 12_345_678;
    assert.equal(shareText(s, opts), ["def pack(belt) をプレイ中", "累計売上 $12.3M", "最高単価 $400.0/ore", URL, "#def_pack"].join("\n"));
    assert.ok(!shareText(s, opts).includes("研究"));
  });
  it("裏口ノートは 1 ページ以上見つけたときだけ出す", () => {
    assert.ok(!shareText(cleared({ notebook: [] }), opts).includes("裏口ノート"));
    assert.ok(!shareText(initialState(0), opts).includes("裏口ノート"));
    const s = initialState(0);
    s.notebook = [NOTEBOOK[0].key];
    assert.ok(shareText(s, opts).includes(`裏口ノート 1/${NOTEBOOK.length}`));
  });
  it("プレイヤーのコードは載せない", () => {
    for (const s of [cleared(), { ...cleared(), stats: { ...cleared().stats, clearedAt: null } }]) {
      const text = shareText(s, opts);
      assert.ok(!/def |Yield|secret_token|each_slice|```/.test(text.replace("def pack(belt)", "")), text);
    }
  });
  it("いちばん長くなる文でも X の上限よりかなり短い", () => {
    for (const s of [cleared({ hours: 12 }), { ...cleared(), stats: { ...cleared().stats, clearedAt: null } }]) {
      const text = shareText(s, opts);
      const n = weightedLength(text);
      assert.ok(n <= 160, `${n}: ${text}`);
      assert.ok(n < X_LIMIT);
    }
  });
  it("重み付きの文字数は日本語を 2、英数字を 1、URL を 23 と数える", () => {
    assert.equal(weightedLength("abc"), 3);
    assert.equal(weightedLength("研究"), 4);
    assert.equal(weightedLength(`${URL}?debug`), 23);
    assert.equal(weightedLength(`x\n${URL}\n#Ruby`), 1 + 1 + 23 + 1 + 5);
  });
  it("投稿画面の URL は x.com の intent で、文は 1 つのパラメータにエンコードする", () => {
    const text = shareText(cleared(), opts);
    const u = new globalThis.URL(intentUrl(text));
    assert.equal(u.origin + u.pathname, "https://x.com/intent/post");
    assert.deepEqual([...u.searchParams.keys()], ["text"]);
    assert.equal(u.searchParams.get("text"), text);
  });
  it("クリアタイムは時間があれば h:mm:ss、なければ m:ss", () => {
    assert.equal(elapsed(754_000), "12:34");
    assert.equal(elapsed(3_909_000), "1:05:09");
  });
});
