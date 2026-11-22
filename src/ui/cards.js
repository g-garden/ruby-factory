import { STAGE_LABEL, formatMoney } from "../economy.js";
import { h, setText, toggle } from "./dom.js";

const AFTER_CLOSE_MS = 250;
const pct = (p) => (p === Infinity ? "+∞%" : `${p >= 0 ? "+" : ""}${Math.round(p)}%`);

/** 画面に重ねるカード（診断カード・研究カード・エンディング）。ゲームは止めない */
export function createCards(root) {
  const layer = h("div", { class: "overlay", id: "overlay", hidden: true, onclick: (e) => e.target === layer && close() });
  root.append(layer);
  let current = null;
  let refresh = null;
  // カードを閉じたあとに出す見せ場（研究の直後の判子や帯）。カードの暗い幕の裏で出して終わらないように待たせる
  let waiting = [];

  function open(kind, card, onRefresh = null) {
    current = kind;
    refresh = onRefresh;
    layer.hidden = false;
    layer.dataset.kind = kind;
    layer.replaceChildren(card);
    requestAnimationFrame(() => card.classList.add("in"));
  }
  function close() {
    current = null;
    refresh = null;
    layer.hidden = true;
    layer.replaceChildren();
    const fns = waiting;
    waiting = [];
    // 幕が消えたのが目に入ってから出す
    for (const fn of fns) setTimeout(fn, AFTER_CLOSE_MS);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current) close();
  });
  const closeBtn = () => h("button", { class: "card-close", type: "button", "aria-label": "閉じる", onclick: close }, "×");

  return {
    get open() { return current; },
    close,
    /** カードが開いていなければすぐ、開いていれば閉じたあとに fn を呼ぶ */
    afterClose(fn) {
      if (current) waiting.push(fn);
      else fn();
    },
    /** 待たせている見せ場を捨てる（デプロイで工場の中身が変わったとき） */
    dropAfterClose() {
      waiting = [];
    },
    tick() {
      refresh?.();
    },

    /** 8.3 診断カード */
    diagnose(stage, getDiag, { onBuy }) {
      const title = h("h3", {});
      const lines = h("div", { class: "diag-lines" });
      const money = h("div", { class: "diag-opts" });
      const code = h("div", { class: "diag-code" });
      const card = h("div", { class: "card diag", dataset: { stage } }, closeBtn(),
        h("div", { class: "card-kicker" }, "診断カード"), title, lines,
        h("div", { class: "diag-sec" }, "お金で直す"), money,
        h("div", { class: "diag-sec" }, "コードで直す"), code);
      let key = "";
      const render = () => {
        const d = getDiag();
        setText(title, d.title);
        const k = JSON.stringify([d.lines, d.money.map((m) => [m.key, m.cost, Math.round(m.incomeGainPct), m.movesBottleneckTo]), d.code]);
        if (k !== key) {
          key = k;
          lines.replaceChildren(...d.lines.map((l) => h("div", {}, l)));
          money.replaceChildren(...d.money.map((m) => h("button", {
            class: "diag-opt", type: "button", dataset: { kind: m.kind, key: String(m.key) },
            onclick: () => onBuy(m.kind, m.kind === "belt" ? null : m.key),
          },
          h("span", { class: "opt-name" }, m.label),
          h("span", { class: "opt-cost" }, formatMoney(m.cost)),
          h("span", { class: "opt-gain" }, `→ 収入 ${pct(m.incomeGainPct)}`,
            m.movesBottleneckTo ? h("small", {}, `、ボトルネックは${STAGE_LABEL[m.movesBottleneckTo]}に移ります`) : null))));
          const rows = [];
          if (d.code.opsMinusOneGainPct != null) rows.push(h("div", { class: "diag-row" }, `1 鉱石あたりの鑑定を 1 回減らせたら → 収入 ${pct(d.code.opsMinusOneGainPct)}`));
          // 監査ライン（SPEC-rubyist 2.3）。正攻法で鑑定を削るときの目標にもなる
          if (d.code.auditLine) rows.push(h("div", { class: "diag-row audit-line" }, d.code.auditLine));
          if (d.code.cratesGainPct != null) rows.push(h("div", { class: "diag-row" }, `箱を box 個ずつ詰めたら → 収入 ${pct(d.code.cratesGainPct)}`));
          if (d.code.hint) rows.push(h("div", { class: "diag-hint" }, "ヒント: ", d.code.hint));
          if (rows.length === 0) rows.push(h("div", { class: "diag-row dim" }, stage === "mine" || stage === "belt" ? "この工程はお金で広げます" : "工場が動き出すと試算が出ます"));
          code.replaceChildren(...rows);
        }
        for (const b of money.querySelectorAll(".diag-opt")) {
          const m = d.money.find((x) => String(x.key) === b.dataset.key);
          toggle(b, "afford", !!m && d.moneyNow >= m.cost);
        }
      };
      render();
      open("diagnose", card, render);
    },

    /** 研究カード（説明＋ヒント 3 段）。probe があれば本物のエラー文をタイプライターで出す */
    research(def, { onInsert, probe }) {
      const hint = def.hint ?? {};
      const steps = h("div", { class: "hint-steps" });
      const body = [];
      if (hint.tip) body.push(h("p", { class: "card-tip" }, hint.tip));
      // tip はバナーや次の 1 行にも出すので短くしている。長めの一言はカードにだけ出す
      if (hint.lesson) body.push(h("p", { class: "card-lesson" }, hint.lesson));
      if (hint.methods?.length) body.push(h("div", { class: "chips" }, hint.methods.map((m) => h("code", { class: "chip" }, m))));
      if (hint.example) body.push(h("pre", { class: "card-code" }, hint.example));
      const probeEl = def.effect.rubyProbe ? h("pre", { class: "card-code probe" }, `irb> ${def.effect.rubyProbe}\n`) : null;
      const card = h("div", { class: "card research flip" }, closeBtn(),
        h("div", { class: "card-kicker" }, `gem "${def.gem}" ${def.version ?? ""}`),
        h("h3", {}, def.label),
        h("p", { class: "card-summary" }, def.summary),
        body, probeEl, steps);
      if (hint.skeleton) {
        const sk = h("pre", { class: "card-code", hidden: true }, hint.skeleton);
        steps.append(h("button", { class: "btn small", type: "button", onclick: (e) => { sk.hidden = false; e.currentTarget.remove(); } }, "ヒント 2: 雛形を見る"), sk);
      }
      if (hint.solution) {
        const sol = h("div", { hidden: true },
          h("pre", { class: "card-code" }, hint.solution),
          h("button", { class: "btn small", type: "button", onclick: () => { onInsert(hint.solution); close(); } }, "エディタに入れる"));
        steps.append(h("button", { class: "btn small ghost", type: "button", onclick: (e) => { sol.hidden = false; e.currentTarget.remove(); } }, "ヒント 3: 完成コード"), sol);
      }
      open("research", card);
      if (probe && probeEl) {
        probe.then((r) => {
          if (current !== "research") return;
          const text = r.ok ? `=> ${r.value}` : `${r.errClass}: ${r.message}`;
          typeInto(probeEl, text + "\n\n" + (def.probeNote ?? ""));
        });
      }
    },

    /** 任意のカード。閉じるボタンを足して開く */
    show(kind, card) {
      card.prepend(closeBtn());
      open(kind, card);
      return card;
    },

    /** 7.2 エンディング（リリースノート風の成績表） */
    ending({ heading, rows, text, onCopy, onShare }) {
      const copied = h("span", { class: "copied" });
      const card = h("div", { class: "card ending" }, closeBtn(),
        h("div", { class: "card-kicker" }, "Release Notes 12/25"),
        h("h3", { class: "ending-head" }, heading),
        h("table", { class: "ending-table" }, h("tbody", {}, rows.map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v))))),
        h("div", { class: "card-actions" },
          h("button", { class: "btn btn-deploy", type: "button", onclick: async () => setText(copied, (await onCopy(text)) ? "コピーしました" : "コピーできませんでした") }, "成績表をコピー"),
          onShare ? h("button", { class: "btn btn-share", type: "button", onclick: () => onShare() }, "X で共有") : null,
          h("button", { class: "btn", type: "button", onclick: close }, "工場に戻って続ける"),
          copied));
      open("ending", card);
    },
  };
}

function typeInto(el, text) {
  const base = el.textContent;
  const chars = [...text];
  let i = 0;
  const t = setInterval(() => {
    i = Math.min(chars.length, i + 1);
    el.textContent = base + chars.slice(0, i).join("");
    if (i >= chars.length) clearInterval(t);
  }, 30);
}
