import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { riText } from "../src/ri.js";
import { researchEffects } from "../src/economy.js";
import { RESEARCH } from "../data/balance.js";

describe("ri 早見表", () => {
  it("研究ゼロ: box は 1、色は :red だけ、polish の行はない", () => {
    const t = riText(researchEffects([]));
    assert.match(t, /^def pack\(belt\) -> Array\[Array\[Ore\]\]/);
    assert.match(t, /belt : Array\[Ore\] +# 1 回に 512 個/);
    assert.match(t, /box +: Integer +# 1 箱に詰められる数（いま 1）/);
    assert.match(t, /color : :red +#/);
    assert.match(t, /carat : 1\.\.9/);
    assert.doesNotMatch(t, /polish/);
    assert.match(t, /p belt\.first/);
  });
  it("研究を全部: box 9、3 色、polish の行がある", () => {
    const t = riText(researchEffects(RESEARCH.map((r) => r.key)));
    assert.match(t, /（いま 9）/);
    assert.match(t, /color : :red \| :blue \| :green/);
    assert.match(t, /polish -> Ore/);
  });
  // 行の並び・文言・# の桁（23 桁目）まで固める。期待値は仕様の「中身」から手で写す（実装と同じ計算で組み立てない）
  it("仕様の例の状態（box 3・赤と青・研磨あり）: 仕様の「中身」と 1 文字も違わない", () => {
    const t = riText({ box: 3, colors: ["red", "blue"], polish: true });
    assert.equal(t, [
      "def pack(belt) -> Array[Array[Ore]]   # 返した配列の 1 要素が 1 箱",
      "  belt : Array[Ore]    # 1 回に 512 個",
      "  box  : Integer       # 1 箱に詰められる数（いま 3）",
      "Ore = Data.define(:id, :color, :carat, :flaw)",
      "  color : :red | :blue # いま流れてくる色",
      "  carat : 1..9",
      "  flaw  : bool         # 傷物",
      "  polish -> Ore        # 研究「研磨機」のあと。傷を消せる（n 回目は鑑定 n 回）",
      "# color・carat・flaw を 1 回読むと鑑定 1 回。多いほど工場が詰まる",
      "# p belt.first で中身が見えます（鑑定 3 回）",
    ].join("\n"));
  });
  it("研究ゼロの全文: box 1、color は :red だけ、polish の行はない", () => {
    const t = riText(researchEffects([]));
    assert.equal(t, [
      "def pack(belt) -> Array[Array[Ore]]   # 返した配列の 1 要素が 1 箱",
      "  belt : Array[Ore]    # 1 回に 512 個",
      "  box  : Integer       # 1 箱に詰められる数（いま 1）",
      "Ore = Data.define(:id, :color, :carat, :flaw)",
      "  color : :red         # いま流れてくる色",
      "  carat : 1..9",
      "  flaw  : bool         # 傷物",
      "# color・carat・flaw を 1 回読むと鑑定 1 回。多いほど工場が詰まる",
      "# p belt.first で中身が見えます（鑑定 3 回）",
    ].join("\n"));
  });
  it("書き方の例と裏口の技は出さない", () => {
    const t = riText(researchEffects(RESEARCH.map((r) => r.key)));
    assert.doesNotMatch(t, /each_slice|sort_by|Yield|bind_call|ObjectSpace/);
  });
});
