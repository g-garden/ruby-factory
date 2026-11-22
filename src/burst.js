/**
 * 短い時間に続けて起きたことを数える。windowMs の間に limit 回たまったら note() が true を返し、数え直す。
 * 定常バッチの例外（10 秒に 3 回）と、本番 VM の落ち（30 秒に 3 回）で、前のコードに戻すかどうかを決めるのに使う
 */
export function createBurstCounter({ limit, windowMs }) {
  const times = [];
  return {
    /** now はミリ秒（performance.now() など）。上限に届いたら true */
    note(now) {
      times.push(now);
      while (times.length && now - times[0] > windowMs) times.shift();
      if (times.length < limit) return false;
      times.length = 0;
      return true;
    },
    reset() {
      times.length = 0;
    },
    get count() {
      return times.length;
    },
  };
}
