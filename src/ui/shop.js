import { BELTS, CPUS, DOCKS, MINES } from "../../data/balance.js";
import { STAGE_LABEL, STAGES, derive, formatMoney, formatNumber, priceOf } from "../economy.js";
import { h, setText, toggle } from "./dom.js";

const GROUPS = [
  { stage: "mine", kind: "mine", list: MINES, field: "mines", unit: "個/秒" },
  { stage: "belt", kind: "belt" },
  { stage: "refinery", kind: "cpu", list: CPUS, field: "cpus", unit: "鑑定/秒" },
  { stage: "dock", kind: "dock", list: DOCKS, field: "docks", unit: "箱/秒" },
];

/** 次の研究まであと何秒か（収入がいまのままなら）。単価記録が足りないときはそれを言う */
function nextResearchEta(state, fi) {
  const next = derive(state).nextResearch;
  if (!next) return "あとは単価を上げると収入が伸びます";
  if (next.requires?.record != null && (state.record ?? 0) < next.requires.record) return `次の研究「${next.label}」は単価記録待ちです`;
  const left = next.price - state.money;
  if (left <= 0) return `次の研究「${next.label}」を買えます`;
  const income = fi.incomePerSec ?? 0;
  return income > 0 ? `次の研究「${next.label}」まで約 ${Math.ceil(left / income)} 秒` : `次の研究「${next.label}」まで ${formatMoney(left)}`;
}

/** ショップ: 工程ごとの段。いま赤い工程の段を先頭に出す */
export function createShop(root, { onBuy, onDiagnose }) {
  root.append(h("h2", { class: "panel-title" }, "ショップ", h("small", {}, "詰まっている工程に設備を足す")));
  const box = h("div", { class: "shop-groups" });
  root.append(box);
  const groups = {};

  for (const g of GROUPS) {
    const cap = h("span", { class: "shop-cap" });
    const util = h("i", {});
    const head = h("button", { class: "shop-head", type: "button", onclick: () => onDiagnose(g.stage), title: "診断カードを開く" },
      h("span", { class: "shop-stage" }, STAGE_LABEL[g.stage]),
      h("span", { class: "shop-bn" }, "BOTTLENECK"),
      cap,
      h("span", { class: "shop-util" }, util),
    );
    const rows = h("div", { class: "shop-rows" });
    const el = h("section", { class: "shop-group", dataset: { stage: g.stage } }, head, rows);
    box.append(el);
    const items = [];
    if (g.kind === "belt") {
      const name = h("span", { class: "item-name" });
      const meta = h("span", { class: "item-meta" });
      const cost = h("span", { class: "item-cost" });
      const btn = h("button", { class: "item", type: "button", dataset: { buy: "belt:next" }, onclick: () => onBuy("belt", null) },
        h("span", { class: "item-main" }, name, meta), cost);
      rows.append(btn);
      items.push({ btn, name, meta, cost });
    } else {
      for (const it of g.list) {
        const name = h("span", { class: "item-name" }, it.label);
        const owned = h("span", { class: "item-owned" });
        const meta = h("span", { class: "item-meta" }, `+${formatNumber(it.rate)} ${g.unit}`);
        const cost = h("span", { class: "item-cost" });
        const btn = h("button", { class: "item", type: "button", dataset: { buy: `${g.kind}:${it.key}` }, onclick: () => onBuy(g.kind, it.key) },
          h("span", { class: "item-main" }, h("span", {}, name, owned), meta), cost);
        rows.append(btn);
        items.push({ btn, name, owned, meta, cost, key: it.key });
      }
    }
    groups[g.stage] = { g, el, cap, util, items };
  }

  return {
    update(state, fi) {
      const order = [fi.passthrough ? null : fi.bottleneck, ...STAGES].filter((s, i, a) => s && a.indexOf(s) === i);
      for (const g of GROUPS) {
        const G = groups[g.stage];
        const hot = !fi.passthrough && fi.bottleneck === g.stage;
        G.el.style.order = String(order.indexOf(g.stage));
        toggle(G.el, "hot", hot);
        const c = fi.caps[g.stage];
        setText(G.cap, c === Infinity ? "∞" : `${formatNumber(c)}/s`);
        G.util.style.width = `${Math.round((fi.util[g.stage] ?? 0) * 100)}%`;

        if (g.kind === "belt") {
          const it = G.items[0];
          const cur = BELTS[state.belt ?? 0];
          const next = BELTS[(state.belt ?? 0) + 1];
          if (next) {
            setText(it.name, `${next.label}ベルトに交換`);
            setText(it.meta, `${formatNumber(cur.cap)} → ${formatNumber(next.cap)} 個/秒`);
            setText(it.cost, formatMoney(next.price));
            toggle(it.btn, "afford", state.money >= next.price);
            toggle(it.btn, "maxed", false);
            it.btn.disabled = false;
          } else {
            setText(it.name, `${cur.label}ベルト・最終段階`);
            // 最終段のベルトが赤いときは買えるものがないので、次の研究までの目安を出す（判子だけ残って手が止まらないように）
            setText(it.meta, hot ? `${formatNumber(cur.cap)} 個/秒。これ以上は広げられません。${nextResearchEta(state, fi)}` : `${formatNumber(cur.cap)} 個/秒`);
            setText(it.cost, "-");
            toggle(it.btn, "afford", false);
            toggle(it.btn, "maxed", hot); // 案内を読めるよう、赤いときは薄くしない
            it.btn.disabled = true;
          }
          continue;
        }
        // 持っている設備と、その次の 1 台だけ見せる（先の楽しみを残す）
        let lastOwned = -1;
        g.list.forEach((x, i) => {
          if ((state[g.field][x.key] ?? 0) > 0) lastOwned = i;
        });
        G.items.forEach((it, i) => {
          const owned = state[g.field][it.key] ?? 0;
          const visible = i <= lastOwned + 1;
          it.btn.hidden = !visible;
          if (!visible) return;
          const price = priceOf(state, g.kind, it.key);
          setText(it.owned, owned > 0 ? ` ×${owned}` : "");
          setText(it.cost, formatMoney(price));
          toggle(it.btn, "afford", state.money >= price);
        });
      }
    },
  };
}
