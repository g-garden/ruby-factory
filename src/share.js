// X（旧 Twitter）に投稿する文。画面には触らない純粋な関数だけを置く（tests/share.test.mjs で確かめる）
import { formatMoney, formatNumber } from "./economy.js";
import { fmtPerOre } from "./ui/dom.js";

export const SHARE_TITLE = "def pack(belt)";
export const SHARE_TAG = "#def_pack";
/** X の上限。日本語は 1 文字 2、URL は長さによらず 23 と数える */
export const X_LIMIT = 280;
const X_URL_WEIGHT = 23;

/** 投稿に載せるページの URL。?debug などのクエリと # 以降は落とす */
export function pageUrl(loc) {
  return `${loc.origin}${loc.pathname}`;
}

/** クリアタイムの表示。1:05:09 / 12:34 の形 */
export function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

// twitter-text v3 の数え方。この範囲の文字は 1、それ以外（日本語など）は 2
const LIGHT = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];
const URL_RE = /https?:\/\/\S+/g;

/** X の重み付きの文字数 */
export function weightedLength(text) {
  let n = 0;
  const rest = String(text).replace(URL_RE, () => {
    n += X_URL_WEIGHT;
    return "";
  });
  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

/**
 * 投稿する文。クリア後はクリアタイム、それまでは投稿した時点の累計売上を出す。
 * プレイヤーのコードは載せない（state から数字だけを読む）
 * opts = { url, notebookTotal, atClear }。atClear は成績表のカードから投稿するとき true
 */
export function shareText(state, { url, notebookTotal, atClear = false }) {
  const st = state.stats ?? {};
  const cleared = st.clearedAt != null && st.startedAt != null;
  const lines = [];
  if (cleared) {
    lines.push(`${SHARE_TITLE} を ${elapsed(st.clearedAt - st.startedAt)} でクリアしました`);
  } else {
    lines.push(`${SHARE_TITLE} をプレイ中`);
    lines.push(`累計売上 ${formatMoney(state.totalEarned ?? 0)}`);
  }
  // 成績表のカードからは、カードと同じクリアした時点の記録を出す。HUD の「共有」はいまの記録のまま
  const record = cleared && atClear ? (st.recordAtClear ?? state.record) : state.record;
  if (record > 0) lines.push(`最高単価 ${fmtPerOre(record, formatNumber)}/ore`);
  const nb = state.notebook?.length ?? 0;
  if (nb > 0) lines.push(`裏口ノート ${nb}/${notebookTotal}`);
  // URL とハッシュタグは日本語にくっつくと認識されないので、それぞれ行を分ける
  lines.push(url, SHARE_TAG);
  return lines.join("\n");
}

/** X の投稿画面を開く URL */
export function intentUrl(text) {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
