import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESEARCH } from "../data/balance.js";
import { createNoticeQueue, readMs, tipSentence } from "../src/ui/notice-queue.js";

describe("研究の tip を吹き出しの 1 文にする", () => {
  it("「やること: メソッド」をメソッドから始まる文にする", () => {
    assert.equal(tipSentence("3 個ずつ詰めよう: each_slice"), "each_slice で 3 個ずつ詰めよう");
    assert.equal(tipSentence("carat が 1 ずつ続くように詰めよう: chunk_while / each_cons"), "chunk_while / each_cons で carat が 1 ずつ続くように詰めよう");
  });
  it("前半に文が 2 つあるもの・コロンがないものはそのまま", () => {
    const two = "3..7 の窓を先に取ると ×64。窓を値段の順に並べよう: sum / sort_by";
    assert.equal(tipSentence(two), two);
    assert.equal(tipSentence("コードはそのままで単価が上がります"), "コードはそのままで単価が上がります");
  });
  it("研究データの tip はどれも文のまま残る（コロンで終わらない）", () => {
    for (const r of RESEARCH) {
      if (r.hint?.tip) assert.doesNotMatch(tipSentence(r.hint.tip), /:\s*$/);
    }
  });
});

describe("吹き出しの表示時間", () => {
  it("長い文ほど長く出す", () => {
    assert.ok(readMs("あ".repeat(60)) > readMs("あ".repeat(20)));
  });
  it("短すぎず、長すぎない", () => {
    assert.equal(readMs(""), 4000);
    assert.equal(readMs("あ".repeat(500)), 12_000);
  });
  it("サロゲートペアも 1 文字に数える", () => {
    assert.equal(readMs("𠮷".repeat(40)), readMs("あ".repeat(40)));
  });
});

describe("吹き出しの順番待ち", () => {
  const make = (opts = {}) => {
    let t = 0;
    const q = createNoticeQueue({ now: () => t, ...opts });
    return { q, advance: (ms) => { t += ms; } };
  };

  it("1 つずつ、来た順に出す", () => {
    const { q } = make();
    q.push({ text: "a" });
    q.push({ text: "b" });
    assert.equal(q.next().text, "a");
    assert.equal(q.next(), null, "出ている間は次を出さない");
    q.done();
    assert.equal(q.next().text, "b");
  });

  it("同じ文は dedupeMs のあいだ出し直さない", () => {
    const { q, advance } = make({ dedupeMs: 1000 });
    assert.equal(q.push({ text: "a" }), "queued");
    q.next();
    q.done();
    assert.equal(q.push({ text: "a" }), "dup");
    advance(1001);
    assert.equal(q.push({ text: "a" }), "queued");
  });

  it("key が同じなら文が違っても 1 回", () => {
    const { q } = make();
    q.push({ text: "単価記録 $10", key: "gate:x" });
    assert.equal(q.push({ text: "単価記録 $12", key: "gate:x" }), "dup");
    assert.equal(q.size, 1);
  });

  it("group が同じものは新しい方だけ残す。出ているものは差し替える", () => {
    const { q } = make();
    q.push({ text: "start", group: "onboarding" });
    q.push({ text: "vm", group: "onboarding" });
    assert.deepEqual(q.items.map((x) => x.text), ["vm"]);
    q.next();
    assert.equal(q.push({ text: "goal", group: "onboarding" }), "replace");
    assert.equal(q.current.text, "goal");
    assert.equal(q.size, 0);
  });

  it("urgent は列の先頭に入る（先に来た urgent の後ろ）", () => {
    const { q } = make();
    q.push({ text: "a" });
    q.push({ text: "w1", urgent: true });
    q.push({ text: "w2", urgent: true });
    assert.deepEqual(q.items.map((x) => x.text), ["w1", "w2", "a"]);
  });

  it("urgent は、出ている urgent でないものに割り込む。割り込まれた方は次に出す", () => {
    const { q } = make();
    q.push({ text: "a" });
    q.push({ text: "b" });
    q.next();
    assert.equal(q.push({ text: "w", urgent: true }), "preempt");
    assert.equal(q.current.text, "w");
    assert.deepEqual(q.items.map((x) => x.text), ["a", "b"]);
    assert.equal(q.push({ text: "w2", urgent: true }), "queued", "urgent どうしは割り込まない");
    assert.deepEqual(q.items.map((x) => x.text), ["w2", "a", "b"]);
  });

  it("あふれたら urgent でない古いものから捨てる", () => {
    const { q } = make({ max: 2 });
    q.push({ text: "a" });
    q.push({ text: "b" });
    q.push({ text: "w", urgent: true });
    assert.deepEqual(q.items.map((x) => x.text), ["w", "b"]);
  });

  it("clear で全部下げる", () => {
    const { q } = make();
    q.push({ text: "a" });
    q.next();
    q.push({ text: "b" });
    q.clear();
    assert.equal(q.current, null);
    assert.equal(q.size, 0);
  });
});
