// ruby.wasm のホスト側（SPEC 10 章）。本番 VM の Worker を 1 つ持ち、デプロイのたびに新しい Worker を作って差し替える。
// 本番 VM への操作（batch / probe / 旧コードのベンチ / 再起動）はキュー 1 本で直列に流す。
// デプロイ中の新 VM はこのキューの外で動くので、デプロイが固まっても batch は止まらない。
// 昇格はキューを待たずに差し替える（旧コードが固まって再起動が積もっても、デプロイの見張り時間を守るため）。
// 差し替えのたびに epoch を進め、それより前に始まった再起動・バッチは結果を捨てる。

// ruby.wasm はページと同じところから配る vendor/ だけを読む。外部の CDN から取ると、確かめていないバイト列を compile することになる。
// 候補を足せるように配列のままにしている
const DEFAULT_WASM_URLS = [
  new URL("../../vendor/ruby.wasm", import.meta.url).href,
];
const PRELUDE_URL = new URL("./prelude.rb", import.meta.url).href;

// 進捗の分母。Pages は圧縮して配るので Content-Length は使えない（100% を超える）
const WASM_BYTES = 17_219_023;
// wasm のメモリ上限（64KiB ページ）。上限なしだと Array.new(4*10**8) で 4GB まで伸びてタブごと落ちうる。
// 512MB にすると Ruby 側で NoMemoryError になり VM は生き残る（Node で確認）
export const WASM_MAX_PAGES = 8192;
// 初期化直後からこれだけ増えたら、次の操作の前に VM を作り直してメモリを返す（wasm のメモリは縮まない）
const RECYCLE_GROWTH = 128 * 1024 * 1024;

const BATCH_TIMEOUT_MS = 2000;
const DEPLOY_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;
const BOOT_TIMEOUT_MS = 30_000;

export class VmDown extends Error {
  constructor(kind, detail = "") {
    super(`Ruby VM ${kind}${detail ? `: ${detail}` : ""}`);
    this.name = "VmDown";
    this.kind = kind; // "timeout" | "crash" | "terminated"
  }
}

/** wasm バイナリの memory セクションに最大ページ数を書き足す。想定外の形なら元のバイト列を返す */
export function capWasmMemory(bytes, maxPages = WASM_MAX_PAGES) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return bytes;
    let p = 8;
    const readU32 = () => {
      let r = 0, s = 0, x;
      do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80 && s < 35);
      return r >>> 0;
    };
    const leb = (n) => {
      const out = [];
      do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; out.push(x); } while (n);
      return out;
    };
    while (p < b.length) {
      const sectionStart = p;
      const id = b[p++];
      const size = readU32();
      const bodyStart = p;
      if (id === 5) {
        const count = readU32();
        const flags = b[p++];
        if (count !== 1 || flags !== 0) return bytes; // 上限がすでにある / 64bit / shared は触らない
        const min = readU32();
        if (min > maxPages) return bytes;
        const body = [...leb(1), 0x01, ...leb(min), ...leb(maxPages)];
        const head = [5, ...leb(body.length)];
        const rest = b.subarray(bodyStart + size);
        const out = new Uint8Array(sectionStart + head.length + body.length + rest.length);
        out.set(b.subarray(0, sectionStart), 0);
        out.set(head, sectionStart);
        out.set(body, sectionStart + head.length);
        out.set(rest, sectionStart + head.length + body.length);
        return out;
      }
      p = bodyStart + size;
    }
    return bytes;
  } catch {
    return bytes;
  }
}

const CRATE_LIMIT = 8192; // price.js・prelude.rb の CRATE_CAP と同じ
// 1 箱の長さの上限。prelude.rb は box を超えた箱を box + 1 個で切って送る。
// pack の中で @box を書き換えると研究の box より長い箱が届くが、それは値付けで「はみ出し」として無効にする（ProtocolError にはしない）
const CRATE_LEN_LIMIT = CRATE_LIMIT;
const isIdList = (a, max) => Array.isArray(a) && a.length <= max && a.every((x) => Number.isInteger(x));
const isObj = (x) => x != null && typeof x === "object";
const cut = (x, max) => (x == null ? "" : String(x)).slice(0, max);

/**
 * Worker から返った BatchResult の形を確かめる。require "js" で Worker の中から偽の返事を送れるので、
 * 値付けの前に ProtocolError にしておく（故障票を出して前のコードに戻す流れに乗る）。
 * ok: false の返事は errClass・message・log を文字列にして長さを切る。巨大な文字列でコンソールの描画が固まらないように
 */
export function checkBatchResult(r) {
  const bad = (why) => ({
    ok: false,
    ops: 0,
    errClass: "ProtocolError",
    message: `Worker からの返事の形が違います。${why}。Yield の外から返事を書き換えるコードを外してデプロイしてください`,
    line: null,
    log: "",
  });
  if (r == null || typeof r !== "object") return bad("result がありません");
  if (r.ok !== true) {
    if (r.ok !== false) return bad("ok が true でも false でもありません");
    const fixed = {
      errClass: cut(r.errClass, 100),
      message: cut(r.message, 600),
      line: Number.isInteger(r.line) && r.line > 0 ? r.line : null,
      log: cut(r.log, 4096),
    };
    // 形が合っていれば受け取ったものをそのまま返す
    return Object.keys(fixed).every((k) => fixed[k] === r[k]) ? r : { ...r, ...fixed };
  }
  if (!(Number.isFinite(r.ops) && r.ops >= 0)) return bad("ops が数ではありません");
  if (!isIdList(r.polished, 1 << 16)) return bad("polished が整数の配列ではありません");
  if (!Array.isArray(r.crates) || r.crates.length > CRATE_LIMIT || !r.crates.every((c) => isIdList(c, CRATE_LEN_LIMIT))) {
    return bad("crates が整数の配列の配列ではありません");
  }
  if (r.crateCount != null && !(Number.isInteger(r.crateCount) && r.crateCount >= r.crates.length)) return bad("crateCount が数ではありません");
  if (r.log != null && typeof r.log !== "string") return bad("log が文字列ではありません");
  return r;
}

/** Worker 1 つ = Ruby VM 1 つ。見張りが切れたら Worker ごと捨てる。
 *  live を渡すと、生きている間だけその Set に入る（RubyRuntime#liveWorkers 用。init 中も数える） */
class VmWorker {
  constructor(live = null) {
    this.live = live;
    this.worker = new Worker(new URL("./worker.js", import.meta.url));
    live?.add(this);
    this.pending = new Map();
    this.seq = 0;
    this.dead = false;
    this.baseMem = 0;
    this.mem = 0;
    this.worker.onmessage = (ev) => {
      const rep = ev.data;
      // Worker の中のコードが勝手に postMessage したものは読まない（null だと rep.seq で落ちる）
      if (!isObj(rep)) return;
      const p = this.pending.get(rep.seq);
      if (!p) return;
      this.pending.delete(rep.seq);
      clearTimeout(p.timer);
      if (rep.mem) this.mem = rep.mem;
      if (rep.fatal) {
        const err = new VmDown("crash", rep.error);
        err.stackOverflow = !!rep.stack;
        p.reject(err);
        this._die("crash", rep.error);
        return;
      }
      if (p.type === "batch") rep.result = checkBatchResult(rep.result);
      p.resolve(rep);
    };
    this.worker.onerror = (ev) => {
      ev.preventDefault?.();
      this._die("crash", ev.message || "worker error");
    };
    this.worker.onmessageerror = () => this._die("crash", "messageerror");
  }

  static async create(module, prelude, timeoutMs, live = null) {
    const w = new VmWorker(live);
    try {
      const rep = await w.call({ type: "init", module, prelude }, timeoutMs);
      w.baseMem = rep.mem;
      w.info = rep;
      return w;
    } catch (e) {
      w.terminate();
      throw e;
    }
  }

  call(msg, timeoutMs) {
    if (this.dead) return Promise.reject(new VmDown("crash", "もう止まっています"));
    return new Promise((resolve, reject) => {
      const seq = ++this.seq;
      // 見張りは投げた瞬間から数える
      const timer = setTimeout(() => this._die("timeout"), Math.max(1, timeoutMs));
      this.pending.set(seq, { resolve, reject, timer, type: msg.type });
      this.worker.postMessage({ ...msg, seq });
    });
  }

  get grown() {
    return this.mem - this.baseMem > RECYCLE_GROWTH;
  }

  _die(kind, detail) {
    if (this.dead) return;
    this.dead = true;
    this.live?.delete(this);
    this.worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new VmDown(kind, detail));
    }
    this.pending.clear();
  }

  terminate() {
    this._die("terminated");
  }
}

const sec = (ms) => (ms / 1000).toFixed(1);

export class RubyRuntime {
  constructor({
    onStatus = () => {},
    wasmUrls = DEFAULT_WASM_URLS,
    preludeUrl = PRELUDE_URL,
    batchTimeoutMs = BATCH_TIMEOUT_MS,
    deployTimeoutMs = DEPLOY_TIMEOUT_MS,
  } = {}) {
    this.onStatus = onStatus;
    this.wasmUrls = wasmUrls;
    this.preludeUrl = preludeUrl;
    this.batchTimeoutMs = batchTimeoutMs;
    this.deployTimeoutMs = deployTimeoutMs;
    /** 生きている Worker（本番とデプロイの候補）。_boot より前に作る */
    this._live = new Set();
    /** 見張り切れ・クラッシュで VM を殺した回数（デプロイ中の新 VM を含む） */
    this.restarts = 0;
    this.lastGoodSrc = null;
    /** lastGoodSrc を読み込んだときの箱サイズ。作り直した VM でもトップレベルの box が同じ値を返すように */
    this.lastGoodBox = null;
    this.version = null;
    this.description = null;
    /** 計測値（ms）。dev/ruby-test.html と記事用 */
    this.timings = {};
    this.module = null;
    this.prelude = null;
    this.prod = null;
    this._q = Promise.resolve();
    /** デプロイの列。デプロイを 1 本ずつ流して、候補の VM を同時に 1 つまでにする */
    this._dq = Promise.resolve();
    this._recyclePending = false;
    this._epoch = 0;
    /** lastGoodSrc を読み直すと固まる（トップレベルの無限ループ）。本番 VM は素のままで、batch はすぐ失敗を返す */
    this.poisoned = false;
    this.ready = this._boot();
    this.ready.catch(() => {});
  }

  _status(s) {
    try { this.onStatus(s); } catch (e) { console.error(e); }
  }

  /** いま生きている Worker の数（本番とデプロイの候補の合計。受け入れ確認用） */
  get liveWorkers() {
    return this._live.size;
  }

  async _boot() {
    try {
      const t0 = performance.now();
      const [module, prelude] = await Promise.all([this._loadModule(), this._loadPrelude()]);
      this.module = module;
      this.prelude = prelude;
      this._status({ phase: "boot" });
      const t1 = performance.now();
      this.prod = await VmWorker.create(module, prelude, BOOT_TIMEOUT_MS, this._live);
      this.timings.firstVm = performance.now() - t1;
      this.timings.vmInWorker = this.prod.info.vmMs;
      this.timings.total = performance.now() - t0;
      this.version = this.prod.info.version;
      this.description = this.prod.info.description;
      this._status({ phase: "ready", version: this.version, description: this.description });
      return { version: this.version, description: this.description };
    } catch (e) {
      this._status({ phase: "error", message: String(e && e.message || e) });
      throw e;
    }
  }

  async _loadPrelude() {
    const resp = await fetch(this.preludeUrl);
    if (!resp.ok) throw new Error(`prelude.rb: HTTP ${resp.status}`);
    return resp.text();
  }

  async _loadModule() {
    let lastErr;
    for (const url of this.wasmUrls) {
      try {
        const t0 = performance.now();
        const bytes = await this._download(url);
        const t1 = performance.now();
        this._status({ phase: "compile" });
        const module = await WebAssembly.compile(capWasmMemory(bytes));
        this.timings.download = t1 - t0;
        this.timings.compile = performance.now() - t1;
        this.timings.wasmUrl = url;
        return module;
      } catch (e) {
        lastErr = e;
        console.warn("[ruby] wasm の読み込みに失敗", url, e);
      }
    }
    throw lastErr;
  }

  // compileStreaming は使わない。メモリ上限を書き込むためにバイト列が要る
  async _download(url) {
    this._status({ phase: "download", progress: 0, url });
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (!resp.body) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      this._status({ phase: "download", progress: 1, url });
      return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    let shown = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.byteLength;
      const progress = Math.min(1, got / WASM_BYTES);
      if (progress - shown >= 0.01 || progress === 1) {
        shown = progress;
        this._status({ phase: "download", progress, url });
      }
    }
    const out = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    if (shown < 1) this._status({ phase: "download", progress: 1, url });
    return out;
  }

  _enqueue(fn) {
    const p = this._q.then(fn, fn);
    this._q = p.catch(() => {});
    return p;
  }

  // VM の生成は遅い端末を考えて長めに待つが、コードの読み直しはデプロイと同じ見張り時間にする
  async _spawn(src) {
    const w = await VmWorker.create(this.module, this.prelude, BOOT_TIMEOUT_MS, this._live);
    if (src != null) {
      let d;
      try {
        d = await w.call({ type: "deploy", src, box: this.lastGoodBox }, this.deployTimeoutMs);
      } catch (e) {
        w.terminate();
        if (e instanceof VmDown) e.duringSrc = true;
        throw e;
      }
      if (!d.ok) console.warn("[ruby] 再起動後のデプロイに失敗", d);
    }
    return w;
  }

  // キューの中から呼ぶ。本番 VM を作り直して最後に成功したコードを読み直す
  async _restartProd(reason) {
    const epoch = this._epoch;
    this.restarts++;
    this._status({ phase: "restart", restarts: this.restarts, reason });
    this.prod?.terminate();
    this.prod = null;
    const t0 = performance.now();
    try {
      let w;
      let poisoned = false;
      try {
        w = await this._spawn(this.lastGoodSrc);
      } catch (e) {
        if (!(e instanceof VmDown && e.duringSrc && e.kind === "timeout")) throw e;
        w = await this._spawn(null);
        poisoned = true;
      }
      if (epoch !== this._epoch) {
        w.terminate();
        return;
      }
      this.prod = w;
      this.poisoned = poisoned;
      this.timings.lastRestart = performance.now() - t0;
      this._status({ phase: "ready", version: this.version, description: this.description });
    } catch (e) {
      if (epoch !== this._epoch) return;
      this._status({ phase: "error", message: String(e && e.message || e) });
    }
  }

  // キューの中から呼ぶ。本番 VM が無い・死んでいる・太りすぎなら作り直す
  async _ensureProd() {
    if (!this.prod || this.prod.dead) {
      await this._restartProd("down");
    } else if (this._recyclePending) {
      this._recyclePending = false;
      const epoch = this._epoch;
      try {
        const w = await this._spawn(this.lastGoodSrc);
        if (epoch !== this._epoch) w.terminate();
        else {
          this.prod.terminate();
          this.prod = w;
        }
      } catch (e) {
        console.warn("[ruby] VM の作り直しに失敗", e);
      }
    }
    if (!this.prod) throw new VmDown("crash", "Ruby VM を起動できません");
    return this.prod;
  }

  /** 研究で箱サイズが変わった。トップレベルで box を読んだ定数を読み直すため、次のバッチの前に VM を作り直す */
  setBox(box) {
    if (!Number.isInteger(box) || box === this.lastGoodBox) return;
    this.lastGoodBox = box;
    if (this.lastGoodSrc != null) this._recyclePending = true;
  }

  _noteMemory(w, result) {
    if (w.grown || (result && result.errClass === "NoMemoryError")) this._recyclePending = true;
  }

  /** 本番 VM で 1 バッチ。見張り 2 秒。固まったら作り直して lastGoodSrc を読み直し、TimeoutError を返す */
  batch(beltLiteral) {
    return this._enqueue(async () => {
      await this.ready;
      if (this.lastGoodSrc == null) {
        return { ok: false, ops: 0, errClass: "NotDeployed", message: "まだデプロイしていません", line: null, log: "" };
      }
      if (this.poisoned) return poisonedResult();
      return this._batchOnProd(beltLiteral, this.batchTimeoutMs);
    });
  }

  // キューの中から呼ぶ
  async _batchOnProd(lit, timeoutMs) {
    const epoch = this._epoch;
    try {
      const w = await this._ensureProd();
      const rep = await w.call({ type: "batch", lit }, timeoutMs);
      this._noteMemory(w, rep.result);
      return { ...rep.result, ms: rep.ms };
    } catch (e) {
      if (!(e instanceof VmDown)) throw e;
      // 昇格で旧 VM を止めた。新しい本番は作り直さない
      if (epoch !== this._epoch) return supersededResult();
      await this._restartProd(e.kind);
      return downResult(e, timeoutMs);
    }
  }

  /** 本番 VM で任意の式（研究の rubyProbe 用）。例外はメッセージ文字列で返す */
  probe(code) {
    return this._enqueue(async () => {
      await this.ready;
      const epoch = this._epoch;
      try {
        const w = await this._ensureProd();
        const rep = await w.call({ type: "probe", code }, PROBE_TIMEOUT_MS);
        if (!isObj(rep.result) || Array.isArray(rep.result)) {
          return { ok: false, value: null, errClass: "ProtocolError", message: "Worker からの返事の形が違います。Yield の外から返事を書き換えるコードを外してください" };
        }
        return rep.result;
      } catch (e) {
        if (!(e instanceof VmDown)) throw e;
        if (epoch === this._epoch) await this._restartProd(e.kind);
        const r = downResult(e, PROBE_TIMEOUT_MS);
        return { ok: false, value: null, errClass: r.errClass, message: r.message };
      }
    });
  }

  /** SPEC 10.4 のブルーグリーン。新 VM で src を読み、固定シードのベンチを新旧並行で取る。全体の見張り 5 秒 */
  /** opts.accept(newResults) が理由の文字列を返したら、ベンチが通っても本番にしない（stage: "bench", rejected: true） */
  deploy(src, benchLiterals = [], opts = {}) {
    const run = () => this._deploy(src, benchLiterals, opts);
    const p = this._dq.then(run, run);
    this._dq = p.catch(() => {});
    return p;
  }

  async _deploy(src, benchLiterals, { accept, box = boxOfLiteral(benchLiterals[0]) } = {}) {
    await this.ready;
    const t0 = performance.now();
    const deadline = t0 + this.deployTimeoutMs;
    const left = () => Math.max(1, deadline - performance.now());
    const timeout = (e) => (e.stackOverflow ? { ...stackResult(), stage: "timeout" } : {
      ok: false,
      stage: "timeout",
      errClass: e.kind === "timeout" ? "TimeoutError" : "VMCrash",
      message: e.kind === "timeout"
        ? `デプロイが ${sec(this.deployTimeoutMs)} 秒以内に終わりませんでした。無限ループかもしれません`
        : `新しい VM が落ちました（${e.message}）`,
      line: null,
      crashed: e.kind !== "timeout",
    });

    let cand;
    try {
      cand = await VmWorker.create(this.module, this.prelude, left(), this._live);
    } catch (e) {
      if (!(e instanceof VmDown)) throw e;
      this.restarts++;
      return timeout(e);
    }
    const tVm = performance.now();

    let d;
    try {
      d = await cand.call({ type: "deploy", src, box }, left());
    } catch (e) {
      if (!(e instanceof VmDown)) throw e;
      this.restarts++;
      return timeout(e);
    }
    if (!d.ok) {
      cand.terminate();
      // log はエラーの前までに出たトップレベルの出力
      return { ok: false, stage: "compile", errClass: d.errClass, message: d.message, line: d.line, log: d.log ?? "" };
    }

    const oldP = this.lastGoodSrc == null ? Promise.resolve(null) : this._benchOld(benchLiterals, this._epoch, deadline).catch(() => null);
    const newResults = [];
    const tBench = performance.now();
    try {
      for (const lit of benchLiterals) {
        const rep = await cand.call({ type: "batch", lit }, left());
        newResults.push({ ...rep.result, ms: rep.ms });
        if (!rep.result.ok) break;
      }
    } catch (e) {
      if (!(e instanceof VmDown)) throw e;
      cand.terminate();
      this.restarts++;
      return timeout(e);
    }
    const bad = newResults.find((r) => !r.ok);
    if (bad) {
      cand.terminate();
      return { ok: false, stage: "bench", errClass: bad.errClass, message: bad.message, line: bad.line, log: bad.log };
    }
    let reason;
    try {
      reason = accept?.(newResults);
    } catch (e) {
      // 値付けで例外が出ても候補の VM は必ず止める。止め忘れると、同時に生きている VM が 2 つを超える
      cand.terminate();
      return { ok: false, stage: "bench", errClass: "ProtocolError", message: `ベンチの結果を値付けできませんでした（${String(e?.message ?? e)}）`, line: null, log: newResults[0]?.log ?? "" };
    }
    if (reason) {
      cand.terminate();
      return { ok: false, stage: "bench", rejected: true, errClass: "InspectError", message: String(reason), line: null, log: newResults[0]?.log ?? "", newResults };
    }
    // 旧コードのベンチは並行に走っているので、ふつうは新コードと同じくらいで終わる。新コードのベンチと同じ時間
    // （最低 0.5 秒、見張りの残りまで）だけ待ち、間に合わなければ比較なし（null）。旧 VM の再起動を待たないため
    const grace = Math.min(left(), Math.max(500, performance.now() - tBench));
    let timer;
    const oldResults = await Promise.race([
      oldP,
      new Promise((r) => { timer = setTimeout(() => r(null), grace); }),
    ]);
    clearTimeout(timer);

    this._promote(cand, src, box);
    this.timings.lastDeploy = { vm: tVm - t0, total: performance.now() - t0 };
    // log はデプロイ時のトップレベルの出力（p Yield.instance_variables など）
    return { ok: true, newResults, oldResults: oldResults?.length === benchLiterals.length ? oldResults : null, log: d.log ?? "" };
  }

  _promote(w, src, box) {
    this._epoch++;
    const old = this.prod;
    this.prod = w;
    this.lastGoodSrc = src;
    this.lastGoodBox = Number.isInteger(box) ? box : this.lastGoodBox;
    this.poisoned = false;
    this._recyclePending = false;
    old?.terminate();
    this._status({ phase: "ready", version: this.version, description: this.description });
  }

  // 旧コードのベンチは本番キューに並べる。見張りは定常バッチと同じ 2 秒にする
  // （デプロイの残り時間を使うと、新 VM が遅いだけで本番を殺してしまう）。
  // 1 本でも失敗したら比べられないので打ち切る（固まるコードで再起動を 3 回積まないため）
  async _benchOld(benchLiterals, epoch, deadline) {
    const out = [];
    for (const lit of benchLiterals) {
      const r = await this._enqueue(async () => {
        if (epoch !== this._epoch || performance.now() > deadline) return null;
        if (this.poisoned) return poisonedResult();
        return this._batchOnProd(lit, this.batchTimeoutMs);
      });
      if (!r) return null;
      // 旧コードのベンチの裏口の報告は使わない（SPEC-rubyist 4.3）
      out.push({ ...r, backdoor: null });
      if (!r.ok) return null;
    }
    return out;
  }
}

function poisonedResult() {
  return {
    ok: false, ops: 0, errClass: "TimeoutError",
    message: "VM を作り直して pack.rb を読み直すと、トップレベルで固まります。無限ループかもしれません",
    line: null, log: "", poisoned: true,
  };
}

function supersededResult() {
  return { ok: false, ops: 0, errClass: "Superseded", message: "新しいコードに差し替えたので、このバッチは捨てました", line: null, log: "" };
}

/** "[3, 200000, [...]]" の先頭（箱サイズ）。読めなければ null */
function boxOfLiteral(lit) {
  const m = /^\s*\[\s*(\d+)\s*,/.exec(String(lit ?? ""));
  return m ? Number(m[1]) : null;
}

function stackResult() {
  return {
    ok: false, ops: 0, errClass: "SystemStackError",
    message: "stack level too deep。ブロックを通した再帰が深すぎて、VM ごと落ちました",
    line: null, log: "", crashed: true,
  };
}

function downResult(e, timeoutMs) {
  if (e.stackOverflow) return { ...stackResult(), restarted: true };
  if (e.kind === "timeout") {
    return {
      ok: false, ops: 0, errClass: "TimeoutError",
      message: `pack が ${sec(timeoutMs)} 秒以内に戻りませんでした。無限ループかもしれません`,
      line: null, log: "", restarted: true,
    };
  }
  return {
    ok: false, ops: 0, errClass: "VMCrash",
    message: `Ruby VM が落ちたので作り直しました（${e.message}）`,
    line: null, log: "", restarted: true, crashed: true,
  };
}
