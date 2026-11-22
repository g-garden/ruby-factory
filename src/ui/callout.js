import { h } from "./dom.js";
import { createNoticeQueue, readMs } from "./notice-queue.js";

/** 1 つ下げてから次を出すまでの間（続けて出ると、変わったことに気づきにくい） */
const GAP_MS = 350;
/** 列に入れてから最初に出すまでの間。デプロイの帯や判子と同時に出さない */
const FIRST_DELAY_MS = 300;
const OUT_MS = 220;
const TICK_MS = 100;

/**
 * 工場の上に出す吹き出し。プレイヤーは動いている工場を見ているので、
 * ログ欄に出した案内のうち、やることや見落とすと困るものだけをここにも出す。
 * 読み上げはログ欄（role=log）に任せるので、ここには live 領域を置かない。
 *
 * root は工場の section（position: relative）。opts:
 * - held() が true のあいだは時間を進めず、次も出さない（研究カードを開いているときなど）。工場が画面の外にあるときも同じ
 * - onClose(item, how) 下げたとき。how は "timeout"（最後まで出した）・"close"（本文を押した）・"log"（ログへ）・"action"（横のボタン）・"escape"
 * - onDrop(item) 同じ group の新しい案内に差し替えられて、出さずに下げたとき（もう古い案内）
 * - onLog(item) 「ログ」を押したとき
 * - focusAway() 吹き出しにフォーカスがあるまま消すときの、次のフォーカス先
 * - compact() が true のとき（スマホ）は、item.sp があればそちらの文を出す
 */
export function createCallout(root, { held = () => false, compact = () => false, onClose = () => {}, onDrop = () => {}, onLog = () => {}, focusAway = () => {} } = {}) {
  const queue = createNoticeQueue();
  const kicker = h("span", { class: "callout-kicker" });
  const text = h("span", { class: "callout-text" });
  // 本文を押すと閉じる
  const body = h("button", { class: "callout-body", type: "button", title: "閉じる" }, kicker, text);
  const more = h("span", { class: "callout-more" });
  const act = h("button", { class: "callout-act", type: "button", hidden: true });
  const toLog = h("button", { class: "callout-log", type: "button", title: "ログのこの行を見る" }, "ログ", h("span", { "aria-hidden": "true" }, " ›"));
  const acts = h("span", { class: "callout-acts" }, act, toLog, more);
  const bar = h("i", { class: "callout-time", "aria-hidden": "true" });
  const bubble = h("div", { class: "callout", hidden: true }, body, acts, bar);
  const layer = h("div", { class: "callout-layer" }, bubble);
  root.append(layer);

  let remaining = 0;
  let hover = false;
  let focused = false;
  let timer = null;
  let waitTimer = null;
  let outTimer = null;
  // 工場が画面に入っているか（スマホの横向きはページごとスクロールするので、上の工場が見えなくなる）
  let inView = true;
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver((entries) => {
      const e = entries.at(-1);
      inView = !!e?.isIntersecting && e.intersectionRatio >= 0.5;
    }, { threshold: [0, 0.5, 1] }).observe(root);
  }
  const paused = () => document.hidden || !inView || held();

  // マウスを乗せているあいだは止める。タッチでは pointerleave が来ないことがあるので、マウスだけにする
  bubble.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") hover = true; });
  bubble.addEventListener("pointerleave", () => { hover = false; });
  bubble.addEventListener("focusin", () => { focused = true; });
  bubble.addEventListener("focusout", (e) => { if (!bubble.contains(e.relatedTarget)) focused = false; });
  bubble.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close("escape");
    }
  });
  // フォーカスを移すのはキーボードで閉じたときだけ（指やマウスで押したときに、別の場所に枠が出ないように）
  body.addEventListener("click", (e) => close("close", { keepFocus: e.detail !== 0 }));
  toLog.addEventListener("click", () => {
    const item = queue.current;
    close("log", { keepFocus: true });
    if (item) onLog(item);
  });
  act.addEventListener("click", (e) => {
    const item = queue.current;
    close("action", { keepFocus: e.detail !== 0 });
    item?.action?.run();
  });

  function render(item) {
    clearTimeout(outTimer);
    bubble.className = `callout k-${item.kind ?? "guide"}`;
    kicker.textContent = item.kicker ?? "";
    kicker.hidden = !item.kicker;
    const words = (compact() && item.sp) || item.text;
    text.textContent = words;
    const a = item.action && (item.action.show?.() ?? true) ? item.action : null;
    act.hidden = !a;
    act.textContent = a?.label ?? "";
    const total = item.ms ?? readMs(words);
    remaining = total;
    bubble.style.setProperty("--dur", `${total}ms`);
    // アニメーションを最初からやり直す
    bubble.hidden = false;
    bar.style.animation = "none";
    void bar.offsetWidth;
    bar.style.animation = "";
    updateMore();
    requestAnimationFrame(() => bubble.classList.add("in"));
    clearInterval(timer);
    timer = setInterval(step, TICK_MS);
  }

  function updateMore() {
    more.textContent = queue.size > 0 ? `ほか ${queue.size}` : "";
  }

  function step() {
    const stop = hover || focused || paused();
    bubble.classList.toggle("held", stop);
    if (stop) return;
    remaining -= TICK_MS;
    if (remaining <= 0) close("timeout");
  }

  function close(how, { keepFocus = false } = {}) {
    clearInterval(timer);
    timer = null;
    const item = queue.current;
    if (!item) return;
    queue.done();
    // フォーカスが吹き出しの中にあるまま消すと body に落ちるので、先に移す
    if (!keepFocus && bubble.contains(document.activeElement)) focusAway(item);
    hover = false;
    focused = false;
    bubble.classList.remove("in", "held");
    bubble.classList.add("out");
    // transitionend は待たない（動きを減らす設定だと来ないことがある）
    clearTimeout(outTimer);
    outTimer = setTimeout(() => {
      bubble.hidden = true;
      bubble.classList.remove("out");
    }, OUT_MS);
    onClose(item, how);
    schedule(GAP_MS);
  }

  function schedule(ms) {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => {
      // カードを開いている・工場が見えていないあいだは出さずに待つ（見ていないところで時間切れにならないように）
      if (paused()) {
        schedule(500);
        return;
      }
      const item = queue.next();
      if (item) render(item);
    }, ms);
  }

  return {
    /**
     * item = { text, sp?, kicker?, kind?, key?, group?, urgent?, ms?, el?, action? }。sp はスマホで出す短い文
     * kind は guide・goal・warn・audit・notebook。action = { label, run, show? } は本文の横に出すボタン
     */
    push(item) {
      if (!item?.text) return;
      const stale = item.group ? [queue.current, ...queue.items].filter((q) => q && q.group === item.group) : [];
      const r = queue.push(item);
      if (r !== "dup") for (const q of stale) onDrop(q);
      // 差し替え・割り込みはすぐ出し直す（止まっている間に来たら、止まったまま中身だけ変わる）
      if (r === "replace" || r === "preempt") render(queue.current);
      else if (r === "queued") {
        if (queue.current) updateMore();
        else schedule(FIRST_DELAY_MS);
      }
    },
    close: () => close("close"),
    clear() {
      queue.clear();
      clearInterval(timer);
      clearTimeout(waitTimer);
      bubble.hidden = true;
    },
    get current() { return queue.current; },
  };
}
