// NOTICES.html の各ライセンスを、同じフォルダのファイルから読んで表示する。
// 拡張子のないファイルは直接開くとダウンロードになるので、ここで読んで <pre> に入れる。読めなければリンクを残す
for (const pre of document.querySelectorAll("pre[data-src]")) {
  fetch(pre.dataset.src)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((text) => { pre.textContent = text; })
    .catch(() => {
      const note = document.createElement("span");
      note.textContent = "読み込めませんでした。このリンクから開けます\n";
      pre.prepend(note);
    });
}
