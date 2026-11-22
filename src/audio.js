// WebAudio の合成音だけで鳴らす効果音。音声ファイルは使わない（SPEC 12 章）。
// AudioContext はユーザー操作の中でしか作らない。先に作ると Chrome が警告を出し、iOS では鳴らない。

let ctx = null;
let master = null;
let muted = true; // main.js が起動時にセーブの設定で上書きする
let noiseBuf = null;
let lastShip = 0;
const VOLUME = 0.2;

function unlock() {
  if (!ctx) {
    const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : VOLUME;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      master.connect(comp);
      comp.connect(ctx.destination);
    } catch {
      ctx = null;
      return;
    }
  }
  // iOS は電話やバックグラウンド復帰で suspended / interrupted に戻るので、操作のたびに起こし直す
  if (ctx.state !== "running") ctx.resume().catch(() => {});
}

if (typeof window !== "undefined") {
  for (const ev of ["pointerdown", "keydown", "touchend"]) {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  }
}

function ready() {
  // 作った直後の resume() は非同期なので suspended でも予約しておく（同じ操作の中の 1 音目を落とさない）
  return ctx && ctx.state !== "closed" && !muted;
}

function tone(freq, dur, { type = "sine", gain = 0.5, at = 0, slide = null, attack = 0.004, filter = null } = {}) {
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let node = o;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type || "lowpass";
    f.frequency.value = filter.freq;
    node.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(dur, { gain = 0.3, at = 0, freq = 3000, type = "highpass" } = {}) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = ctx.currentTime + at;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(f);
  f.connect(g);
  g.connect(master);
  s.start(t0);
  s.stop(t0 + dur + 0.02);
}

const PENTA = [0, 2, 4, 7, 9];
const semi = (n) => 2 ** (n / 12);

function safe(fn) {
  return (...args) => {
    if (!ready()) return;
    try { fn(...args); } catch { /* 音が出ないだけでゲームは止めない */ }
  };
}

export const sfx = {
  /** 手掘りのカチッ。連打の段数（0〜）で音程が上がる */
  click: safe((pitchStep = 0) => {
    // 上限を 12 段（約 2kHz）にしておく。それ以上は耳に刺さる
    const step = Math.max(0, Math.min(12, pitchStep | 0));
    const f = 392 * semi(PENTA[step % 5] + 12 * Math.floor(step / 5));
    tone(f, 0.07, { type: "triangle", gain: 0.45, slide: f * 0.72 });
    noise(0.025, { gain: 0.18, freq: 4200 });
  }),

  /** 出荷音。直近の出荷頻度（個/秒）が高いほど音程が上がる。頻繁に呼ばれても内部で間引く */
  ship: safe((ratePerSec = 1) => {
    const now = ctx.currentTime;
    if (now - lastShip < 0.085) return;
    lastShip = now;
    const lv = Math.max(0, Math.min(9, Math.floor(Math.log2(1 + Math.max(0, ratePerSec)) * 1.2)));
    const f = 523.25 * semi(PENTA[lv % 5] + 12 * Math.floor(lv / 5));
    tone(f, 0.12, { type: "sine", gain: 0.22 });
    tone(f * 2, 0.06, { type: "sine", gain: 0.06 });
  }),

  deploy: safe(() => {
    [0, 4, 7, 12].forEach((n, i) => tone(523.25 * semi(n), 0.16, { type: "square", gain: 0.12, at: i * 0.065, filter: { freq: 2400 } }));
    tone(1046.5 * semi(7), 0.35, { type: "triangle", gain: 0.18, at: 0.28 });
    noise(0.3, { gain: 0.08, freq: 1200, type: "bandpass", at: 0.02 });
  }),

  record: safe(() => {
    [0, 4, 7].forEach((n) => tone(784 * semi(n), 0.7, { type: "triangle", gain: 0.13, attack: 0.01 }));
    [12, 16, 19, 24].forEach((n, i) => tone(784 * semi(n), 0.18, { type: "sine", gain: 0.12, at: 0.08 + i * 0.06 }));
  }),

  bundle: safe(() => {
    for (let i = 0; i < 6; i++) noise(0.02, { gain: 0.16, freq: 2500 + i * 200, at: i * 0.055 });
    tone(1318.5, 0.45, { type: "sine", gain: 0.22, at: 0.36 });
    tone(2637, 0.3, { type: "sine", gain: 0.06, at: 0.36 });
  }),

  error: safe(() => {
    tone(220, 0.16, { type: "sawtooth", gain: 0.16, slide: 180, filter: { freq: 900 } });
    tone(165, 0.26, { type: "sawtooth", gain: 0.16, slide: 110, at: 0.15, filter: { freq: 700 } });
  }),

  perfect: safe(() => {
    tone(1200, 0.22, { type: "sine", gain: 0.12, slide: 2600 });
    [2093, 2637, 3136].forEach((f, i) => tone(f, 0.28, { type: "sine", gain: 0.1, at: 0.12 + i * 0.05 }));
  }),

  /** 鑑定長に見抜かれた（AUDITED の判子）。ゴム印のドスッと、おどけた 2 音。叱る音ではないので暗くしない */
  audited: safe(() => {
    noise(0.11, { gain: 0.55, freq: 520, type: "lowpass" });
    tone(110, 0.2, { type: "sine", gain: 0.5, slide: 52 });
    tone(587.33, 0.09, { type: "square", gain: 0.09, at: 0.16, filter: { freq: 1800 } });
    tone(698.46, 0.2, { type: "square", gain: 0.09, at: 0.25, filter: { freq: 1800 } });
    tone(1396.9, 0.25, { type: "triangle", gain: 0.06, at: 0.25 });
  }),

  /** 特注便（クリスマス便の金色のトラック）。クラクション 2 回と、金貨のきらめき */
  specialDelivery: safe(() => {
    tone(392, 0.09, { type: "square", gain: 0.11, filter: { freq: 1500 } });
    tone(493.88, 0.09, { type: "square", gain: 0.08, filter: { freq: 1500 } });
    tone(392, 0.22, { type: "square", gain: 0.11, at: 0.13, filter: { freq: 1500 } });
    tone(493.88, 0.22, { type: "square", gain: 0.08, at: 0.13, filter: { freq: 1500 } });
    [0, 4, 7, 12, 16].forEach((n, i) => tone(1046.5 * semi(n), 0.3, { type: "sine", gain: 0.1, at: 0.4 + i * 0.055 }));
    noise(0.35, { gain: 0.05, freq: 6000, at: 0.4 });
  }),

  setMuted(b) {
    muted = !!b;
    if (master && ctx) {
      try { master.gain.setTargetAtTime(muted ? 0 : VOLUME, ctx.currentTime, 0.02); } catch { /* 古い実装 */ }
    }
  },

  get muted() {
    return muted;
  },
};
// 呼び名の揺れで鳴らないことがないように別名も置く（正式名は audited と specialDelivery）
sfx.audit = sfx.audited;
sfx.special = sfx.specialDelivery;
