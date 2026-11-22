import { formatMoney, formatNumber } from "../economy.js";
import { fmtPerOre, h, setText, toggle } from "./dom.js";

/** HUD: $ のカウントアップ、+x/s、単価、記録、VM の状態、ミュート、X で共有、最初からやり直す */
export function createHud(root, { onMute, onReset, onShare }) {
  const money = h("span", { class: "hud-money", id: "hud-money" }, "$0");
  const rate = h("span", { class: "hud-rate" }, "+$0/s");
  const perOre = h("b", {}, "$1.0");
  const record = h("b", {}, "-");
  const vm = h("span", { class: "hud-vm", id: "hud-vm" }, "Ruby VM 0%");
  // 押すと音が出る・止まる。いまの状態は文字（音 ON / 音 OFF）と aria-pressed（押されている = 音が出ている）で見せる
  const mute = h("button", { class: "hud-mute off", type: "button", "aria-label": "音", "aria-pressed": "false", title: "音を出す", onclick: () => onMute() }, "音 OFF");
  const share = h("button", { class: "hud-share", type: "button", "aria-label": "X で共有", title: "いまの記録を X で共有", onclick: () => onShare?.() }, "共有");
  // 押し間違いでセーブが消えないよう 2 回押しにする。1 回目で「本当に？」に変わり、4 秒たつと元に戻る
  let armTimer = 0;
  const disarm = () => {
    clearTimeout(armTimer);
    armTimer = 0;
    reset.classList.remove("armed");
    setText(reset, "最初から");
    reset.setAttribute("aria-label", "セーブを消して最初からやり直す");
  };
  const reset = h("button", {
    class: "hud-reset", type: "button", "aria-label": "セーブを消して最初からやり直す",
    onclick: () => {
      if (!armTimer) {
        reset.classList.add("armed");
        setText(reset, "本当に？");
        reset.setAttribute("aria-label", "本当に？ もう一度押すとセーブを消して最初からやり直します");
        armTimer = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      onReset();
    },
  }, "最初から");
  root.append(
    h("div", { class: "hud-brand" }, h("span", { class: "hud-logo" }, "◆"),
      // タイトルはコードの見た目にする（def はキーワードの色、pack はメソッド名の色）
      h("span", { class: "hud-title" },
        h("span", { class: "hud-kw" }, "def"), " ", h("span", { class: "hud-fn" }, "pack"), "(belt)")),
    h("div", { class: "hud-main" }, money, rate),
    h("div", { class: "hud-sub" },
      h("span", { class: "hud-stat" }, "単価 ", perOre, h("small", {}, "/ore")),
      h("span", { class: "hud-stat hud-record" }, "記録 ", record),
      vm,
      mute,
      share,
      reset,
    ),
  );

  let shown = 0;
  let shownLen = 0;
  let bumpT = 0;
  let tier = 0;

  return {
    /** 毎フレーム呼ぶ。money は補間して表示する */
    frame(dt, d) {
      const target = d.money;
      // 大きく減ったとき（購入）は即座に合わせる。増えるときだけ数字を転がす
      if (target < shown || !Number.isFinite(shown)) shown = target;
      else shown += (target - shown) * (1 - Math.exp(-dt * 10));
      if (target - shown < 0.01) shown = target;
      const text = formatMoney(shown);
      const t = shown < 1000 ? String(Math.floor(shown)).length : 3 + Math.floor(Math.log10(Math.max(1, shown)) / 3) * 3;
      if (t !== shownLen) {
        if (shownLen) {
          bumpT = 0.35;
          tier = (tier + 1) % 4;
          money.dataset.tier = String(tier);
        }
        shownLen = t;
      }
      bumpT = Math.max(0, bumpT - dt);
      toggle(money, "bump", bumpT > 0);
      setText(money, text);
    },
    /** 10Hz で呼ぶ */
    update(d) {
      // 序盤は $0.5/s〜$1.5/s で、整数に丸めると収入が止まって見える。$ の表示（SPEC 5.1）とは別に 1 桁出す
      const r = d.incomePerSec;
      setText(rate, `+${r > 0 && r < 100 ? `$${r.toFixed(1)}` : formatMoney(r)}/s`);
      setText(perOre, fmtPerOre(d.valuePerOre, formatNumber));
      setText(record, d.record > 0 ? fmtPerOre(d.record, formatNumber) : "-");
      setText(mute, d.muted ? "音 OFF" : "音 ON");
      toggle(mute, "off", d.muted);
      mute.setAttribute("aria-pressed", d.muted ? "false" : "true");
      const tip = d.muted ? "音を出す" : "音を止める";
      if (mute.title !== tip) mute.title = tip;
      setText(vm, d.vmText);
      vm.dataset.phase = d.vmPhase;
    },
  };
}
