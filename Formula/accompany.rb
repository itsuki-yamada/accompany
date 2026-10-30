# Release の tarball を入れ、その JS（dist/cli.js）を Homebrew の bun で動かす（docs/adr/191-run-on-bun.md）。
# 署名のない実行ファイルを入れず、広く使われている bun が動かすので、セキュリティの製品に止められにくい。
# このファイルは .github/scripts/update-formula.sh が作る。手で直さず、スクリプトのひな形を直して流し直す
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  url "https://github.com/itsuki-yamada/accompany/releases/download/v0.26.0/accompany-0.26.0.tgz"
  sha256 "5a8eb5b959b8b83350493840092d39f98d86c2ef6038d0a8eba40d00969a7259"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  # homebrew-core の bun。版は Accompany と別に上がる（対応する版の下限と、最新の bun で動くことは e2e.yml で確かめる）。
  # Intel の Mac には bun の bottle がなく、入れると bun をソースからビルドする（rust や llvm も要る）ので、
  # Release の実行ファイルを入れる
  on_macos do
    on_arm do
      depends_on "bun"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.26.0/accompany-0.26.0-darwin-x64"
      sha256 "946af0289ea5c7cd6b889a5cf00cdceec191ad5a81620ef47d9cf8401a65ca70"
    end
  end

  on_linux do
    depends_on "bun"
  end

  def install
    if OS.mac? && Hardware::CPU.intel?
      bin.install Dir["accompany-*"].fetch(0) => "accompany"
      return
    end

    libexec.install Dir["*"]
    # bun の場所は、PATH の bun（mise などで入れた古いものかもしれない）ではなく、依存の bun に決めておく
    (bin/"accompany").write <<~SH
      #!/bin/sh
      exec "#{formula_opt_bin("bun")}/bun" "#{libexec}/dist/cli.js" "$@"
    SH
  end

  test do
    assert_match "accompany #{version}", shell_output("#{bin}/accompany --version")

    port = free_port
    # 画面の保存先を、ホームではなくテストの作業ディレクトリにする
    ENV["ACCOMPANY_STATE_DIR"] = (testpath/"state").to_s
    pid = spawn bin/"accompany", "--port", port.to_s
    begin
      # 起動して待ち受けるまで待ち、画面（HTML）が返ることを確かめる
      page = testpath/"index.html"
      30.times do
        break if quiet_system "curl", "-fso", page, "http://127.0.0.1:#{port}/"

        sleep 1
      end
      assert_match "<title>Accompany</title>", page.read
    ensure
      Process.kill "TERM", pid
      Process.wait pid
    end
  end
end
