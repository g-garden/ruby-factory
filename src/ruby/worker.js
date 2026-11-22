/* Ruby VM を 1 つだけ持つ classic Worker。ゲーム状態は持たず、prelude の Yield を呼んで文字列を返すだけ。
 * 固まったらホスト（runtime.js）が terminate して作り直す。
 * 返信: { seq, ...結果, mem }。VM が壊れた可能性があるときは { seq, fatal: true, error }。 */
importScripts("../../vendor/ruby-wasm-browser.umd.js");

const US = "\x1f";
let vm = null;
let memory = null;

// JS 文字列を Ruby の文字列式にする。hex で運んでエスケープの問題を避ける
function rbStr(s) {
  const bytes = new TextEncoder().encode(s);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `["${hex}"].pack("H*").force_encoding("UTF-8")`;
}

const lineOf = (s) => (s === "" || s == null ? null : Number(s));

function parseBatch(raw) {
  const f = raw.split(US);
  if (f[0] === "OK" && f.length >= 6) {
    const [n, total = n] = f[3].split("/").map(Number);
    const crates = n === 0 ? [] : f[4].split(";").map((c) => (c === "" ? [] : c.split(",").map(Number)));
    if (crates.length !== n) return protocolError(raw);
    return {
      ok: true,
      ops: Number(f[1]),
      polished: f[2] === "" ? [] : f[2].split(",").map(Number),
      crates,
      crateCount: total,
      log: f.slice(5).join(US),
    };
  }
  if (f[0] === "ERR" && f.length >= 6) {
    return { ok: false, ops: Number(f[1]), errClass: f[2], message: f[3], line: lineOf(f[4]), log: f.slice(5).join(US) };
  }
  return protocolError(raw);
}

// Yield.run や区切り文字、Integer#to_s などを書き換えられた場合。生の文字列は故障票に出さない
function protocolError(raw) {
  console.warn("[ruby] Yield.run の戻り値を読めませんでした", String(raw).slice(0, 200));
  return { ok: false, ops: 0, errClass: "ProtocolError", message: "Yield.run や区切り文字、to_s などが書き換えられていて、結果を読めませんでした。書き換えを外してデプロイしてください", line: null, log: "" };
}

// 成功: "OK" US log（古い prelude の "OK" 単体も読む）。失敗: "ERR" US 例外クラス US メッセージ US 行番号 US log
function parseDeploy(raw) {
  const f = raw.split(US);
  if (f[0] === "OK") return { ok: true, log: f.slice(1).join(US) };
  if (f[0] === "ERR" && f.length >= 3) return { ok: false, errClass: f[1], message: f[2], line: lineOf(f[3]), log: f.slice(4).join(US) };
  console.warn("[ruby] Yield.deploy の戻り値を読めませんでした", String(raw).slice(0, 200));
  return { ok: false, errClass: "ProtocolError", message: "Yield の内部が書き換えられていて、デプロイの結果を読めませんでした", line: null };
}

function parseProbe(raw) {
  const f = raw.split(US);
  if (f[0] === "OK") return { ok: true, value: f.slice(1).join(US), errClass: null, message: null };
  if (f[0] === "ERR") return { ok: false, value: null, errClass: f[1], message: f.slice(2).join(US) };
  return { ok: false, value: null, errClass: "ProtocolError", message: String(raw).slice(0, 200) };
}

// Ruby 側で捕まえきれなかった例外（RbError）は VM が無事。それ以外（wasm の trap、JS のスタック溢れ、
// RbFatalError）は VM の状態が信用できないので fatal として返し、ホストに作り直させる
function isRecoverable(e) {
  return e && e.constructor && e.constructor.name === "RbError";
}

function rbErrorClass(e) {
  const m = /\(([A-Z][\w:]*)\)\s*$/m.exec(String(e.message || ""));
  return m ? m[1] : "RbError";
}

function evalStr(code) {
  return vm.eval(code).toString();
}

// 裏口の報告（SPEC-rubyist 4.2）。Yield::REPORT は private_constant なので const_get を bind_call して読む。
// 生の値をそのまま返し、丸めは core（economy.clampBackdoor）に任せる。
// 項目ごとに読む: Integer でない値（2.5・2r・"2"・nil など）はその項目だけ "?"（lanes は NaN にして core が 1 車線に丸めて一言出す。
// night と overtime は読めなかったら false / 0）。join で型が消えて "2" が 2 車線として通らないよう、Ruby 側で Integer か確かめる。
// REPORT を偽造されて 3 つ組でない・例外を投げるときは null（裏口なし）
const REPORT_EXPR = "Module.instance_method(:const_get).bind_call(Yield, :REPORT).call.map { Integer === it ? it.to_s : \"?\" }.join(\",\")";
function parseReport(raw) {
  const s = String(raw);
  if (s.length > 200) return null;
  const f = s.split(",");
  if (f.length !== 3) return null;
  const n = f.map((x) => (/^-?\d+$/.test(x) ? Number(x) : NaN));
  return { lanes: n[0], night: Number.isFinite(n[1]) && n[1] !== 0, overtime: Number.isFinite(n[2]) ? n[2] : 0 };
}
function readBackdoor() {
  try {
    return parseReport(evalStr(REPORT_EXPR));
  } catch (e) {
    if (!isRecoverable(e)) throw e;
    return null;
  }
}

function deployExpr(msg) {
  const box = Number.isInteger(msg.box) && msg.box > 0 ? msg.box : "nil";
  return `Yield.deploy(${rbStr(msg.src)}, ${box})`;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  const reply = (body) => self.postMessage({ seq: msg.seq, mem: memory ? memory.buffer.byteLength : 0, ...body });
  const t0 = performance.now();
  try {
    if (msg.type === "init") {
      const { DefaultRubyVM } = self["ruby-wasm-wasi"];
      const r = await DefaultRubyVM(msg.module, { consolePrint: false });
      vm = r.vm;
      memory = r.instance.exports.memory;
      const tVm = performance.now() - t0;
      vm.eval(msg.prelude);
      reply({
        ok: true,
        version: evalStr("RUBY_VERSION"),
        description: evalStr("RUBY_DESCRIPTION"),
        vmMs: tVm,
        ms: performance.now() - t0,
      });
      return;
    }
    if (!vm) throw new Error("VM がまだありません");
    if (msg.type === "deploy") {
      let r;
      try {
        r = parseDeploy(evalStr(deployExpr(msg)));
      } catch (e) {
        if (!isRecoverable(e)) throw e;
        r = { ok: false, errClass: rbErrorClass(e), message: String(e.message).slice(0, 400), line: null, log: "" };
      }
      reply({ ...r, ms: performance.now() - t0 });
      return;
    }
    if (msg.type === "batch") {
      let r;
      try {
        r = parseBatch(evalStr(`Yield.run(${msg.lit})`));
      } catch (e) {
        if (!isRecoverable(e)) throw e;
        r = { ok: false, ops: 0, errClass: rbErrorClass(e), message: String(e.message).slice(0, 300), line: null, log: "" };
      }
      if (r.ok) {
        try { r.monkeyPatched = evalStr("Yield.patched?") === "true"; } catch { r.monkeyPatched = false; }
        // 研磨機を冷やしたか（@heat と磨いた回数がずれている）。監査が研磨の鑑定を数え直す
        try { r.heatCooled = evalStr("Yield.cooled?") === "true"; } catch { r.heatCooled = false; }
        // @ops を負の数や NaN に書き換えると鑑定 0 より安くなる。tick の再定義と同じ扱いにする
        if (!(Number.isFinite(r.ops) && r.ops >= 0)) {
          r.ops = 0;
          r.monkeyPatched = true;
        }
        r.backdoor = readBackdoor();
      }
      reply({ result: r, ms: performance.now() - t0 });
      return;
    }
    if (msg.type === "probe") {
      let r;
      try {
        r = parseProbe(evalStr(`Yield.probe(${rbStr(msg.code)})`));
      } catch (e) {
        if (!isRecoverable(e)) throw e;
        r = { ok: false, value: null, errClass: rbErrorClass(e), message: String(e.message).slice(0, 300) };
      }
      reply({ result: r, ms: performance.now() - t0 });
      return;
    }
    throw new Error(`未知のメッセージ: ${msg.type}`);
  } catch (e) {
    // ブロック経由の深い再帰は Ruby の SystemStackError より先に JS のスタックが溢れる。VM は信用できないので作り直す
    const stack = e?.name === "RangeError" && /call stack/i.test(String(e.message));
    reply({ fatal: true, stack, error: `${e && e.name}: ${String((e && e.message) || e).slice(0, 400)}` });
  }
};
