// SPEC 11.1 の受け入れ条件 1〜7 と、SPEC-rubyist 6 章の受け入れ R1〜R11 をヘッドレス Chromium で確かめる。
// 使い方: node dev/acceptance.mjs [--only 1,4,R1,R9] [--base http://localhost:8940/ruby-factory/]
//   R8 は欠番
//   R10 は通しプレイの結果を読む: --pt-base <裏口なしの result.json> --pt-all <--backdoor の result.json>（どちらかを省くと R10 は FAIL）
//   終了コードは、選んだ項目が全部実行されて PASS のときだけ 0（未実行も FAIL）
//   既定は 1〜7 と R1〜R7・R9・R11。R10 は --pt-base と --pt-all を両方渡したときだけ既定に入る（渡さないと結果の欄に「R10: 未判定」と出す）
// 1〜3 は ?debug なしの実時間（クリック 1 回/秒、つるはしを買う）。4〜7 は準備だけ ?debug で早送りする。
// localhost だと VM が 0.2 秒で準備できてしまうので、ruby.wasm の応答を page.route で遅らせて「ロード中」を作る。
import { chromium, launchOptions } from "./pw.mjs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BELTS, RESEARCH, SAMPLE_CODE } from "../data/balance.js";


const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const BASE = opt("--base", "http://localhost:8940/ruby-factory/");
// 既定は R10 を除く（通しプレイの結果が要るため）。--pt-base と --pt-all を両方渡したときは既定にも R10 を入れる
const PT_GIVEN = args.includes("--pt-base") && args.includes("--pt-all");
const ONLY = opt("--only", `1,2,3,4,5,6,7,R1,R2,R3,R4,R5,R6,R7,R9,${PT_GIVEN ? "R10," : ""}R11`).split(",").map((x) => (/^\d+$/.test(x) ? Number(x) : x.toUpperCase()));
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "shots");
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = new Map();
const consoleErrors = [];
const evidence = (id, pass, text) => {
  const prev = results.get(id);
  const ok = (prev?.pass ?? true) && pass;
  results.set(id, { pass: ok, evidence: [prev?.evidence, text].filter(Boolean).join(" / ") });
  console.log(`[${id}] ${pass ? "PASS" : "FAIL"} ${text}`);
};

const browser = await chromium.launch(launchOptions);

async function newPage({ width = 1280, height = 800, dpr = 1, wasmDelay = 0, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: mobile, hasTouch: mobile });
  const state = { delay: wasmDelay };
  await ctx.route("**/vendor/ruby.wasm", async (route) => {
    if (state.delay) await sleep(state.delay);
    await route.continue();
  });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`${m.text()} @ ${m.location()?.url ?? ""}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    if (!/ruby\.wasm/.test(r.url()) || !/aborted/i.test(r.failure()?.errorText ?? "")) consoleErrors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  return { ctx, page, route: state };
}

const ds = (page) => page.evaluate(() => ({ ...document.body.dataset }));
const num = async (page, k) => Number((await ds(page))[k]);
const logText = (page) => page.evaluate(() => document.querySelector("#log").innerText);
const bannerText = (page) => page.evaluate(() => (document.querySelector("#banner").hidden ? "" : document.querySelector("#banner").innerText));
async function until(page, fn, { timeout = 30000, every = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(every);
  }
}
async function clickMine(page) {
  const b = await page.locator("#factory").boundingBox();
  await page.mouse.click(b.x + b.width * 0.07, b.y + b.height * 0.55);
}
async function closeCard(page) {
  if (await page.locator("#overlay").isVisible()) await page.keyboard.press("Escape");
}
async function deployUI(page, code) {
  if (code != null) await page.fill("#code", code);
  await page.click("#deploy");
  // data-deploying は 10Hz で書くので、立ち上がりを見てから終わりを待つ
  await until(page, async () => (await ds(page)).deploying === "1", { timeout: 600, every: 20 });
  await until(page, async () => (await ds(page)).deploying === "0", { timeout: 8000, every: 50 });
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name) });

const EACH_SLICE = "def pack(belt)\n  belt.each_slice(box).to_a\nend\n";

// ------------------------------------------------------------ 1〜3: 実時間、?debug なし

async function realtimeOpening(id, wasmDelay, { full }) {
  const { ctx, page } = await newPage({ wasmDelay });
  const t0 = Date.now();
  await page.goto(BASE);
  const sec = () => ((Date.now() - t0) / 1000).toFixed(1);

  let sawMoneyWhileLoading = false;
  let lockedChecks = 0;
  let lockedViolations = 0;
  let vmReadyAt = null;
  let fiveAt = null;
  let clicks = 0;
  const labels = new Set();
  // クリック 1 回/秒、つるはしは買えるだけ買う（5 本まで）
  for (;;) {
    await clickMine(page);
    clicks++;
    const d = await ds(page);
    if (Number(d.pickaxes) < 5 && (await page.locator('[data-buy="mine:pickaxe"].afford').count())) await page.click('[data-buy="mine:pickaxe"]');
    const d2 = await ds(page);
    if (d2.vm !== "ready" && Number(d2.money) > 2) sawMoneyWhileLoading = true;
    if (d2.vm === "ready" && vmReadyAt == null) vmReadyAt = sec();
    if (Number(d2.pickaxes) >= 5 && fiveAt == null) fiveAt = sec();
    const both = d2.vm === "ready" && Number(d2.pickaxes) >= 5;
    if (!both) {
      lockedChecks++;
      if (d2.deployReady === "1" || !(await page.locator("#deploy").isDisabled())) lockedViolations++;
      const label = await page.textContent("#deploy");
      if (Number(d2.pickaxes) < 5) {
        const m = /つるはし 5 本で工場が動きます。あと (\d) 本/.exec(label);
        if (!m || Number(m[1]) !== 5 - Number(d2.pickaxes)) lockedViolations++;
        else labels.add(label);
      } else {
        labels.add(label);
      }
    }
    if (both && d2.deployReady === "1") break;
    if (Date.now() - t0 > 90000) break;
    await sleep(900);
  }
  const btnBefore = await page.textContent("#deploy");
  const d = await ds(page);
  if (full) {
    evidence(1, sawMoneyWhileLoading && Number(d.money) >= 0,
      `wasm を ${wasmDelay / 1000} 秒遅らせた状態で、VM ロード中に money が増えた（${sawMoneyWhileLoading}）。クリック ${clicks} 回、つるはし 5 本が ${fiveAt}s`);
  }
  evidence(2, lockedViolations === 0, `[VM ${wasmDelay / 1000}s] VM ready ${vmReadyAt}s・つるはし 5 本 ${fiveAt}s。条件がそろうまでボタンは disabled（${lockedChecks} 回確認、違反 ${lockedViolations}）。表示: ${[...labels].join(" → ")}`);

  // 初期コードのままデプロイ
  await page.click("#deploy");
  const banner = await until(page, () => bannerText(page), { timeout: 8000 });
  const head = banner?.split("\n")[0] ?? "";
  const bannerOk = /^1 鉱石あたり \$1\.0 → \$(4\.[89]|5\.[01])（(4\.9\d|5\.0\d)x）$/.test(head);
  const dockRed = await until(page, async () => (await ds(page)).bottleneck === "dock", { timeout: 3000 });
  evidence(2, bannerOk && !!dockRed, `[VM ${wasmDelay / 1000}s] ${sec()}s にデプロイ。バナー「${head}」、直後の bottleneck=${(await ds(page)).bottleneck}（ボタンは直前まで「${btnBefore}」）`);
  if (full) await shot(page, "i-first-deploy.png");

  if (full) {
    // $50 で定量梱包 I → each_slice
    const rich = await until(page, async () => {
      await clickMine(page);
      return (await num(page, "money")) >= 50;
    }, { timeout: 60000, every: 1000 });
    await page.click('[data-research="crate"]');
    await sleep(600);
    await shot(page, "i-research-card.png");
    await closeCard(page);
    const box = await num(page, "box");
    await deployUI(page, EACH_SLICE);
    const settled = await until(page, async () => {
      const x = await ds(page);
      return Number(x.valuePerOre) > 12 && Number(x.valuePerOre) < 18 && x.bottleneck !== "dock" ? x : null;
    }, { timeout: 5000 });
    const b2 = (await bannerText(page)).split("\n")[0];
    evidence(3, !!rich && box === 3 && !!settled,
      `${sec()}s: $50 で crate を研究（box=${box}）→ each_slice をデプロイ。バナー「${b2}」、単価 ${Number(settled?.valuePerOre ?? NaN).toFixed(2)}、bottleneck=${settled?.bottleneck}（ドックの赤が消えた）`);
    await sleep(1500);
    await shot(page, "i-each-slice.png");
  }
  await ctx.close();
}

// ------------------------------------------------------------ 4〜6 の準備: ?debug で each_slice まで進める

async function preparedPage(opts = {}) {
  const p = await newPage(opts);
  await p.page.goto(BASE + "?debug");
  await until(p.page, async () => (await ds(p.page)).vm === "ready", { timeout: 30000 });
  await p.page.evaluate(async () => {
    const yf = window.__yf;
    yf.addMoney(200);
    for (let i = 0; i < 4; i++) yf.buy("mine", "pickaxe");
    await yf.deploy();
    yf.buy("research", "crate");
  });
  await closeCard(p.page);
  await deployUI(p.page, EACH_SLICE);
  return p;
}

async function test4(page) {
  for (const [name, code] of [
    ["loop {}", "def pack(belt)\n  loop {}\nend\n"],
    ["while true; end", "def pack(belt)\n  while true; end\nend\n"],
  ]) {
    const m0 = await num(page, "money");
    const logLen = (await logText(page)).length;
    const t0 = Date.now();
    await page.fill("#code", code);
    await page.click("#deploy");
    let midMoney = null;
    let status = new Set();
    const resumed = await until(page, async () => {
      const d = await ds(page);
      status.add(d.refinery);
      if (Date.now() - t0 > 2500 && midMoney == null) midMoney = Number(d.money);
      return (await logText(page)).slice(logLen).includes("前のコードで再開しました");
    }, { timeout: 7000, every: 50 });
    const ms = Date.now() - t0;
    if (name === "loop {}") await shot(page, "i-restarting.png");
    const m1 = await num(page, "money");
    const good = await page.evaluate(() => window.__yf.state.lastGoodCode);
    evidence(4, !!resumed && ms <= 5000 && midMoney > m0 && m1 > midMoney && good.includes("each_slice"),
      `${name}: ${ms}ms で「前のコードで再開しました」。money ${m0.toFixed(0)} → ${midMoney?.toFixed(0)}（2.5 秒時点）→ ${m1.toFixed(0)}、動いているコードは each_slice のまま`);
    await sleep(2200);
  }
  const code = "def pack(belt)\n  begin\n    loop { belt.sum(&:carat) }\n  rescue => e\n    []\n  end\nend\n";
  const logLen = (await logText(page)).length;
  await page.fill("#code", code);
  await page.click("#deploy");
  const over = await until(page, async () => (await ds(page)).refinery === "overheat", { timeout: 5000, every: 50 });
  await sleep(300);
  await shot(page, "i-overheat.png");
  const lt = (await logText(page)).slice(logLen);
  const good = await page.evaluate(() => window.__yf.state.lastGoodCode);
  evidence(4, !!over && /Yield::Overheat/.test(lt) && good.includes("each_slice"),
    `rescue => e で囲んだ loop { belt.sum(&:carat) }: 工場=overheat、ログ「${lt.split("\n").find((l) => /Overheat/.test(l))}」、デプロイされず each_slice で稼働`);
  await sleep(1000);

  // ベンチは通るが定常バッチで例外を出すコード → 10 秒に 3 回で前のコードに戻す（SPEC 10.5）
  const flaky = "def pack(belt)\n  $n = ($n || 0) + 1\n  raise ArgumentError, \"boom\" if $n > 3\n  belt.each_slice(box).to_a\nend\n";
  const len2 = (await logText(page)).length;
  await deployUI(page, flaky);
  const t0 = Date.now();
  const reverted = await until(page, async () => (await logText(page)).slice(len2).includes("前のコードに戻しました"), { timeout: 15000 });
  const back = await until(page, async () => {
    const c = await page.evaluate(() => window.__yf.state.lastGoodCode);
    return !c.includes("boom") ? c : null;
  }, { timeout: 8000 });
  evidence(4, !!reverted && !!back, `（追加）定常バッチで ArgumentError を出すコード: ${((Date.now() - t0) / 1000).toFixed(1)} 秒で「前のコードに戻しました」、lastGoodCode は each_slice に戻った`);
  await sleep(500);

  // ベンチ（固定シード 1〜3）だけ通り、定常バッチで固まるコード → 見張り 2 秒で VM 作り直し、3 回で前のコードへ
  const benchOnly = "BENCH = [[1, 9, 7, 5, 4, 5], [3, 8, 4, 8, 8, 7], [1, 7, 2, 2, 5, 3]]\ndef pack(belt)\n  loop {} unless BENCH.include?(belt.first(6).map(&:carat))\n  belt.each_slice(box).to_a\nend\n";
  const len3 = (await logText(page)).length;
  await deployUI(page, benchOnly);
  const m0 = await num(page, "money");
  const t1 = Date.now();
  const sawRestart = new Set();
  const reverted2 = await until(page, async () => {
    sawRestart.add((await ds(page)).refinery);
    return (await logText(page)).slice(len3).includes("前のコードに戻しました");
  }, { timeout: 20000, every: 100 });
  const lt3 = (await logText(page)).slice(len3);
  const timeouts = (lt3.match(/TimeoutError: pack が 2\.0 秒以内に戻りませんでした/g) ?? []).length;
  await until(page, async () => !(await page.evaluate(() => window.__yf.state.lastGoodCode)).includes("BENCH"), { timeout: 8000 });
  const m1 = await num(page, "money");
  await shot(page, "i-batch-timeout.png");
  evidence(4, !!reverted2 && timeouts >= 3 && sawRestart.has("restarting") && m1 > m0,
    `（追加）定常バッチだけ固まるコード: TimeoutError ${timeouts} 回（毎回「VM を作り直して再開」、工場=restarting を観測）→ ${((Date.now() - t1) / 1000).toFixed(1)} 秒で前のコードに戻した。その間 money ${m0.toFixed(0)} → ${m1.toFixed(0)}`);
  await sleep(500);
}

async function test5(page) {
  const before = await num(page, "valuePerOre");
  let logLen = (await logText(page)).length;
  await deployUI(page, "def pack(belt)\n  [belt.first(3)] * 1000\nend\n");
  await sleep(400);
  const v = await num(page, "valuePerOre");
  const lt = (await logText(page)).slice(logLen);
  const diff = lt.split("\n").find((l) => /id 0, 1, 2 が 1000 回出荷されています。複製は無効です/.test(l));
  const st = (await ds(page)).refinery;
  await shot(page, "i-inspect.png");
  evidence(5, !!diff && v < before * 0.05 && st === "inspect-error",
    `[belt.first(3)] * 1000: 単価 ${before.toFixed(2)} → ${v.toFixed(3)}、工場=${st}、ログ「${diff}」`);
  await page.click("#revert");
  await until(page, async () => (await num(page, "valuePerOre")) > before * 0.8, { timeout: 6000 });

  logLen = (await logText(page)).length;
  const b0 = await num(page, "valuePerOre");
  await deployUI(page, "def pack(belt)\n  belt.each_slice(box).map { |c| c.map { it.with(carat: 99) } }\nend\n");
  await sleep(300);
  const b = (await bannerText(page)).split("\n");
  const v2 = await num(page, "valuePerOre");
  const lt2 = (await logText(page)).slice(logLen);
  const note = lt2.split("\n").find((l) => /with で作った Ore/.test(l));
  const opsLine = b.find((l) => /new:/.test(l)) ?? "";
  evidence(5, v2 <= b0 * 1.05 && /鑑定 3\.00 回/.test(opsLine) && !!note,
    `it.with(carat: 99): 単価 ${b0.toFixed(2)} → ${v2.toFixed(2)}（上がらない）、バナー「${b[0]}」「${opsLine.trim()}」、ログに説明行「${note?.slice(0, 40)}…」（priceBatch の差分ではなく main の説明）`);
  await page.click("#revert");
  await until(page, async () => (await ds(page)).deploying === "0", { timeout: 6000 });
  await sleep(500);
}

async function test6(p) {
  const { page, route } = p;
  const marker = "# reload-check\n" + EACH_SLICE;
  await page.fill("#code", marker);
  await page.evaluate(() => window.__yf.save());
  const saved = await page.evaluate(() => ({ ...window.__yf.state, lastCrates: window.__yf.state.lastCrates.length }));
  route.delay = 10000;
  await page.reload();
  await sleep(500);
  const d0 = await ds(page);
  const code = await page.inputValue("#code");
  await sleep(3000);
  const d1 = await ds(page);
  await shot(page, "i-reload-before-vm.png");
  const restoredOk = d0.deployed === "1" && code === marker && d0.research === saved.research.join(",") &&
    Math.abs(Number(d0.valuePerOre) - saved.ema.valuePerOre) < 1e-9 && Number(d0.money) >= saved.money * 0.99;
  const runningOk = d0.vm !== "ready" && d1.vm !== "ready" && Number(d1.money) > Number(d0.money) && d1.refinery === "running";
  evidence(6, restoredOk && runningOk,
    `リロード（wasm 10 秒遅延）: money $${saved.money.toFixed(0)} → 復帰直後 $${Number(d0.money).toFixed(0)} → 3 秒後 $${Number(d1.money).toFixed(0)}（vm=${d1.vm}、工場=${d1.refinery}）、研究「${d0.research}」、単価 ${Number(d0.valuePerOre).toFixed(2)} はセーブ値と一致、エディタのコードも一致`);
  const redeploy = await until(page, async () => (await logText(page)).includes("前回のコードを入れ直しました"), { timeout: 20000 });
  const bannerHidden = (await bannerText(page)) === "";
  evidence(6, !!redeploy && bannerHidden, `VM ready 後に lastGoodCode を黙って再デプロイ（バナーなし: ${bannerHidden}）`);
  route.delay = 0;
}

// ------------------------------------------------------------ 7: 375px

async function test7() {
  const { ctx, page } = await newPage({ width: 375, height: 812, dpr: 3, mobile: true });
  await page.goto(BASE + "?debug");
  const overflow = async (where) => {
    const w = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
    if (w > 375) evidence(7, false, `${where}: 横スクロール（scrollWidth=${w}）`);
    return w;
  };
  const tap = (sel) => page.locator(sel).first().tap();
  // コードタブのボタンは指と同じ入力で押す。locator.tap は overflow:hidden の枠でもプログラムでスクロールしてから押すので、
  // 枠に切られて指では届かないボタンでも通ってしまう。見えていなければ .work をホイールでスクロールして探す
  const fingerTap = async (sel) => {
    const probe = () => page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const e = y > 0 && y < innerHeight ? document.elementFromPoint(x, y) : null;
      return { x, y, hit: !!e && (e === el || el.contains(e)), at: e?.className ?? null };
    }, sel);
    let p = await probe();
    for (let i = 0; i < 8 && !p.hit; i++) {
      const wb = await page.locator(".work").boundingBox();
      await page.mouse.move(wb.x + wb.width / 2, wb.y + Math.min(wb.height / 2, 120));
      await page.mouse.wheel(0, p.y > 0 ? 150 : -150);
      await sleep(120);
      p = await probe();
    }
    if (!p.hit) {
      evidence(7, false, `${sel} が指で押せない（中心の要素: ${p.at}）`);
      return false;
    }
    await page.touchscreen.tap(p.x, p.y);
    return true;
  };
  const firstDeployVisible = async () => page.evaluate(() => {
    const el = document.querySelector("#deploy");
    const b = el.getBoundingClientRect();
    const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!e && (e === el || el.contains(e));
  });
  const tab = async (name) => {
    await tap(`.tab[data-tab="${name}"]`);
    await sleep(150);
  };
  await until(page, async () => (await ds(page)).vm === "ready", { timeout: 30000 });
  for (let i = 0; i < 3; i++) {
    const b = await page.locator("#factory").boundingBox();
    await page.touchscreen.tap(b.x + b.width * 0.07, b.y + b.height * 0.55);
    await sleep(120);
  }
  const clicked = await num(page, "money");
  await shot(page, "m-i-code.png");
  await overflow("コードタブ");
  await page.evaluate(() => window.__yf.addMoney(60));
  await tab("shop");
  for (let i = 0; i < 4; i++) await tap('[data-buy="mine:pickaxe"]');
  await shot(page, "m-i-shop.png");
  await overflow("ショップタブ");
  await tab("code");
  const visibleAtOpen = await firstDeployVisible();
  if (!visibleAtOpen) evidence(7, false, "コードタブを開いた時点でデプロイボタンが見えていない");
  await fingerTap("#deploy");
  await until(page, async () => (await ds(page)).deployed === "1", { timeout: 8000 });
  await sleep(600);
  await shot(page, "m-i-deployed.png");

  const steps = [];
  const research = async (key) => {
    await tab("research");
    await tap(`[data-research="${key}"]`);
    await sleep(250);
    const ok = (await ds(page)).research.split(",").includes(key);
    steps.push(`${key}${ok ? "" : "(失敗)"}`);
    return ok;
  };
  const deployHint3 = async () => {
    // 研究カードのヒント 3 → エディタに入れる → コードタブでデプロイ
    await page.getByText("ヒント 3: 完成コード").tap();
    await page.getByText("エディタに入れる").tap();
    await tab("code");
    await fingerTap("#deploy");
    await until(page, async () => (await ds(page)).deploying === "0", { timeout: 8000 });
    await sleep(300);
  };
  const money = (n) => page.evaluate((n) => window.__yf.addMoney(n), n);
  const costOf = (key) => RESEARCH.find((r) => r.key === key).price;
  const recordOf = (key) => RESEARCH.find((r) => r.key === key).requires.record;

  await money(50);
  await research("crate");
  await shot(page, "m-i-research-card.png");
  await closeCard(page);
  await tab("research");
  await shot(page, "m-i-research.png");
  await overflow("研究タブ");
  await tab("code");
  await fingerTap("#solution");
  await fingerTap("#deploy");
  await until(page, async () => Number((await ds(page)).valuePerOre) > 12, { timeout: 8000 });
  for (const [key, price] of [["inspector", 400], ["sorter", 150e3], ["sapphire", 300e3], ["monochrome", 20e6], ["crate_5", 250e6]]) {
    await money(price);
    await research(key);
    await closeCard(page);
  }
  await tab("code");
  await fingerTap("#solution");
  await fingerTap("#deploy");
  await until(page, async () => Number((await ds(page)).record) >= recordOf("straight"), { timeout: 10000 });
  await money(costOf("straight"));
  await research("straight");
  await deployHint3();
  for (const key of ["christmas", "polish", "emerald"]) {
    await money(costOf(key));
    await research(key);
    if (key === "christmas" || key === "polish") await deployHint3();
    else await closeCard(page);
  }
  await money(costOf("ractor"));
  await research("ractor");
  await sleep(2500);
  await shot(page, "m-i-ractor.png");
  const probeText = await page.locator(".card-code.probe").innerText();
  await closeCard(page);
  await until(page, async () => Number((await ds(page)).record) >= recordOf("crate_7"), { timeout: 15000 });
  await money(costOf("crate_7"));
  await research("crate_7");
  await closeCard(page);
  await until(page, async () => Number((await ds(page)).record) >= recordOf("crate_9"), { timeout: 15000 });
  await money(costOf("yjit"));
  await research("yjit");
  await closeCard(page);
  await money(costOf("crate_9"));
  await research("crate_9");
  await closeCard(page);
  await money(costOf("release"));
  await research("release");
  await sleep(800);
  await shot(page, "m-i-ending.png");
  await overflow("エンディング");
  const ending = await page.locator(".card.ending").isVisible();
  const head = ending ? await page.locator(".ending-head").innerText() : "";
  await closeCard(page);
  await tab("code");
  await sleep(500);
  await shot(page, "m-i-after.png");
  const w = await overflow("最後");
  const d = await ds(page);
  evidence(7, ending && d.research.split(",").length === RESEARCH.length && clicked > 0,
    `375px（DPR 3、タッチ）: 鉱山タップで $${clicked.toFixed(0)}、タブ切替でつるはし購入→デプロイ（ボタンは指タップ、開いた時点で見えている: ${visibleAtOpen}）→研究 ${RESEARCH.length} 件（${steps.join(" ")}）→エンディング「${head}」。Ractor のカードは「${probeText.split("\n")[1]}」。scrollWidth=${w}`);
  await ctx.close();
}

// ------------------------------------------------------------ R1〜R11: SPEC-rubyist 6 章（裏口ノート・監査）

const PRICE = Object.fromEntries(RESEARCH.map((r) => [r.key, r.price]));
const STAGE_CODE = { crate: SAMPLE_CODE.eachSlice, inspector: SAMPLE_CODE.reject, sorter: SAMPLE_CODE.sortBy, monochrome: SAMPLE_CODE.groupBy, straight: SAMPLE_CODE.straightChunk, christmas: SAMPLE_CODE.christmas, polish: SAMPLE_CODE.polishHoles };
const BIND_SORT = "R = ->(o, a) { Ore.instance_method(a).super_method.bind_call(o) }\ndef pack(belt)\n  belt.reject { R.(it, :flaw) }.sort_by { R.(it, :carat) }.each_slice(box).to_a\nend\n";
const RUBYIST = {};

async function rubyPage(opts = {}) {
  const p = await newPage(opts);
  await p.page.goto(BASE + "?debug");
  await until(p.page, async () => (await ds(p.page)).vm === "ready", { timeout: 30000 });
  await p.page.evaluate(async () => {
    const yf = window.__yf;
    yf.addMoney(200);
    for (let i = 0; i < 4; i++) yf.buy("mine", "pickaxe");
    await yf.deploy();
  });
  return p;
}
const yfDeploy = (page, code) => page.evaluate(async (c) => {
  const r = await window.__yf.deploy(c);
  return { ok: !!r?.ok, stage: r?.stage ?? null, errClass: r?.errClass ?? null, message: r?.message ?? null };
}, code);
/** 本番の定常バッチを n 本、待たずに回す（__yf.batch を押し続けて、受け取った回数を数える） */
const batches = (page, n) => page.evaluate(async (n) => {
  const yf = window.__yf;
  const start = yf.batches;
  const t0 = performance.now();
  while (yf.batches < start + n && performance.now() - t0 < 30000) {
    yf.batch();
    await new Promise((r) => setTimeout(r, 25));
  }
  return yf.batches - start;
}, n);
async function research(page, key) {
  for (let tries = 0; tries < 60; tries++) {
    const ok = await page.evaluate(([k, price]) => {
      const yf = window.__yf;
      if (yf.state.research.includes(k)) return true;
      if (yf.state.money < price) yf.addMoney(price - yf.state.money + 1);
      yf.buy("research", k);
      return yf.state.research.includes(k);
    }, [key, PRICE[key]]);
    if (ok) break;
    await batches(page, 2); // 単価記録の関門。いまのコードでバッチを回して記録を伸ばす
  }
  if (key !== "release") await closeCard(page);
  return (await ds(page)).research.split(",").includes(key);
}
/** key まで研究を進める。研究ごとにその研究のコード（SAMPLE_CODE）をデプロイする */
async function progressTo(page, key, { code = true } = {}) {
  for (const r of RESEARCH) {
    const have = (await ds(page)).research.split(",").includes(r.key);
    if (!have) {
      if (!(await research(page, r.key))) throw new Error(`研究 ${r.key} を買えませんでした`);
      if (code && STAGE_CODE[r.key]) await yfDeploy(page, STAGE_CODE[r.key]);
    }
    if (r.key === key) break;
  }
  await sleep(200);
}
const yfGet = (page, fn, arg) => page.evaluate(fn, arg);

RUBYIST.R1 = async () => {
  const { ctx, page } = await rubyPage();
  await progressTo(page, "sorter");
  const len = (await logText(page)).length;
  const res = await yfDeploy(page, BIND_SORT);
  await sleep(250);
  await shot(page, "r1-audit.png");
  const lt = (await logText(page)).slice(len);
  const head = (await bannerText(page)).split("\n")[0];
  const a = await yfGet(page, () => {
    const yf = window.__yf;
    return { la: yf.lastAudit, caps: yf.flow.caps, nb: yf.notebook, stamps: yf.stamps, audited: yf.viewModel.audited, audits: yf.state.audits, ema: { ...yf.state.ema } };
  });
  const warn = lt.split("\n").find((l) => /warning: 鑑定 [\d.]+ 回\/鉱石にしては/.test(l)) ?? "";
  const tech = lt.split("\n").find((l) => /使った技:/.test(l)) ?? "";
  const ok = res.ok && /warning: 鑑定 [\d.]+ 回\/鉱石にしては/.test(lt) && /使った技: bind_call/.test(lt) && /鑑定長「bind_call ですか。/.test(lt) && a.stamps.includes("AUDITED") && a.audited
    && a.la.caught && a.la.measuredPerOre === 0 && Number.isFinite(a.caps.refinery) && a.caps.refinery > 0
    // ラインは約 1.1 回/鉱石（正攻法の reject + sort_by は約 1.75 回。追補 3.2）
    && a.la.floorPerOre > 0.9 && a.la.floorPerOre < 1.3 && a.ema.opsPerOre >= a.ema.floorPerOre - 1e-9 && a.nb.includes("audit") && a.audits === 1;
  evidence("R1", ok, `sort_by を bind_call で読む版: バナー「${head}」、ログ「${warn}」「${tech.trim()}」、判子 ${JSON.stringify(a.stamps)}、常設判子 audited=${a.audited}。実測 ${a.la.measuredPerOre} 回/鉱石、監査ライン ${a.la.floorPerOre.toFixed(3)}、caps.refinery=${a.caps.refinery.toFixed(1)}（有限）、ema.opsPerOre=${a.ema.opsPerOre.toFixed(3)}、notebook=${JSON.stringify(a.nb)}、audits=${a.audits}`);
  // 診断カードの鑑定の下限の行
  await page.evaluate(() => document.querySelector('.shop-group[data-stage="refinery"] .shop-head')?.click());
  await sleep(300);
  const diag = await page.evaluate(() => document.querySelector(".card.diag")?.innerText ?? "");
  await shot(page, "r1-diag.png");
  evidence("R1", /鑑定の下限 \d+\.\d\d 回\/鉱石。理論上ここまで減らせます/.test(diag), `診断カード（工場）に「${diag.split("\n").find((l) => /鑑定の下限/.test(l)) ?? "（なし）"}」`);
  await closeCard(page);
  await ctx.close();
};

RUBYIST.R2 = async () => {
  const { ctx, page } = await rubyPage();
  const plan = [
    ["crate", ["eachSlice"]], ["inspector", ["reject", "rejectPattern"]], ["sorter", ["sortBlock", "sortBy"]],
    ["monochrome", ["groupBy"]], ["crate_5", ["groupBy"]], ["straight", ["straightChunk", "straightCons", "straightAll"]],
    ["christmas", ["straightCons", "christmas", "christmasGifts"]], ["polish", ["polishChunk", "polishCons", "polishHoles"]], ["crate_9", ["straightChunk", "straightCons", "straightAll", "polishChunk", "polishCons", "polishHoles"]],
  ];
  const rows = [];
  let bad = 0;
  for (const [stage, names] of plan) {
    await progressTo(page, stage);
    for (const name of names) {
      const len = (await logText(page)).length;
      const d = await yfDeploy(page, SAMPLE_CODE[name]);
      let caught = 0;
      let minRatio = Infinity;
      let n = 0;
      for (let i = 0; i < 20; i++) {
        n += await batches(page, 1);
        const la = await yfGet(page, () => window.__yf.lastAudit);
        if (la?.caught) caught++;
        if (la?.floorPerOre > 0) minRatio = Math.min(minRatio, la.measuredPerOre / la.floorPerOre);
      }
      const lt = (await logText(page)).slice(len);
      const reported = /warning: 鑑定 [\d.]+ 回\/鉱石にしては/.test(lt);
      if (!d.ok || caught || reported || n < 20) bad++;
      rows.push(`${stage}/${name}: ${n} 本、caught ${caught}、報告 ${reported ? "あり" : "なし"}、実測÷ライン 最小 ${Number.isFinite(minRatio) ? minRatio.toFixed(2) : "ライン 0"}`);
    }
  }
  const audits = await yfGet(page, () => window.__yf.state.audits);
  evidence("R2", bad === 0 && audits === 0, `SAMPLE_CODE を研究ごとに 20 バッチずつ（state.audits=${audits}）: ${rows.join(" / ")}`);
  await ctx.close();
};

RUBYIST.R3 = async () => {
  const { ctx, page } = await rubyPage();
  await progressTo(page, "polish");
  const code = SAMPLE_CODE.polishCons.replace("it.flaw ? it.polish : it", "it.flaw ? (Yield.polished(it.id); it) : it");
  if (code === SAMPLE_CODE.polishCons) throw new Error("研磨の踏み倒し版を作れませんでした");
  const d = await yfDeploy(page, code);
  await batches(page, 3);
  const a = await yfGet(page, () => ({ la: window.__yf.lastAudit, ema: { ...window.__yf.state.ema } }));
  const au = a.la.audit;
  // 研磨機の発熱: 出荷された研磨済み k 個から 1 + 2 + … + k を下限に足す。熱を払わない直呼びは捕まる
  const tri = (au.polishShipped * (au.polishShipped + 1)) / 2;
  const ok1 = d.ok && au.polishShipped > 0 && au.polishOps === tri && au.floorOps >= tri && a.la.opsPerOre >= au.floorPerOre - 1e-9 && a.ema.opsPerOre >= a.ema.floorPerOre - 1e-9 && a.la.caught;
  evidence("R3", ok1, `Yield.polished の直呼び（each_cons 版）: 出荷された研磨済み ${au.polishShipped} 個で 1 + 2 + … + ${au.polishShipped} = ${tri} ≤ floorOps ${au.floorOps.toFixed(1)}、工場の計算に使う鑑定 ${a.la.opsPerOre.toFixed(3)} ≥ ライン ${au.floorPerOre.toFixed(3)} 回/鉱石（実測 ${a.la.measuredOpsPerOre.toFixed(3)}、報告 ${a.la.caught ? "あり" : "なし"}）`);
  const tick = "def Yield.tick(*) = nil\ndef pack(belt)\n  belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a\nend\n";
  const d2 = await yfDeploy(page, tick);
  await batches(page, 2);
  const b = await yfGet(page, () => ({ caps: window.__yf.flow.caps, nb: window.__yf.notebook, la: window.__yf.lastAudit, ach: window.__yf.state.achievements }));
  evidence("R3", d2.ok && Number.isFinite(b.caps.refinery) && b.nb.includes("monkeypatch") && b.la.measuredPerOre === 0,
    `def Yield.tick(*) = nil + sort_by: 実測 ${b.la.measuredPerOre}、ライン ${b.la.floorPerOre.toFixed(3)}、caps.refinery=${b.caps.refinery.toFixed(0)}（Infinity でない）、notebook=${JSON.stringify(b.nb)}、実績 monkeypatcher=${b.ach.includes("monkeypatcher")}`);
  await ctx.close();
};

RUBYIST.R4 = async () => {
  const { ctx, page } = await rubyPage();
  const len = (await logText(page)).length;
  const d = await yfDeploy(page, "p Yield.instance_variables\nputs Yield.instance_variable_get(:@memo)\ndef pack(belt)\n  belt.map { [it] }\nend\n");
  await sleep(200);
  const lt = (await logText(page)).slice(len);
  const nb = await yfGet(page, () => window.__yf.notebook);
  const count = await page.evaluate(() => document.querySelector("#notebook .nb-count")?.textContent);
  await page.evaluate(() => { const g = document.querySelector("#gemfile"); g.scrollTop = g.scrollHeight; });
  await shot(page, "r4-memo.png");
  const ivars = lt.split("\n").find((l) => /\[:@ops, :@limit/.test(l)) ?? "";
  const memo = lt.split("\n").find((l) => /合鍵は名前を付けずにしまった/.test(l)) ?? "";
  evidence("R4", d.ok && !!ivars && !!memo && nb.length === 1 && nb[0] === "memo" && count === "1/6",
    `トップレベルの p / puts: ログ「${ivars.trim()}」「${memo.trim()}」、notebook=${JSON.stringify(nb)}、ノートの表示 ${count}`);
  await ctx.close();
};

RUBYIST.R5 = async () => {
  const p = await rubyPage();
  const { ctx, page, route } = p;
  const each = "def pack(belt)\n  belt.each_slice(box).to_a\nend\n";
  await page.evaluate(() => { const yf = window.__yf; yf.addMoney(1e5); yf.buy("belt"); yf.buy("belt"); });
  await sleep(300); // flow は 10Hz の logicTick で読み直す
  const tier = await yfGet(page, () => window.__yf.state.belt);
  let len = (await logText(page)).length;
  const c0 = await yfGet(page, () => window.__yf.flow.caps.belt);
  await yfDeploy(page, "Yield.instance_variable_set(:@lanes, 2)\n" + each);
  await sleep(200);
  const c1 = await yfGet(page, () => window.__yf.flow.caps.belt);
  const l1 = (await logText(page)).slice(len).split("\n").find((l) => /2 車線にできるのは無限ベルトだけだ/.test(l)) ?? "";
  evidence("R5", tier === 2 && c0 === 200 && c1 === 200 && !!l1, `青ベルト（tier ${tier}）で @lanes = 2: caps.belt ${c0} → ${c1}（変わらない）、ログ「${l1.trim()}」`);
  await page.evaluate(() => { const yf = window.__yf; yf.addMoney(3e10); for (let i = 0; i < 8; i++) yf.buy("belt"); });
  await sleep(200);
  const c2 = await yfGet(page, () => ({ belt: window.__yf.flow.caps.belt, tier: window.__yf.state.belt, nb: window.__yf.notebook }));
  len = (await logText(page)).length;
  await yfDeploy(page, "Yield.instance_variable_set(:@lanes, 3)\n" + each);
  await sleep(200);
  const c3 = await yfGet(page, () => ({ belt: window.__yf.flow.caps.belt, ach: window.__yf.state.achievements, vm: window.__yf.viewModel.lanes }));
  const l3 = (await logText(page)).slice(len).split("\n").find((l) => /床が抜ける。2 車線にしておいたぞ/.test(l)) ?? "";
  await shot(page, "r5-lanes.png");
  evidence("R5", c2.tier === BELTS.length - 1 && c2.belt === 40_000_000 && c2.nb.includes("lanes") && c3.belt === 40_000_000 && !!l3 && c3.ach.includes("floor"),
    `無限ベルトにすると caps.belt=${c2.belt}、@lanes = 3 で ${c3.belt}・ログ「${l3.trim()}」・実績「床は抜けませんでした」=${c3.ach.includes("floor")}、ViewModel.lanes=${c3.vm}`);
  await page.evaluate(() => window.__yf.save());
  route.delay = 10000;
  await page.reload();
  await sleep(800);
  const r = await yfGet(page, () => ({ vm: document.body.dataset.vm, belt: window.__yf.flow.caps.belt, bd: window.__yf.backdoor }));
  evidence("R5", r.vm !== "ready" && r.belt === 40_000_000, `リロード（wasm 10 秒遅延）: vm=${r.vm} の時点で caps.belt=${r.belt}（state.backdoor=${JSON.stringify(r.bd)}）`);
  route.delay = 0;
  await ctx.close();
};

RUBYIST.R6 = async () => {
  const { ctx, page } = await rubyPage();
  const each = "def pack(belt)\n  belt.each_slice(box).to_a\nend\n";
  await page.evaluate(() => { const yf = window.__yf; yf.addMoney(2e11); yf.buy("mine", "planet"); yf.buy("mine", "planet"); yf.buy("dock", "elevator"); yf.buy("dock", "elevator"); });
  await sleep(300);
  const u = () => yfGet(page, () => ({ planet: window.__yf.unitRate("mine", "planet"), elevator: window.__yf.unitRate("dock", "elevator"), mine: window.__yf.flow.caps.mine, nb: window.__yf.notebook, night: window.__yf.viewModel.nightShift, owned: [window.__yf.state.mines.planet, window.__yf.state.docks.elevator] }));
  const u0 = await u();
  await yfDeploy(page, "Yield.instance_variable_set(:@night, true)\n" + each);
  await batches(page, 1);
  const u1 = await u();
  evidence("R6", u1.planet === 1_000_000 && u1.elevator === 250_000 && u1.mine === u0.mine && !u1.nb.includes("keyring"),
    `@night = true（ivar）: 惑星コア 1 台 ${u1.planet}、軌道エレベータ 1 台 ${u1.elevator}、caps.mine ${u0.mine} → ${u1.mine}（変わらない）`);
  const len = (await logText(page)).length;
  await yfDeploy(page, "k = ObjectSpace.each_object(Class).find { it.name.nil? && it.method_defined?(:turn) }\nputs ObjectSpace.each_object(k).first.turn\n" + each);
  await batches(page, 1);
  await sleep(300);
  const u2 = await u();
  const turn = (await logText(page)).slice(len).split("\n").find((l) => /カチャ/.test(l)) ?? "";
  await shot(page, "r6-night.png");
  evidence("R6", u2.planet === 1_500_000 && u2.elevator === 375_000 && u2.nb.includes("keyring") && u2.night && u2.mine - u1.mine === u2.owned[0] * 500_000,
    `ObjectSpace で合鍵: ログ「${turn.trim()}」、惑星コア 1 台 ${u2.planet}、軌道エレベータ 1 台 ${u2.elevator}、caps.mine ${u1.mine} → ${u2.mine}、notebook=${JSON.stringify(u2.nb)}、夜間ラインの絵=${u2.night}`);
  await ctx.close();
};

RUBYIST.R7 = async () => {
  const { ctx, page } = await rubyPage();
  const each = "def pack(belt)\n  belt.each_slice(box).to_a\nend\n";
  await yfDeploy(page, each);
  const b0 = await yfGet(page, () => window.__yf.batches);
  const f = await yfDeploy(page, "def pack(belt)\n  Yield.foo\n  belt.each_slice(box).to_a\nend\n");
  await sleep(200);
  const ticket = await page.evaluate(() => document.querySelector("#ticket")?.innerText ?? "");
  await shot(page, "r7-foo.png");
  await sleep(3500);
  const s = await yfGet(page, () => ({ good: window.__yf.state.lastGoodCode, batches: window.__yf.batches, ref: document.body.dataset.refinery }));
  evidence("R7", !f.ok && /工場長の声/.test(ticket) && s.good === each && s.batches > b0,
    `Yield.foo: デプロイ中止（${f.stage} / ${f.errClass}）、故障票「${ticket.replace(/\s+/g, " ").slice(0, 140)}」、lastGoodCode は each_slice のまま、本番のバッチ ${b0} → ${s.batches}`);
  let len = (await logText(page)).length;
  await yfDeploy(page, "puts RubyVM::InstructionSequence.of(Yield.method(:method_missing)).disasm\n" + each);
  await sleep(200);
  const dis = (await logText(page)).slice(len).split("\n").find((l) => /残業させてください/.test(l)) ?? "";
  const caps0 = await yfGet(page, () => JSON.stringify(window.__yf.flow.caps));
  len = (await logText(page)).length;
  await yfDeploy(page, "puts Yield.残業させてください\n" + each);
  await sleep(150);
  const caps1 = await yfGet(page, () => JSON.stringify(window.__yf.flow.caps));
  const o = await yfGet(page, () => ({ nb: window.__yf.notebook, ot: window.__yf.overtimeUntil, now: performance.now() }));
  const voice = (await logText(page)).slice(len).split("\n").find((l) => /45 秒だけだぞ/.test(l)) ?? "";
  await sleep(500);
  await shot(page, "r7-overtime.png");
  evidence("R7", !!dis && o.nb.includes("overtime") && caps0 === caps1 && o.ot > o.now,
    `disasm を puts: ログ「${dis.trim()}」。Yield.残業させてください: ログ「${voice.trim()}」、notebook=${JSON.stringify(o.nb)}、caps は同じ（${caps0 === caps1}）、残業灯は ${((o.ot - o.now) / 1000).toFixed(1)} 秒残っている`);
  await ctx.close();
};

RUBYIST.R9 = async () => {
  const { ctx, page } = await rubyPage();
  await progressTo(page, "sorter");
  await yfDeploy(page, BIND_SORT);
  const all = `p Yield.instance_variables
puts Yield.instance_variable_get(:@memo)
Yield.instance_variable_set(:@lanes, 2)
k = ObjectSpace.each_object(Class).find { it.name.nil? && it.method_defined?(:turn) }
puts ObjectSpace.each_object(k).first.turn
puts Yield.残業させてください
def Yield.tick(*) = nil
def pack(belt)
  belt.reject(&:flaw).sort_by(&:carat).each_slice(box).to_a
end
`;
  await yfDeploy(page, all);
  await batches(page, 1);
  const nb = await yfGet(page, () => window.__yf.notebook);
  await page.evaluate(() => { const g = document.querySelector("#gemfile"); g.scrollTop = g.scrollHeight; });
  await shot(page, "r9-notebook.png");
  await progressTo(page, "release");
  await until(page, () => page.locator(".card.ending").isVisible(), { timeout: 5000 });
  await sleep(500);
  const head = await page.locator(".ending-head").innerText().catch(() => "");
  const table = await page.locator(".ending-table").innerText().catch(() => "");
  await shot(page, "r9-ending.png");
  const rows = table.split("\n").filter((l) => /裏口ノート|鑑定長に見抜かれた/.test(l)).map((l) => l.replace(/\t/g, " "));
  // 「X で共有」は x.com の投稿画面を開く。開いた URL だけを取り、x.com には行かない。?debug で開いていても投稿の URL には付けない
  await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
  await page.locator(".card.ending .btn-share").click();
  const opened = await page.evaluate(() => window.__opened);
  const intent = opened[0]?.[0] ? new URL(opened[0][0]) : null;
  const post = intent?.searchParams.get("text") ?? "";
  const shareOk = opened.length === 1 && intent.origin + intent.pathname === "https://x.com/intent/post" && /noopener/.test(opened[0][2] ?? "")
    && /クリアしました/.test(post) && /裏口ノート 6\/6/.test(post) && post.includes(new URL(BASE).origin + new URL(BASE).pathname) && !/debug|pack\.rb|def pack\(belt\)\n/.test(post) && /\n#def_pack$/.test(post);
  evidence("R9", nb.length === 6 && /\+PRISM \+BACKDOOR \[wasm32-wasi\]$/.test(head) && rows.some((r) => /裏口ノート\s+6\/6/.test(r)) && rows.some((r) => /鑑定長に見抜かれた\s+\d+ 回/.test(r)) && shareOk,
    `ノート ${nb.length}/6（${nb.join(",")}）→ エンディングの見出し「${head}」、行「${rows.join(" | ")}」。X で共有の文「${post.replace(/\n/g, " / ")}」`);
  await ctx.close();
};

RUBYIST.R10 = async () => {
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const BASELINE = 12 * 60 + 53;
  const read = (f) => (f ? JSON.parse(readFileSync(f, "utf8")) : null);
  const base = read(opt("--pt-base", null));
  const all = read(opt("--pt-all", null));
  const endAt = (r) => r?.ending?.t ?? (r?.reachedEnding ? r.totalSec : null);
  // 受け入れ 10 は通しプレイ 2 本と econ の 3 つで判定する。通しプレイの結果を渡さないと econ だけで PASS にならないよう、FAIL にする
  if (!base || !all) {
    evidence("R10", false, `通しプレイの結果がありません（--pt-base ${base ? "あり" : "なし"}・--pt-all ${all ? "あり" : "なし"}）。dev/playthrough.mjs を裏口なしと --backdoor で回して渡してください`);
  }
  if (base) {
    const t = endAt(base);
    evidence("R10", !!base.reachedEnding && t >= BASELINE * 0.95 && t <= BASELINE * 1.05,
      `裏口なしの通しプレイ: リリース ${t != null ? fmt(t) : "-"}（基準 ${fmt(BASELINE)} の ${t != null ? ((t / BASELINE) * 100).toFixed(1) : "-"}%）、待つだけの最長 ${base.idle?.waitOnly?.top5?.[0]?.len ?? "-"} 秒`);
    if (all) {
      const ta = endAt(all);
      const over = all.idle?.waitOnly?.over90s ?? [];
      evidence("R10", !!all.reachedEnding && ta >= t * 0.8 && over.length === 0,
        `--backdoor: リリース ${ta != null ? fmt(ta) : "-"}（裏口なしの ${ta != null ? ((ta / t) * 100).toFixed(1) : "-"}%、下限 80%）、待つだけ 90 秒超 ${over.length} 件（最長 ${all.idle?.waitOnly?.top5?.[0]?.len ?? "-"} 秒）、ノート ${JSON.stringify(all.finalState?.notebook ?? null)}`);
    }
  }
  const econ = execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "../tools/econ.mjs"), "--policy", "both", "--backdoor", "lanes,night,audit"], { encoding: "utf8" });
  // 出力は「== ボット方針 … ==」「== 人間らしい方針 … ==」の 2 節で、それぞれ最後に「リリース: m:ss」
  const human = econ.slice(econ.indexOf("== 人間らしい方針"));
  const m = econ.includes("== 人間らしい方針") ? /リリース: (\d+):(\d\d)/.exec(human) : null;
  const bot = /== ボット方針[\s\S]*?リリース: (\d+:\d\d)/.exec(econ)?.[1] ?? "-";
  const lines = [`ボット ${bot}`];
  const sec = m ? Number(m[1]) * 60 + Number(m[2]) : null;
  evidence("R10", sec != null && sec >= 12 * 60, `tools/econ.mjs --policy both --backdoor lanes,night,audit: 人間らしい方針のリリース ${m ? `${m[1]}:${m[2]}` : "読めず"}（12:00 より遅い）。${lines.join(" / ").slice(0, 300)}`);
};

// 375px のスマホで、途中のセーブから再開し、研究タブの裏口ノートとコードタブを確かめる。
// エラーなく pack.rb で再開し、指でデプロイでき、どの画面でも横にはみ出さないことを見る
const R11_CODE = SAMPLE_CODE.groupBy;
RUBYIST.R11 = async () => {
  const { ctx, page } = await newPage({ width: 375, height: 812, dpr: 3, mobile: true });
  const done = RESEARCH.slice(0, RESEARCH.findIndex((r) => r.key === "monochrome") + 1).map((r) => r.key);
  const saved = {
    v: 1, money: 1000, totalEarned: 5e7, record: 400, belt: 1, mines: { pickaxe: 5 }, research: done, deployed: true,
    code: R11_CODE, lastGoodCode: R11_CODE, codeHistory: [R11_CODE], stats: { deploys: 6, restarts: 0, shipped: 1e5, startedAt: Date.now() - 600e3 },
    savedAt: Date.now() - 5000,
  };
  // 最初の読み込みのときだけセーブを置く（リロードでは置き直さない）
  await ctx.addInitScript((save) => {
    if (sessionStorage.getItem("r11-seeded")) return;
    localStorage.setItem("yield-factory/v1", save);
    localStorage.setItem("yield-factory/tab", "code");
    sessionStorage.setItem("r11-seeded", "1");
  }, JSON.stringify(saved));
  await page.goto(BASE + "?debug");
  await until(page, async () => (await ds(page)).vm === "ready", { timeout: 30000 });
  // 再開するとセーブのコードを入れ直すので、それが終わってからボタンを見る
  await until(page, async () => (await ds(page)).deploying === "0", { timeout: 8000 });
  const overflow = async () => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
  const widths = [];
  const start = await page.evaluate(() => ({
    label: document.querySelector("#code").getAttribute("aria-label"),
    code: document.querySelector("#code").value,
    fname: document.querySelector(".fname")?.textContent ?? "",
    btn: document.querySelector("#deploy").textContent,
    research: document.body.dataset.research,
  }));
  await shot(page, "m-r11-code.png");
  widths.push(await overflow());
  await page.locator('.tab[data-tab="research"]').tap();
  await sleep(200);
  const nbVisible = await page.locator("#notebook").isVisible();
  await page.evaluate(() => { const g = document.querySelector("#gemfile"); g.scrollTop = g.scrollHeight; });
  await shot(page, "m-r11-notebook.png");
  widths.push(await overflow());
  // コードタブに戻り、デプロイボタンを指で押す
  await page.locator('.tab[data-tab="code"]').tap();
  await sleep(200);
  const d0 = await yfGet(page, () => window.__yf.state.stats.deploys);
  const btn = await page.locator("#deploy").boundingBox();
  await page.touchscreen.tap(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await until(page, async () => (await yfGet(page, () => window.__yf.state.stats.deploys)) > d0 && (await ds(page)).deploying === "0", { timeout: 8000 });
  const d1 = await yfGet(page, () => window.__yf.state.stats.deploys);
  await sleep(300);
  await shot(page, "m-r11-deployed.png");
  widths.push(await overflow());
  evidence("R11", start.label === "pack.rb" && start.fname === "pack.rb" && start.code === R11_CODE && /デプロイ/.test(start.btn) && start.research.split(",").includes("monochrome")
    && nbVisible && d1 === d0 + 1 && widths.every((w) => w <= 375),
    `375px: 途中のセーブから再開 → エディタ「${start.fname}」・コードは保存した pack.rb（${start.code === R11_CODE}）・ボタン「${start.btn}」。研究タブに裏口ノート（${nbVisible}）。指でデプロイ ${d0} → ${d1} 回。scrollWidth ${widths.join(", ")}`);
  await ctx.close();
};

// ------------------------------------------------------------ 実行

try {
  if (ONLY.some((i) => typeof i === "number" && i <= 3)) {
    await realtimeOpening(1, 25000, { full: true });
    if (ONLY.includes(2)) await realtimeOpening(2, 3000, { full: false });
  }
  if (ONLY.some((i) => typeof i === "number" && i >= 4 && i <= 6)) {
    const p = await preparedPage();
    await shot(p.page, "i-prepared.png");
    // 診断カード（赤い工程のクリック）
    if (ONLY.includes(4)) await test4(p.page);
    if (ONLY.includes(5)) await test5(p.page);
    if (ONLY.includes(6)) await test6(p);
    await p.ctx.close();
  }
  if (ONLY.includes(7)) await test7();
  for (const id of ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R9", "R10", "R11"]) {
    if (!ONLY.includes(id)) continue;
    try {
      await RUBYIST[id]();
    } catch (e) {
      console.error(e);
      evidence(id, false, `スクリプトの例外: ${e.message}`);
    }
  }
} catch (e) {
  console.error(e);
  consoleErrors.push(`script: ${e.message}`);
} finally {
  await browser.close();
}

console.log("\n==== 結果 ====");
// 終了コードは「選んだ項目が全部実行されて PASS」。未実行（スクリプトの途中で止まった・番号の打ち間違い）も FAIL に数える
let allPass = true;
for (const id of ONLY) {
  const r = results.get(id) ?? { pass: false, evidence: "未実行" };
  if (!r.pass) allPass = false;
  console.log(`${id}: ${r.pass ? "PASS" : "FAIL"} — ${r.evidence}`);
}
// R10（通しプレイ）は既定では回らない。全部 PASS と読めないように、未判定であることを結果の欄に出す
if (!ONLY.includes("R10")) {
  console.log("R10: 未判定 — 通しプレイの判定はこの実行に入っていません。dev/playthrough.mjs を裏口なしと --backdoor で回し、--pt-base と --pt-all で渡してください（SPEC-rubyist 6 章 10）");
}
console.log(`コンソールエラー: ${consoleErrors.length} 件`);
for (const e of consoleErrors.slice(0, 20)) console.log("  " + e);
console.log(`判定: 選んだ ${ONLY.length} 項目は${[...ONLY].every((id) => results.get(id)?.pass) ? "全部 PASS" : "FAIL を含みます"}${ONLY.includes("R10") ? "" : "（R10 は未判定）"}`);
console.log("JSON:" + JSON.stringify({ results: Object.fromEntries(results), consoleErrors }));
process.exit(allPass && [...results.values()].every((r) => r.pass) && consoleErrors.length === 0 ? 0 : 1);
