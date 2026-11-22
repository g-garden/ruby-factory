// エディタの「ri 早見表」に出す文。画面には触らない純粋な関数だけを置く（tests/ri.test.mjs で確かめる）
import { BATCH_SIZE, CARAT_MAX } from "../data/balance.js";

/** 型の行のコメント（#）をそろえる桁 */
const COMMENT_COL = 23;

/** body のあとにスペースを足して # をそろえる。body が長いときはスペース 1 つ */
function withComment(body, comment) {
  return `${body.padEnd(COMMENT_COL - 1)} # ${comment}`;
}

/** researchEffects の結果から早見表の文を作る。型と数だけで、書き方は出さない */
export function riText({ box, colors, polish }) {
  const lines = [
    "def pack(belt) -> Array[Array[Ore]]   # 返した配列の 1 要素が 1 箱",
    withComment("  belt : Array[Ore]", `1 回に ${BATCH_SIZE} 個`),
    withComment("  box  : Integer", `1 箱に詰められる数（いま ${box}）`),
    "Ore = Data.define(:id, :color, :carat, :flaw)",
    withComment(`  color : ${colors.map((c) => ":" + c).join(" | ")}`, "いま流れてくる色"),
    `  carat : 1..${CARAT_MAX}`,
    withComment("  flaw  : bool", "傷物"),
  ];
  if (polish) lines.push(withComment("  polish -> Ore", "研究「研磨機」のあと。傷を消せる（n 回目は鑑定 n 回）"));
  lines.push(
    "# color・carat・flaw を 1 回読むと鑑定 1 回。多いほど工場が詰まる",
    "# p belt.first で中身が見えます（鑑定 3 回）",
  );
  return lines.join("\n");
}
