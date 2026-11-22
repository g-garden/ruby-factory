import { BATCH_SIZE, CARAT_MAX, COLORS, FLAW_RATE, OPS_LIMIT } from "../data/balance.js";

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 色が増えても carat / flaw の乱数列の位置がずれないよう、1 個につき必ず 3 回引く
export function makeBelt(seed, { size = BATCH_SIZE, colors = ["red"] } = {}) {
  const rand = mulberry32(seed);
  const belt = new Array(size);
  for (let id = 0; id < size; id++) {
    const c = rand();
    const k = rand();
    const f = rand();
    belt[id] = {
      id,
      color: colors[Math.floor(c * colors.length)],
      carat: 1 + Math.floor(k * CARAT_MAX),
      flaw: f < FLAW_RATE,
    };
  }
  return belt;
}

const COLOR_INDEX = Object.fromEntries(COLORS.map((c, i) => [c.key, i]));

export function beltToRubyLiteral(belt, box, limit = OPS_LIMIT) {
  const ores = belt.map((o) => `[${o.id},${COLOR_INDEX[o.color]},${o.carat},${o.flaw}]`).join(",");
  return `[${box}, ${limit}, [${ores}]]`;
}
