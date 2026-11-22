// 工場の上に出す吹き出し（callout.js）の順番待ち。DOM を触らないので node --test でそのまま試せる

/** 読み終わるまでの表示時間（ミリ秒）。日本語は 1 秒に 8〜9 文字くらいで読む想定 */
export function readMs(text, { base = 2200, perChar = 115, min = 4000, max = 12_000 } = {}) {
  const n = [...String(text ?? "")].length;
  return Math.round(Math.min(max, Math.max(min, base + n * perChar)));
}

/**
 * 研究の tip（「3 個ずつ詰めよう: each_slice」の形）を、吹き出しで読む 1 文にする（「each_slice で 3 個ずつ詰めよう」）。
 * 前半に文が 2 つ以上あるもの・メソッド名で終わらないものはそのまま返す
 */
export function tipSentence(tip) {
  const s = String(tip ?? "").trim();
  const m = s.match(/^([^:。]+):\s*([\w./ ?!]+)$/);
  return m ? `${m[2].trim()} で ${m[1].trim()}` : s;
}

/**
 * 吹き出しの順番待ち。1 度に出すのは 1 つだけ。
 * - 同じ key（なければ同じ文）は dedupeMs のあいだ出し直さない
 * - group が同じものは新しい方だけ残す（はじめの案内のように、すぐ古くなるもの）。いま出ているものも差し替える
 * - urgent は列の先頭に入れる（詰まりの注意など）。いま出ているものが urgent でなければ、それを列の先頭に戻して割り込む
 * - 列は max 件まで。あふれたら古いものから捨てる
 * item = { text, key?, group?, urgent?, ...好きな値 }
 */
export function createNoticeQueue({ max = 3, dedupeMs = 30_000, now = () => Date.now() } = {}) {
  let current = null;
  let queue = [];
  const seen = new Map();
  const keyOf = (item) => item.key ?? item.text;

  function trim() {
    while (queue.length > max) {
      // urgent でない古いものから捨てる。全部 urgent なら一番古いもの
      const i = queue.findIndex((q) => !q.urgent);
      queue.splice(i < 0 ? 0 : i, 1);
    }
  }

  return {
    get current() { return current; },
    get size() { return queue.length; },
    get items() { return [...queue]; },

    /**
     * 戻り値: "dup"（出さない）・"queued"（列に入れた）・
     * "replace"（いま出ているものと差し替えた。呼び出し側ですぐ出し直す）・"preempt"（割り込んだ。同じくすぐ出し直す）
     */
    push(item) {
      const k = keyOf(item);
      const t = now();
      const last = seen.get(k);
      if (last != null && t - last < dedupeMs) return "dup";
      if ((current && keyOf(current) === k) || queue.some((q) => keyOf(q) === k)) return "dup";
      seen.set(k, t);
      if (item.group) queue = queue.filter((q) => q.group !== item.group);
      if (item.group && current?.group === item.group) {
        current = item;
        return "replace";
      }
      if (item.urgent && current && !current.urgent) {
        queue.unshift(current);
        current = item;
        trim();
        return "preempt";
      }
      if (item.urgent) {
        // 先に来た urgent の後ろに並べる
        const i = queue.findIndex((q) => !q.urgent);
        queue.splice(i < 0 ? queue.length : i, 0, item);
      } else queue.push(item);
      trim();
      return "queued";
    },

    /** 次に出すものを取り出して current にする。いま出ているものがあれば null */
    next() {
      if (current || queue.length === 0) return null;
      current = queue.shift();
      return current;
    },

    /** いま出ているものを下げる */
    done() {
      current = null;
    },

    clear() {
      current = null;
      queue = [];
    },
  };
}
