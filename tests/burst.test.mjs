import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBurstCounter } from "../src/burst.js";

describe("短い時間に続いた失敗を数える", () => {
  it("時間内に上限の回数がたまったら true を返し、数え直す", () => {
    const c = createBurstCounter({ limit: 3, windowMs: 30_000 });
    assert.equal(c.note(0), false);
    assert.equal(c.note(10_000), false);
    assert.equal(c.note(29_000), true);
    assert.equal(c.count, 0);
    assert.equal(c.note(30_000), false);
  });
  it("時間の外に出た古い回は数えない（VM がゆっくり落ちるだけなら戻さない）", () => {
    const c = createBurstCounter({ limit: 3, windowMs: 30_000 });
    for (const t of [0, 20_000, 40_000, 60_000, 80_000]) assert.equal(c.note(t), false, String(t));
    assert.equal(c.count, 2);
    assert.equal(c.note(85_000), true);
  });
  it("reset で数え直す（デプロイが通ったとき）", () => {
    const c = createBurstCounter({ limit: 3, windowMs: 10_000 });
    c.note(0);
    c.note(1000);
    c.reset();
    assert.equal(c.note(2000), false);
    assert.equal(c.count, 1);
  });
});
