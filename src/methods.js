// stdlib なし版の ruby.wasm には Prism も Ripper.lex もないので、字句の扱いは JS で済ませる

export const ICON_METHODS = [
  "map", "filter_map", "flat_map", "select", "filter", "reject", "partition",
  "sort", "sort_by", "min_by", "max_by", "group_by", "values", "tally",
  "each_slice", "each_cons", "chunk_while", "slice_when", "chunk",
  "zip", "reverse", "uniq", "take", "drop", "first", "last", "pop", "shift",
  "concat", "flatten", "sum", "count", "each", "each_with_object", "inject", "reduce",
  "polish",
];

const ICON_SET = new Set(ICON_METHODS);

/** コメント・文字列リテラル・文字リテラルを空白に置き換える（改行は残す） */
export function stripCommentsAndStrings(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  const atLineStart = (j) => j === 0 || code[j - 1] === "\n";
  while (i < n) {
    const ch = code[i];
    if (atLineStart(i) && code.startsWith("=begin", i)) {
      const end = code.indexOf("\n=end", i);
      const stop = end < 0 ? n : code.indexOf("\n", end + 1) < 0 ? n : code.indexOf("\n", end + 1);
      out += code.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (ch === "#") {
      while (i < n && code[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      out += " ";
      i++;
      while (i < n && code[i] !== ch) {
        if (code[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
          continue;
        }
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }
    // ?a のような文字リテラル（三項演算子の ? とは前後で見分ける）
    if (ch === "?" && i + 1 < n && /\S/.test(code[i + 1]) && (i === 0 || /[\s(,=]/.test(code[i - 1])) && (i + 2 >= n || /[\s),.\]]/.test(code[i + 2]))) {
      out += "  ";
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 10.6: コードに出てくるメソッド名を出現順・重複なしで返す。既定では機械アイコンがあるものだけ */
export function extractMethods(code, { all = false } = {}) {
  const src = stripCommentsAndStrings(code ?? "");
  const seen = new Set();
  const out = [];
  for (const m of src.matchAll(/(?:\.|&:)([A-Za-z_]\w*[?!]?)/g)) {
    const name = m[1];
    if (seen.has(name)) continue;
    if (!all && !ICON_SET.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// did_you_mean の代わり。Enumerable / Array / Hash / Data / Kernel とゲーム独自のメソッド
const KNOWN = [
  // Enumerable
  "all?", "any?", "chain", "chunk", "chunk_while", "collect", "collect_concat", "compact", "count", "cycle",
  "detect", "drop", "drop_while", "each_cons", "each_entry", "each_slice", "each_with_index", "each_with_object",
  "entries", "filter", "filter_map", "find", "find_all", "find_index", "first", "flat_map", "grep", "grep_v",
  "group_by", "include?", "inject", "lazy", "map", "max", "max_by", "member?", "min", "min_by", "minmax",
  "minmax_by", "none?", "one?", "partition", "reduce", "reject", "reverse_each", "select", "slice_after",
  "slice_before", "slice_when", "sort", "sort_by", "sum", "take", "take_while", "tally", "to_a", "to_h",
  "to_set", "uniq", "zip",
  // Array
  "append", "assoc", "at", "bsearch", "clear", "combination", "concat", "delete", "delete_at", "delete_if",
  "difference", "dig", "each", "each_index", "empty?", "fetch", "fill", "flatten", "index", "insert",
  "intersection", "join", "keep_if", "last", "length", "pack", "permutation", "pop", "prepend", "product",
  "push", "rassoc", "repeated_combination", "rindex", "rotate", "sample", "shift", "shuffle", "size", "slice",
  "sort!", "sum", "transpose", "union", "unshift", "values_at", "map!", "select!", "reject!", "uniq!",
  "compact!", "flatten!", "reverse", "reverse!",
  // Hash
  "each_pair", "each_key", "each_value", "fetch_values", "filter_map", "key", "key?", "keys", "merge",
  "transform_keys", "transform_values", "value?", "values", "sort_by", "to_a", "group_by",
  // Data / Object
  "with", "inspect", "to_s", "deconstruct_keys", "then", "tap", "frozen?", "dup", "is_a?", "nil?",
  "respond_to?", "send", "public_send", "itself",
  // Kernel
  "puts", "print", "p", "loop", "lambda", "proc", "raise", "rand", "format", "sprintf", "Array", "Integer",
  // Integer / Range
  "times", "upto", "downto", "step", "succ", "pred", "even?", "odd?", "zero?", "abs", "clamp", "between?",
  "divmod", "floor", "ceil", "round", "to_i", "to_f", "begin", "end",
  // ゲーム
  "box", "pack", "polish", "carat", "color", "flaw", "id", "straights",
];
const KNOWN_SET = new Set(KNOWN);

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let prev2 = null;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // 隣り合う 2 文字の入れ替え（slect / selcet の類）を 1 とみなす
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** 既知のメソッドと編集距離 2 以内で一番近いものを返す。完全一致や候補なしは null */
export function didYouMean(name) {
  if (!name || KNOWN_SET.has(name)) return null;
  const limit = name.length <= 3 ? 1 : 2;
  let best = null;
  let bestD = limit + 1;
  for (const cand of KNOWN) {
    const d = editDistance(name, cand);
    if (d < bestD) {
      best = cand;
      bestD = d;
    }
  }
  return best;
}

// 日本語 IME のまま打つと混ざりやすい全角の記号。Ruby では識別子の一部になり、エラー文で見分けにくい
const FULLWIDTH = [
  [/\u3000/, "全角スペース"],
  [/[（）]/, "全角の括弧「（）」"],
  [/[［］｛｝]/, "全角の括弧「［］｛｝」"],
  [/[．，：；＝＋－＊／＆｜！？＜＞]/, "全角の記号"],
];

/**
 * コメントと文字列を除いたコードに全角の記号があれば、どこにあるかを日本語で返す。なければ null。
 * message を渡したときは、エラー文にも全角の記号が出ているときだけ探す（関係ないエラーで did_you_mean を隠さないため）
 */
export function fullwidthHint(code, message = null) {
  if (message != null && !FULLWIDTH.some(([re]) => re.test(message))) return null;
  const lines = stripCommentsAndStrings(code ?? "").split("\n");
  for (const [re, name] of FULLWIDTH) {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return `pack.rb:${i + 1} に${name}が入っています。半角に直してください`;
  }
  return null;
}

/** NoMethodError / NameError のメッセージから候補を出す。例: "undefined method 'slect' for an instance of Array" */
export function suggestFromError(message) {
  const m = /undefined (?:local variable or )?method [`']([^`']+)'/.exec(message ?? "");
  if (!m) return null;
  return didYouMean(m[1]);
}

/**
 * 買ったのにまだコードに取り入れていない研究（hint.uses のどれもデプロイ中のコードにない）。
 * あとの研究の書き方を使っていれば前の研究も済んだとみなす（研磨のコードは reject を使わない、など）。
 * research は買った順の key、defs は RESEARCH。なければ null
 */
export function unappliedResearch(research, code, defs, { shows = () => false } = {}) {
  const used = new Set(extractMethods(code ?? "", { all: true }));
  const bought = defs.filter((d) => research.includes(d.key) && d.hint?.uses?.length);
  // shows(def): 出荷した箱にその研究の効果が出ているか（find_all や自前の詰め方など、字句で拾えない書き方の救済）
  const applied = (d) => d.hint.uses.some((m) => used.has(m)) || shows(d);
  let from = 0;
  bought.forEach((d, i) => {
    if (d.hint.uses.some((m) => used.has(m))) from = i + 1;
  });
  return bought.slice(from).find((d) => !applied(d)) ?? null;
}
