import { RESEARCH } from "../../data/balance.js";
import { canResearch, formatMoney, formatShortfall } from "../economy.js";
import { h, setText, toggle } from "./dom.js";

/** Gemfile パネル（研究の一覧）。上から 1 本道で、次の 1 行だけ買える */
export function createGemfile(root, { onBuy, onOpen }) {
  const gemPane = h("div", { class: "pane", dataset: { pane: "gemfile" } });
  /** 裏口ノート（ui/notebook.js）を入れる場所 */
  const notebookRoot = h("div", { class: "notebook-root" });
  root.append(gemPane);
  gemPane.append(h("h2", { class: "panel-title" }, "Gemfile", h("small", {}, "研究すると値付けのルールや素材が増える")));
  const list = h("ol", { class: "gems" });
  gemPane.append(h("div", { class: "gem-file" }, h("div", { class: "gem-comment" }, "# Gemfile"), list), notebookRoot,
    // 同梱している ruby.wasm などのライセンス表記。ゲームを止めないよう別のタブで開く
    h("p", { class: "gem-credits" }, h("a", { href: "./vendor/NOTICES.html", target: "_blank", rel: "noopener" }, "使っているソフトウェア")));
  const rows = RESEARCH.map((r) => {
    const price = h("span", { class: "gem-price" }, formatMoney(r.price));
    const req = h("span", { class: "gem-req" });
    const status = h("span", { class: "gem-status" });
    const tip = h("span", { class: "gem-tip" });
    const btn = h("button", { class: "gem", type: "button", dataset: { research: r.key },
      onclick: () => (btn.classList.contains("done") ? onOpen(r.key) : onBuy(r.key)) },
      h("span", { class: "gem-line" },
        h("span", { class: "kw" }, "gem "), h("span", { class: "str" }, `"${r.gem}"`)),
      h("span", { class: "gem-comment-line" }, "# ", price, " ", r.label, "：", r.summary),
      req,
      tip,
      status,
    );
    const li = h("li", {}, btn);
    list.append(li);
    return { r, btn, req, status, tip, li };
  });
  let lastPending = null;
  let refuseTimer = null;

  return {
    notebookRoot,
    /** 買えなかった行を揺らし、理由をその行に少しのあいだ出す（ログは押した場所から遠いので） */
    refuse(key, reason) {
      const row = rows.find((x) => x.r.key === key);
      if (!row) return;
      for (const x of rows) x.btn.classList.remove("nope");
      void row.btn.offsetWidth;
      row.btn.classList.add("nope");
      row.btn.dataset.why = reason ?? "";
      clearTimeout(refuseTimer);
      refuseTimer = setTimeout(() => {
        row.btn.classList.remove("nope");
        delete row.btn.dataset.why;
      }, 3200);
    },
    /** pending: 買ったのにまだコードに取り入れていない研究の key（その行の tip を出し続ける） */
    update(state, { pending = null } = {}) {
      const done = new Set(state.research);
      let nextSeen = false;
      for (const row of rows) {
        const isDone = done.has(row.r.key);
        const isNext = !isDone && !nextSeen;
        if (isNext) nextSeen = true;
        const isPending = isDone && row.r.key === pending;
        const chk = isNext ? canResearch(state, row.r.key) : null;
        toggle(row.btn, "done", isDone);
        toggle(row.btn, "next", isNext);
        toggle(row.btn, "afford", !!chk?.ok);
        toggle(row.btn, "locked", !isDone && !isNext);
        toggle(row.btn, "todo", isPending);
        const needRecord = row.r.requires?.record;
        const unmet = !isDone && needRecord != null && (state.record ?? 0) < needRecord;
        const note = isNext && row.r.requires?.note ? `。${row.r.requires.note}` : "";
        setText(row.req, unmet ? `# requires: 単価記録 ${formatMoney(needRecord)}、あと ${formatShortfall(needRecord, state.record)}${note}` : "");
        toggle(row.btn, "unmet", unmet);
        // 買ったのにまだ書いていない研究があれば、その「次の 1 行」を優先する。
        // 次に買う研究の tip は、買う前から何が書けるようになるかを出す（SPEC 3.1）
        const tipText = isPending ? `→ 次の 1 行: ${row.r.hint.tip}`
          : isNext && !pending && row.r.hint?.tip ? `→ ${row.r.hint.tip}` : "";
        setText(row.tip, tipText);
        // お金は足りているのに単価記録だけが足りないときは、止まっている理由を行に出す（下の requires 行が書くコード）
        const recordOnly = unmet && chk?.missing === "record" && state.money >= row.r.price;
        setText(row.status, isDone ? (isPending ? "Installed・未使用" : "Installed") : chk?.ok ? "bundle install" : recordOnly ? "単価記録待ち" : "");
      }
      // 待っている研究が変わったら、その行が見える位置までパネルをずらす（パネル内だけ）
      if (pending !== lastPending) {
        lastPending = pending;
        const row = rows.find((x) => x.r.key === pending);
        if (row && root.scrollHeight > root.clientHeight && row.li.getBoundingClientRect && root.getBoundingClientRect) {
          const top = row.li.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
          if (top < root.scrollTop || top > root.scrollTop + root.clientHeight - 60) root.scrollTop = Math.max(0, top - 40);
        }
      }
    },
  };
}
