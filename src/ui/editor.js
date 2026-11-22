import { h, setText, toggle } from "./dom.js";

// 研究の順に並べる（最初の研究 crate で使う each_slice が PC 幅でも見切れないように）
const SNIPPETS = [".each_slice(box)", ".to_a", ".reject(&:flaw)", ".sort_by(&:carat)", ".group_by(&:color)", ".values", ".flat_map { }"];
/** スニペットのボタンに出す説明。box は初見だと中身がわからないので補う */
const SNIPPET_TITLES = { ".each_slice(box)": "box は 1 箱に詰められる数です（研究で増えます）" };
const INDENT = "  ";
const FILE_NAME = "pack.rb";

/** pack.rb のエディタ。textarea に行番号とエラー行の帯を重ねる */
export function createEditor(root, { initial, onChange, onDeploy, onRevert, onHint, onSolution, onRi }) {
  const gutter = h("pre", { class: "gutter", "aria-hidden": "true" });
  const errBar = h("div", { class: "err-bar", hidden: true });
  const ta = h("textarea", {
    id: "code", class: "code", spellcheck: "false", autocapitalize: "off", autocomplete: "off", autocorrect: "off",
    wrap: "off", "aria-label": FILE_NAME,
  });
  ta.value = initial;
  const deployBtn = h("button", { id: "deploy", class: "btn btn-deploy", type: "button", onclick: () => onDeploy() }, "デプロイ");
  const deployNote = h("span", { class: "deploy-note", id: "deploy-note" });
  const revertBtn = h("button", { id: "revert", class: "btn", type: "button", onclick: () => onRevert() }, "前のコードに戻す");
  const hintBtn = h("button", { id: "hint", class: "btn", type: "button", onclick: () => onHint() }, "ヒント");
  const solBtn = h("button", { id: "solution", class: "btn", type: "button", onclick: () => onSolution() }, "この研究の完成コードを入れる");
  const snippets = h("div", { class: "snippets", role: "toolbar", "aria-label": "スニペット" },
    SNIPPETS.map((s) => h("button", { class: "snip", type: "button", title: SNIPPET_TITLES[s], dataset: { snip: s }, onclick: () => insert(s) }, s)));
  const errMsg = h("div", { class: "err-msg", hidden: true });
  const fname = h("span", { class: "fname" }, FILE_NAME);
  // 型と数の早見表。onRi が渡されないときは出さない
  const riBtn = onRi ? h("button", { class: "ri-btn", type: "button", title: "pack.rb の早見表", onclick: onRi }, "ri 早見表") : null;
  const kbdHint = h("span", { class: "kbd-hint" }, "⌘/Ctrl + Enter でデプロイ");
  const todo = h("div", { class: "todo-line", id: "todo", hidden: true });

  root.append(
    h("div", { class: "editor-head" }, fname, riBtn, kbdHint),
    todo,
    snippets,
    h("div", { class: "code-wrap" }, gutter, h("div", { class: "code-area" }, errBar, ta)),
    errMsg,
    h("div", { class: "editor-actions" }, h("div", { class: "deploy-box" }, deployBtn, deployNote), revertBtn, hintBtn, solBtn),
  );

  let errLine = null;
  // 一度もカーソルを置いていない textarea の選択位置は末尾（end の後ろ）なので、スニペットの入れ先を変える
  let touched = false;
  for (const ev of ["pointerdown", "keydown", "select"]) ta.addEventListener(ev, () => { touched = true; });
  const lineHeight = () => parseFloat(getComputedStyle(ta).lineHeight) || 20;
  const padTop = () => parseFloat(getComputedStyle(ta).paddingTop) || 0;

  function renderGutter() {
    const n = ta.value.split("\n").length;
    let s = "";
    for (let i = 1; i <= n; i++) s += (i === errLine ? "▶" : "") + i + "\n";
    setText(gutter, s);
    syncScroll();
  }
  function syncScroll() {
    gutter.scrollTop = ta.scrollTop;
    if (errLine != null) errBar.style.transform = `translateY(${padTop() + (errLine - 1) * lineHeight() - ta.scrollTop}px)`;
  }
  function changed() {
    if (errLine != null) clearError();
    renderGutter();
    onChange(ta.value);
  }
  function replaceSel(text, selectStart = null, selectEnd = null) {
    ta.focus();
    const a = ta.selectionStart, b = ta.selectionEnd;
    // execCommand は undo 履歴に残る。使えない環境では直接書き換える
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch { ok = false; }
    if (!ok) {
      ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
      ta.selectionStart = ta.selectionEnd = a + text.length;
      changed();
    }
    if (selectStart != null) {
      ta.selectionStart = a + selectStart;
      ta.selectionEnd = a + (selectEnd ?? selectStart);
    }
  }
  /** 最後の end の手前にある、コードの最後の行の末尾（行末コメントの前）。なければ null */
  function chainPoint() {
    const v = ta.value;
    const lines = v.split("\n");
    let off = v.length;
    let sawEnd = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      off -= line.length + (i < lines.length - 1 ? 1 : 0);
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      if (!sawEnd && t === "end") { sawEnd = true; continue; }
      if (!sawEnd) return null;
      const code = line.replace(/\s+#[^"'{}]*$/, "").replace(/\s+$/, "");
      return off + code.length;
    }
    return null;
  }
  function insert(snip) {
    if (!touched && document.activeElement !== ta) {
      const p = chainPoint();
      if (p != null) {
        ta.focus();
        ta.setSelectionRange(p, p);
      }
    }
    // ブロックは { | } の中にカーソルを置く
    const i = snip.indexOf("{ }");
    if (i >= 0) replaceSel(snip, i + 2);
    else replaceSel(snip);
  }

  ta.addEventListener("input", (e) => {
    if (e.inputType === "insertText" && e.data === "d") dedentEnd();
    changed();
  });
  // Enter の自動インデントで本体と同じ深さに来た end を、打ち終えた時点で 1 段戻す
  function dedentEnd() {
    const v = ta.value;
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd || (pos < v.length && v[pos] !== "\n")) return;
    const ls = v.lastIndexOf("\n", pos - 1) + 1;
    const m = /^( +)end$/.exec(v.slice(ls, pos));
    if (!m || m[1].length < INDENT.length) return;
    let p = ls - 1;
    while (p > 0) {
      const ps = v.lastIndexOf("\n", p - 1) + 1;
      const prev = v.slice(ps, p);
      if (prev.trim() !== "") {
        const pi = /^ */.exec(prev)[0].length;
        // 直前が本体の行なら同じ深さ、開き行（def / do など、本体が空）なら 1 段深いときだけ戻す
        const opener = /(\bdo|\{)(\s*\|[^|]*\|)?\s*$/.test(prev) || /^\s*(def|if|unless|while|until|begin|case|class|module)\b/.test(prev);
        if (pi !== m[1].length - (opener ? INDENT.length : 0)) return;
        break;
      }
      p = ps - 1;
    }
    if (p <= 0) return;
    ta.setSelectionRange(ls, ls + INDENT.length);
    replaceSel("");
    ta.selectionStart = ta.selectionEnd = pos - INDENT.length;
  }
  ta.addEventListener("scroll", syncScroll);
  // 長い行の末尾で横に送られたまま止まると、def や行頭が見切れて読めない。手を離したら行頭に戻す
  ta.addEventListener("blur", () => { ta.scrollLeft = 0; });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onDeploy();
      return;
    }
    if (e.key === "Tab" && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (e.shiftKey) {
        const v = ta.value;
        const ls = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
        if (v.startsWith(INDENT, ls)) {
          const pos = ta.selectionStart;
          ta.setSelectionRange(ls, ls + INDENT.length);
          replaceSel("");
          ta.selectionStart = ta.selectionEnd = Math.max(ls, pos - INDENT.length);
        }
      } else {
        replaceSel(INDENT);
      }
      return;
    }
    // Safari は変換確定の Enter で isComposing が false になるので keyCode 229 も見る
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      // 前の行のインデントを引き継ぐ。do / { で終わる行は 1 段深くする
      const v = ta.value;
      const ls = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
      const line = v.slice(ls, ta.selectionStart);
      const indent = /^ */.exec(line)[0];
      const t = line.trimEnd();
      const opener = /^\s*(def|if|unless|while|until|begin|case|class|module)\b/.test(t) && !/\bend$/.test(t);
      const endless = /^\s*def\s+[\w?!]+(\([^)]*\))?\s*=(?!=)/.test(t);
      const deeper = /(\bdo|\{)(\s*\|[^|]*\|)?$/.test(t) || (opener && !endless);
      e.preventDefault();
      replaceSel("\n" + indent + (deeper ? INDENT : ""));
    }
  });
  renderGutter();

  function clearError() {
    errLine = null;
    errBar.hidden = true;
    errMsg.hidden = true;
    renderGutter();
  }

  return {
    get value() { return ta.value; },
    set(code) {
      touched = false;
      ta.value = code;
      clearError();
      renderGutter();
      onChange(code);
    },
    /**
     * コードを丸ごと入れ替える（答えの書き写し・完成コード）。textarea の編集履歴に残すので Cmd/Ctrl+Z で戻せる。
     * execCommand が使えない環境では set と同じ（戻せない）
     */
    replace(code) {
      if (ta.value === code) return;
      let ok = false;
      try {
        ta.focus({ preventScroll: true });
        ta.select();
        ok = document.execCommand?.("insertText", false, code) === true;
      } catch {
        ok = false;
      }
      if (!ok || ta.value !== code) ta.value = code;
      touched = false;
      clearError();
      renderGutter();
      onChange(code);
    },
    markError(line, message) {
      errLine = Number.isFinite(line) && line > 0 ? line : null;
      errBar.hidden = errLine == null;
      errMsg.hidden = !message;
      setText(errMsg, message ? (errLine ? `${FILE_NAME}:${errLine} ` : "") + message : "");
      renderGutter();
    },
    clearError,
    /** { label, ok, busy, glow, note } */
    setDeploy(d) {
      setText(deployBtn, d.label);
      deployBtn.disabled = !d.ok;
      toggle(deployBtn, "busy", !!d.busy);
      toggle(deployBtn, "glow", !!d.glow);
      setText(deployNote, d.note ?? "");
      deployBtn.dataset.ready = d.ok ? "1" : "0";
    },
    setRevert(enabled) { revertBtn.disabled = !enabled; },
    setSolution(enabled, title) {
      solBtn.disabled = !enabled;
      solBtn.title = title ?? "";
    },
    focus() { ta.focus(); },
    /** デプロイのあと、横スクロールを行頭に戻す（カーソルは動かさない） */
    home() { ta.scrollLeft = 0; },
    /** 研究を買ったのにまだ書いていないときの「次の 1 行」。t = { text, methods } か null */
    setTodo(t) {
      todo.hidden = !t;
      setText(todo, t ? t.text : "");
      for (const b of snippets.querySelectorAll(".snip")) {
        toggle(b, "todo", !!t && t.methods.some((m) => b.dataset.snip.includes(`.${m}`)));
      }
    },
  };
}
