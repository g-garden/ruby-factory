import { NOTEBOOK } from "../../data/balance.js";
import { h, setText, toggle } from "./dom.js";

/**
 * 裏口ノート（SPEC-rubyist 2.2）。6 枠のカード。未発見の枠は「？？？」と謎かけ、見つけた枠は使った Ruby の機能名。
 * 初回デプロイまでは出さない。見つけた瞬間の枠だけめくれる
 */
/**
 * 枠の下の行。見つけた枠の機能名は等幅で長い（instance_variable_get など）ので、_ や . の後ろに <wbr> を入れて
 * そこで折り返す。入れないと 2 列のときに最後の 1 文字だけ次の行に落ちる
 */
function setSub(el, text, code) {
  const key = `${code ? 1 : 0}:${text}`;
  if (el.dataset.text === key) return;
  el.dataset.text = key;
  if (!code) {
    el.textContent = text;
    return;
  }
  const parts = String(text).match(/[^_.]+[_.]?|[_.]/g) ?? [""];
  el.replaceChildren(...parts.flatMap((t, i) => (i ? [h("wbr"), t] : [t])));
}

export function createNotebook(root) {
  const count = h("span", { class: "nb-count" }, "0/6");
  const summary = h("summary", { class: "nb-summary" }, "裏口ノート ", count);
  const grid = h("ol", { class: "nb-pages" });
  const box = h("details", { class: "notebook", id: "notebook", open: true, hidden: true }, summary, grid);
  root.append(box);
  const slots = NOTEBOOK.map((p, i) => {
    const no = h("span", { class: "nb-no" }, String(i + 1));
    const title = h("span", { class: "nb-title" }, "？？？");
    const sub = h("span", { class: "nb-sub" }, p.riddle);
    const li = h("li", { class: "nb-page", dataset: { page: p.key } }, no, title, sub);
    grid.append(li);
    return { p, li, title, sub };
  });
  let seen = null;

  return {
    /** found: 見つけたページの key の配列、features: { key: 機能名 } の上書き（ページ 3 の当てた技） */
    update({ visible, found, features = {} }) {
      box.hidden = !visible;
      if (!visible) return;
      const set = new Set(found);
      setText(count, `${set.size}/${NOTEBOOK.length}`);
      for (const s of slots) {
        const on = set.has(s.p.key);
        toggle(s.li, "found", on);
        setText(s.title, on ? s.p.label : "？？？");
        setSub(s.sub, on ? features[s.p.key] ?? s.p.feature : s.p.riddle, on);
        // 前回の表示より後に見つけた枠だけめくる（読み込み直後は全部めくらない）
        if (on && seen && !seen.has(s.p.key)) {
          s.li.classList.remove("flip");
          void s.li.offsetWidth;
          s.li.classList.add("flip");
          box.open = true;
        }
      }
      seen = set;
    },
  };
}
