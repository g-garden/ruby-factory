# def pack(belt) の prelude（SPEC 付録 A ベース）。stdlib なしの ruby.wasm で動くよう JSON / StringIO は使わない。
# JS とのやり取りは \x1f 区切りの文字列 1 本。区切り文字が値に混ざらないよう clean で潰す。
module Yield
  class Overheat < Exception; end   # rescue => e で捕まらない

  # puts / p / print / warn の行き先。1 バッチ 4KB で打ち切る
  class Log
    LIMIT = 4096
    def initialize = @buf = "".b
    def write(*xs)
      xs.sum do |x|
        s = x.to_s
        room = LIMIT - @buf.bytesize
        @buf << s.b.byteslice(0, room) if room > 0
        s.bytesize
      end
    end
    def puts(*xs) = (xs.empty? ? write("\n") : xs.flatten.each { |x| s = x.to_s; write(s.end_with?("\n") ? s : s + "\n") }; nil)
    def print(*xs) = (write(*xs); nil)
    def <<(x) = (write(x); self)
    def flush = self
    def sync = true
    def sync=(v); v; end
    def tty? = false
    def fileno = nil
    def to_s = @buf.dup.force_encoding(Encoding::UTF_8).scrub("?")
  end

  COLORS = %i[red blue green].freeze
  US = "\x1f"
  # 有効な箱は原石の数を超えない。[belt.first(3)] * 300_000 のような返り値で JS が固まらないよう先頭だけ送る
  CRATE_CAP = 8192
  # @lanes・@memo は裏口ノート（SPEC-rubyist 2.2）。p Yield.instance_variables で見える位置に置く
  @ops = 0; @limit = 200_000; @polished = []; @box = 1
  @lanes = 1
  @memo = "ベルトは @lanes で 2 車線まで。3 車線にすると床が抜ける。合鍵は名前を付けずにしまった。— 工場長"
  # 研磨機の熱。1 バッチの中で n 回目の研磨は鑑定 n 回かかり、バッチの頭で 0 に戻る
  @heat = 0

  # ---- 裏口（SPEC-rubyist 4.1）。値はここでは丸めない。丸めるのは JS（economy.clampBackdoor） ----
  # 夜間ラインと残業は ivar に置かず、クロージャに閉じ込める（instance_variable_set(:@night, true) は効かない）
  night = false
  overtime = 0
  key = Class.new {
    define_method(:inspect) { "#<合鍵 工場長の>" }
    define_method(:turn) { night = true; "カチャ。夜間ラインが動き出しました" }
  }.new
  KEYRING = -> { key }
  private_constant :KEYRING
  # worker は Module#const_get を bind_call して読む。instance_variable_get を上書きされても読めるよう bind_call で引く
  REPORT = -> { [Kernel.instance_method(:instance_variable_get).bind_call(Yield, :@lanes), night ? 1 : 0, overtime] }
  private_constant :REPORT
  singleton_class.class_eval do
    define_method(:method_missing) do |name, *args|
      if name == :残業させてください
        overtime += 1
        next "工場長「……36 協定があるから、45 秒だけだぞ」"
      end
      raise NoMethodError.new("undefined method '#{name}' for module Yield。奥から工場長の声「用があるなら、ちゃんと頼め」", name)
    end
    private :method_missing
    define_method(:respond_to_missing?) { |name, priv = false| name == :残業させてください || super(name, priv) }
  end

  class << self
    attr_reader :ops, :box, :heat

    def tick(n = 1)
      @ops += n
      raise Overheat, "鑑定が #{limit_text} 回を超えました" if @ops > @limit
    end

    # 200000 を "200,000" と 3 桁ごとに区切って出す
    private def limit_text = @limit.to_s.gsub(/(\d)(?=(\d{3})+\z)/, '\1,')

    def polished(id) = @polished << id

    # 研磨 1 回ぶん研磨機を熱くして、上がった熱を返す。この回の研磨は、その数だけ鑑定する。
    # 正直に磨いていれば、熱はここまでに磨いた回数と同じになる。
    # 書き換えられて整数でない・負・磨いた回数より大きいときは、冷えた研磨機として 0 から数え直す。
    # 鑑定が 0 未満になったり、書き換えた値で Overheat になったりしないようにするため。書き換えたときの下限は JS の監査ラインが数える
    def heat_up
      h = @heat
      h = 0 unless h.is_a?(Integer) && h >= 0 && h <= @polished.size
      @heat = h + 1
    end

    def clean(s, n) = s.to_s.dup.force_encoding(Encoding::UTF_8).scrub("?")[0, n].tr(US, " ")

    # 行番号は pack.rb の中だけを見る
    def pack_line(e)
      if e.is_a?(SyntaxError)
        e.message[/pack\.rb:(\d+)/, 1]
      else
        e.backtrace_locations&.find { it.path == "pack.rb" }&.lineno
      end
    rescue Exception
      nil
    end

    # req: [box, limit, [[id, color_idx, carat, flaw], ...]]
    # 成功: "OK" US ops US polished_ids US 箱の数 US 箱(";" 区切り、中は "," 区切り。Ore 以外は -1、配列でない要素は -2) US log
    # 箱の数は CRATE_CAP で切ったときだけ "送った数/返された数"
    # 失敗: "ERR" US ops US 例外クラス US メッセージ US pack.rb の行番号 US log
    # 箱の数を別に持つのは [] と [[]] を区別するため
    def run(req)
      @box, @limit, raw = req
      @ops = 0; @polished = []; @heat = 0
      log = Log.new
      $stdout = log; $stderr = log
      belt = raw.map { |id, c, k, f| Ore.new(id:, color: COLORS[c], carat: k, flaw: f) }.freeze
      crates = TOPLEVEL_BINDING.receiver.send(:pack, belt)
      # rescue Exception で Overheat を握りつぶしても、上限を超えて読んだバッチは Overheat にする
      raise Overheat, "鑑定が #{limit_text} 回を超えました。rescue で捕まえても止まります" if @ops > @limit
      raise TypeError, "#{crates.class} が返りました。pack は配列の配列を返してください" unless crates.is_a?(Array)
      # 箱の中の Ore 以外は -1、配列でない要素は [-2]（[it.id] のような箱と区別するため）。
      # box を超えた箱ははみ出しで無効なので box + 1 個で打ち切る（[belt] * 8192 で数百万個を文字列にしないため）
      ids = crates.first(CRATE_CAP).map { |c| c.is_a?(Array) ? (c.size > @box + 1 ? c.first(@box + 1) : c).map { it.is_a?(Ore) ? it.__id : -1 } : [-2] }
      count = crates.size > ids.size ? "#{ids.size}/#{crates.size}" : ids.size
      ["OK", @ops, @polished.join(","), count, ids.map { it.join(",") }.join(";"), log.to_s].join(US)
    rescue Exception => e
      ["ERR", @ops, clean(class_name(e), 100), clean(e.message, 300), pack_line(e).to_s, log.to_s].join(US)
    ensure
      $stdout = STDOUT; $stderr = STDERR
    end

    # 成功: "OK" US log（トップレベルの p / puts / warn の出力）
    # 失敗: "ERR" US 例外クラス US メッセージ US 行番号 US log
    # box を先に入れておくのは、トップレベルの SIZE = box がいまの箱サイズを読めるようにするため
    def deploy(src, box = nil)
      @box = box if box.is_a?(Integer) && box > 0
      log = Log.new
      $stdout = log; $stderr = log
      define_pack(src)
      @last_src = src
      ["OK", log.to_s].join(US)
    rescue Exception => e
      # 前のコードを読み直す前に文面を作る（読み直しの出力を混ぜない）
      err = ["ERR", clean(class_name(e), 100), clean(e.message, 600), pack_line(e).to_s, log.to_s].join(US)
      begin
        define_pack(@last_src) if @last_src
      rescue Exception
        nil
      end
      err
    ensure
      $stdout = STDOUT; $stderr = STDERR
    end

    # Class.new(StandardError) のような名前のない例外でも故障票に見出しを出す
    def class_name(e) = e.class.name || "#{e.class.ancestors.find(&:name)} の無名サブクラス"

    def define_pack(src)
      main = TOPLEVEL_BINDING.receiver
      Object.send(:remove_method, :pack) if Object.method_defined?(:pack) || Object.private_method_defined?(:pack)
      TOPLEVEL_BINDING.eval(src, "pack.rb", 1)
      raise NoMethodError, "def pack(belt) が見つかりません" unless main.respond_to?(:pack, true)
    end

    # 研究カードで本物のエラー文を見せる用。成功: "OK" US inspect  失敗: "ERR" US 例外クラス US メッセージ
    def probe(src)
      ["OK", clean(TOPLEVEL_BINDING.eval(src, "probe", 1).inspect, 600)].join(US)
    rescue Exception => e
      ["ERR", clean(e.class.name, 100), clean(e.message, 600)].join(US)
    end

    # 研磨機を冷やしたか。正直に磨いていれば、バッチの終わりの @heat は磨いた回数（同じ原石を 2 回磨いても 2 回）と同じになる。
    # @heat を 0 や負の数に書き換えると、ここがずれる。JS の監査はこれを見て、冷やした分の研磨を 1 + 2 + … + k で数え直す
    def cooled?
      !@polished.empty? && !(Integer === @heat && @heat == @polished.size)
    rescue Exception
      false
    end

    # 実績「モンキーパッチャー」。prelude のままなら "eval"、pack.rb で再定義すると "pack.rb"
    # 鑑定を数える Metered の書き換えや、Ore の前に別のモジュールを prepend するのも同じ扱い
    def patched?
      return true if %i[tick heat_up].any? { singleton_class.instance_method(it).source_location&.first == "pack.rb" }
      return true unless Ore.ancestors.first.equal?(Metered)
      Metered.instance_methods(false).any? { Metered.instance_method(it).source_location&.first == "pack.rb" }
    rescue Exception
      false
    end
  end

  module Metered
    %i[color carat flaw].each { |m| define_method(m) { Yield.tick; super() } }
    def to_h(*) = (Yield.tick(3); super)
    # 比較とハッシュも中で全属性を読むので 3 回（with(id: 0) で属性ごとにまとめる抜け道をふさぐ）
    def ==(other) = (Yield.tick(3); super)
    def eql?(other) = (Yield.tick(3); super)
    def hash = (Yield.tick(3); super)
    def with(**kw) = (Yield.tick(3); super)
    def deconstruct = (Yield.tick(3); super)
    def deconstruct_keys(keys) = (Yield.tick(keys ? keys.size : 3); super)
    def inspect = (Yield.tick(3); super)
    def to_s = inspect
    def polish = (Yield.tick(Yield.heat_up); Yield.polished(id); self)
  end
end

Ore = Data.define(:id, :color, :carat, :flaw)
class Ore
  alias_method :__id, :id
end
Ore.prepend(Yield::Metered)
# stdlib なし版の Kernel#pp は pp ライブラリを require して LoadError になる
module Kernel
  private def pp(*objs) = p(*objs)
end
def box = Yield.box
"ready"
