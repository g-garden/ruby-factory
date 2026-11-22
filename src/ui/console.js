import { formatNumber } from "../economy.js";
import { fmtPerOre, fmtRatio, h, setText } from "./dom.js";

const MAX_LINES = 160;
/** puts / p の出力を 1 回に出す行数 */
const OUTPUT_MAX = 30;
// バナーは出した時点の単価なので、研究で単価が動いたあとまで残すと HUD と食い違う。しばらくしたら引っ込める
const BANNER_MS = 25_000;

/** ベンチ／ログ欄: 倍率バナー、故障票、puts の出力 */
export function createConsole(root) {
  const banner = h("div", { class: "banner", id: "banner", hidden: true });
  const ticket = h("div", { class: "ticket", id: "ticket", hidden: true });
  const log = h("div", { class: "log", id: "log", role: "log", "aria-live": "polite" });
  // ログが画面の外にあるあいだに届いた案内の数。見出しの横に出す（#log の中には文字を足さない）
  const unread = h("button", { class: "console-new", type: "button", hidden: true, onclick: () => jumpToUnseen() });
  root.append(h("div", { class: "console-head" }, h("span", {}, "bench / log"), unread), banner, ticket, log);

  let typing = null;
  let finishTyping = null;
  let bannerTimer = null;
  // 最初はまだ IntersectionObserver が報告していないので、いまの位置から決める
  let logSeen = (() => {
    const r = log.getBoundingClientRect?.();
    return !!r && r.height > 0 && r.top < (globalThis.innerHeight ?? 0) && r.bottom > 0;
  })();
  let unseen = [];

  function setUnread() {
    unseen = unseen.filter((el) => el.isConnected);
    unread.hidden = unseen.length === 0;
    unread.textContent = `新しい案内 ${unseen.length}`;
  }
  function markSeen() {
    for (const el of unseen) {
      el.classList.remove("unseen");
      flash(el);
    }
    unseen = [];
    setUnread();
  }
  function flash(el) {
    el.classList.remove("fresh");
    void el.offsetWidth;
    el.classList.add("fresh");
  }
  function jumpToUnseen() {
    const el = unseen.find((x) => x.isConnected);
    el?.scrollIntoView?.({ block: "nearest" });
    markSeen();
  }
  // ログ欄が画面に入っているか（スマホではエディタの下、別のタブのときは display: none で見えない）
  if (typeof IntersectionObserver === "function") {
    let seenTimer = null;
    new IntersectionObserver((entries) => {
      const e = entries.at(-1);
      logSeen = !!e?.isIntersecting && e.intersectionRatio > 0.15;
      clearTimeout(seenTimer);
      // 一瞬かすめただけでは既読にしない
      if (logSeen && unseen.length) seenTimer = setTimeout(() => logSeen && markSeen(), 700);
    }, { threshold: [0, 0.15, 0.5] }).observe(log);
    // 裏のタブで届いた案内は、戻ってきたときに光らせる
    document.addEventListener("visibilitychange", () => {
      clearTimeout(seenTimer);
      if (!document.hidden && logSeen && unseen.length) seenTimer = setTimeout(() => logSeen && !document.hidden && markSeen(), 700);
    });
  }

  function showBanner(cls, children) {
    banner.hidden = false;
    banner.className = `banner ${cls} pop`;
    void banner.offsetWidth;
    banner.classList.add("show");
    banner.replaceChildren(...children);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { banner.hidden = true; }, BANNER_MS);
  }

  function line(text, cls = "") {
    const el = h("div", { class: `ln ${cls}` }, text);
    log.append(el);
    while (log.childElementCount > MAX_LINES) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
    return el;
  }

  return {
    line,
    /**
     * 案内の行（吹き出しにも出すもの）。ふつうの行より目立たせ、ログ欄が見えていないときは数えておく。
     * kind は guide・goal・warn。既存の色のクラス（note・ok・warn）は cls で渡す
     */
    guide(text, cls = "note", kind = "guide") {
      const el = line(text, `${cls} guide g-${kind}`);
      // 行頭の「# 」は本文の書体だと浮いて見えるので薄くする（文字としては残す。innerText で読むテストがある）
      const m = /^#\s/.exec(text);
      if (m) el.replaceChildren(h("span", { class: "ln-hash" }, m[0]), text.slice(m[0].length));
      if (logSeen && !document.hidden) flash(el);
      else {
        el.classList.add("unseen");
        unseen.push(el);
        setUnread();
      }
      return el;
    },
    /** 吹き出しで最後まで読んだ・押した案内は、もう「新しい案内」に数えない */
    markRead(el) {
      if (!el || !unseen.includes(el)) return;
      el.classList.remove("unseen");
      unseen = unseen.filter((x) => x !== el);
      setUnread();
    },
    /** ログ欄を見ていないあいだに届いた案内の数（スマホのコードのタブに印を付ける） */
    get unread() {
      return unseen.length;
    },
    /** 吹き出しから飛んできたときに、その行を見える位置まで送って光らせる */
    focusLine(el, { scroll = true } = {}) {
      if (!el?.isConnected) {
        log.scrollTop = log.scrollHeight;
        return;
      }
      if (unseen.includes(el)) {
        el.classList.remove("unseen");
        unseen = unseen.filter((x) => x !== el);
        setUnread();
      }
      if (scroll) el.scrollIntoView?.({ block: "center", behavior: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth" });
      else el.scrollIntoView?.({ block: "nearest" });
      flash(el);
    },
    /** puts / p の出力。1 バッチ 4KB は Ruby 側で切っている */
    output(text) {
      const all = String(text).replace(/\n$/, "").split("\n");
      const lines = all.slice(0, OUTPUT_MAX);
      // 工場長の声（method_missing・合鍵・36 協定の返事）は色を変える
      for (const l of lines) line(l, /工場長|カチャ。夜間/.test(l) ? "out boss" : "out");
      // 切ったことが分かるようにする（黙って消さない）
      if (all.length > OUTPUT_MAX) line(`# … 残りの ${all.length - OUTPUT_MAX} 行は省きました。ログ欄に一度に出すのは ${OUTPUT_MAX} 行までです`, "out");
    },
    /** Ruby の warning の形の行（監査報告）。1 行目は warning、続く行は字下げ */
    warning(text) {
      const lines = String(text).replace(/\n$/, "").split("\n");
      const els = lines.map((l, i) => line(l, i === 0 ? "warning" : "warning sub"));
      return els[0];
    },
    /** 工場長の声（JS 側から出す一言） */
    boss(text) {
      return line(text, "boss");
    },
    /** タイプライター表示（Ractor / YJIT の本物のエラー文） */
    type(text, cls = "") {
      // 前の行を打ち込んでいる途中なら、途中で止めずに全文を出してから次の行に移る
      clearInterval(typing);
      finishTyping?.();
      const el = line("", `${cls} typing`);
      const chars = [...text];
      let i = 0;
      finishTyping = () => {
        el.textContent = text;
        el.classList.remove("typing");
        finishTyping = null;
      };
      typing = setInterval(() => {
        i = Math.min(chars.length, i + 2);
        el.textContent = chars.slice(0, i).join("");
        log.scrollTop = log.scrollHeight;
        if (i >= chars.length) {
          clearInterval(typing);
          finishTyping?.();
        }
      }, 28);
      return el;
    },
    /**
     * benchmark-ips 風のバナー。b = { before, after, opsBefore, opsAfter, base?: { value, label }, xmas?: { before, after }, jam? }
     * base は研究の直前の単価。研究のあとの最初の書き換えでは、見出しを研究前からの倍率にする
     * （研究だけで上がった分を差し引くと、書いた 1 行の手応えが小さく見えるため）。ratio は常に旧コードとの比
     */
    bench(b) {
      const ratio = b.before > 0 ? b.after / b.before : b.after > 0 ? Infinity : 1;
      // 単価はほぼ同じで鑑定だけ減った（sort { } → sort_by など）。単価の 1.00x では手応えが出ないので、工場の処理量の倍率を見出しにする
      const ref = b.refinery;
      // 間に研究を買っていても（研究前比の見出しより）こちらを優先する
      const faster = Math.abs(ratio - 1) < 0.02 && b.opsAfter > 0 && b.opsBefore > b.opsAfter * 1.1
        && ref?.before > 0 && ref.after > ref.before;
      const up = ratio >= 1 || faster;
      const base = up && !faster && b.base?.value > 0 ? b.base : null;
      const from = base ? base.value : b.before;
      const shown = base ? b.after / base.value : ratio;
      const head = faster
        ? `工場 ${formatNumber(ref.before)} → ${formatNumber(ref.after)} 個/秒（${fmtRatio(ref.after / ref.before)}x）`
        : `1 鉱石あたり ${fmtPerOre(from, formatNumber)} → ${fmtPerOre(b.after, formatNumber)}（${fmtRatio(shown)}x）`;
      const pad = (s, n) => s.padStart(n);
      const nv = fmtPerOre(b.after, formatNumber).slice(1);
      const ov = fmtPerOre(b.before, formatNumber).slice(1);
      const bv = base ? fmtPerOre(base.value, formatNumber).slice(1) : "";
      const w = Math.max(nv.length, ov.length, bv.length) + 1;
      const fast = up ? "new" : "old";
      const slowRatio = up ? ratio : ratio > 0 ? 1 / ratio : Infinity;
      // 「研究前:」は全角 3 文字で 7 桁ぶん。new / old の見出しも同じ幅にして数字の列をそろえる
      const lab = (s) => (base ? s.padEnd(7) : s);
      const rows = [
        "Comparison:",
        `  ${lab("new:")} ${pad(nv, w)} $/ore   鑑定 ${b.opsAfter.toFixed(2)} 回${fast === "old" ? ` - ${fmtRatio(slowRatio)}x slower` : ""}`,
        `  ${lab("old:")} ${pad(ov, w)} $/ore   鑑定 ${b.opsBefore.toFixed(2)} 回${fast === "new" && ratio !== 1 ? ` - ${fmtRatio(slowRatio)}x slower` : ""}`,
      ];
      if (base) rows.push(`  研究前: ${pad(bv, w)} $/ore   - ${fmtRatio(shown)}x slower`);
      const parts = [h("div", { class: "banner-head" }, head)];
      if (base) parts.push(h("div", { class: "banner-sub" }, `研究${base.label}と書き換えを合わせた倍率です。書き換えだけなら ${fmtRatio(ratio)}x`));
      if (faster) {
        parts.push(h("div", { class: "banner-sub" }, `鑑定 ${b.opsBefore.toFixed(2)} → ${b.opsAfter.toFixed(2)} 回/鉱石。1 鉱石あたり ${fmtPerOre(b.after, formatNumber)} のまま、同じ CPU で ${fmtRatio(ref.after / ref.before)} 倍の原石をさばけます${b.refinery.note ? `。${b.refinery.note}` : ""}`));
      }
      // 単価は上がったが、鑑定や箱が増えて収入が下がるとき。緑の倍率だけ見て損をしないように並べて出す
      if (b.jam) parts.push(h("div", { class: "banner-sub jam" }, b.jam));
      // クリスマス便の研究のあとは、合計 25 の箱が何箱できたかも出す（1 バッチあたり）
      const x = b.xmas;
      if (x && (x.after > 0 || x.before > 0)) {
        const n = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ""));
        const text = x.before == null ? `クリスマス便 ${n(x.after)} 箱/バッチ` : `クリスマス便 ${n(x.before)} → ${n(x.after)} 箱/バッチ`;
        parts.push(h("div", { class: "banner-sub xmas" }, `${text}。carat の合計がちょうど 25 の箱は ×4 です`));
      }
      parts.push(h("pre", { class: "banner-cmp" }, rows.join("\n")));
      showBanner(up ? "up" : "down", parts);
      return { head, ratio, faster };
    },
    /** 研究で工場だけが速くなったとき（Ractor / YJIT）。r = { label, before, after, note } */
    speed(r) {
      const head = `研究「${r.label}」: 工場 ${formatNumber(r.before)} → ${formatNumber(r.after)} 個/秒（${fmtRatio(r.after / r.before)}x）`;
      showBanner("up research", [h("div", { class: "banner-head" }, head), h("div", { class: "banner-sub" }, r.note)]);
      return { head };
    },
    /**
     * 研究だけで単価が上がったとき。r = { label, before, after, tip, box? }
     * box は、box を読むコードのまま箱の研究を買ったときの新しい箱サイズ。ハードコードしなかった見返りなので大きく見せる
     */
    research(r) {
      const ratio = r.after / r.before;
      if (r.box) {
        const head = `研究「${r.label}」: 書き換えなしで箱 ${r.box} ${fmtPerOre(r.before, formatNumber)} → ${fmtPerOre(r.after, formatNumber)}（×${fmtRatio(ratio)}）`;
        showBanner("up research boxup", [
          h("div", { class: "banner-big" }, `×${fmtRatio(ratio)}`),
          h("div", { class: "banner-head" }, head),
          h("div", { class: "banner-sub" }, `コードが box を読んでいるので、研究を入れただけで ${r.box} 個ずつ詰めています。box をハードコードしなかったおかげです`),
        ]);
        return { head, ratio };
      }
      const head = `研究「${r.label}」: コードはそのまま ${fmtPerOre(r.before, formatNumber)} → ${fmtPerOre(r.after, formatNumber)}（${fmtRatio(ratio)}x）`;
      const parts = [h("div", { class: "banner-head" }, head)];
      parts.push(h("div", { class: "banner-sub" }, r.tip ? `1 行書き換えるともっと伸びます。ヒント: ${r.tip}` : "書き換えなしで単価が上がりました"));
      showBanner("up research", parts);
      return { head, ratio };
    },
    /** 研究を買ったが、いまのコードのままでは単価が変わらないとき。r = { label, tip } */
    nudge(r) {
      const head = `研究「${r.label}」を入れました。いまのコードのままでは単価は変わりません`;
      showBanner("research nudge", [
        h("div", { class: "banner-head" }, head),
        h("div", { class: "banner-sub" }, `次の 1 行: ${r.tip}`),
        h("div", { class: "banner-sub" }, "使い方と手本は「ヒント」で見られます"),
      ]);
      return { head };
    },
    /**
     * スマホ幅では、ベンチ欄がエディタとデプロイボタンの下にあって見えない。デプロイの結果を出したときだけ見える位置まで送る
     * （定常バッチの故障票では呼ばない。打っている途中で画面が動くため）
     */
    reveal(which = "banner") {
      const el = which === "ticket" ? ticket : banner;
      if (el.hidden || !globalThis.matchMedia?.("(max-width: 899px)")?.matches) return;
      el.scrollIntoView?.({ block: "nearest" });
    },
    hideBench() {
      clearTimeout(bannerTimer);
      banner.hidden = true;
    },
    /** 故障票（SPEC 10.5）。t = { title, rows: [[k, v]], hint, kind } */
    ticket(t) {
      if (!t) {
        ticket.hidden = true;
        return;
      }
      ticket.hidden = false;
      ticket.className = `ticket ${t.kind ?? "jam"}`;
      // replaceChildren は null を "null" という文字にするので、ヒントがないときは渡さない
      const parts = [
        h("div", { class: "ticket-head" }, h("span", { class: "ticket-tag" }, t.tag ?? "故障票"), t.title),
        h("table", {}, h("tbody", {}, (t.rows ?? []).map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v))))),
      ];
      if (t.hint) parts.push(h("div", { class: "ticket-hint" }, t.hint));
      ticket.replaceChildren(...parts);
    },
    clear() {
      log.replaceChildren();
    },
    setStatus(el, text) {
      setText(el, text);
    },
  };
}
