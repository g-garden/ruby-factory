// 小さな DOM ヘルパー。ビルドなしなのでライブラリは使わない

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

/** 値が変わったときだけ書き換える（毎フレーム呼んでもレイアウトを崩さない） */
export function setText(el, text) {
  const s = String(text);
  if (el.textContent !== s) el.textContent = s;
}

export function toggle(el, cls, on) {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

/** 単価表示。$1.0 → $5.0 のように 1,000 未満は小数 1 桁 */
export function fmtPerOre(v, formatNumber) {
  if (!Number.isFinite(v)) return "-";
  if (Math.abs(v) < 1000) return "$" + v.toFixed(1);
  return "$" + formatNumber(v);
}

export function fmtRatio(r) {
  if (r === Infinity) return "∞";
  if (!Number.isFinite(r)) return "-";
  return r >= 100 ? r.toFixed(0) : r.toFixed(2);
}
