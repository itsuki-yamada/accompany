# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.21.0"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.21.0/accompany-0.21.0-darwin-arm64"
      sha256 "26c66849eba361e3b3c85fb8319264a1f7f4a839d3342ab576e3d00e8fea10d5"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.21.0/accompany-0.21.0-darwin-x64"
      sha256 "c2648057a3b8b608a90bd7074cda25995761587f9dfec08f391b26c74fb24388"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.21.0/accompany-0.21.0-linux-arm64"
      sha256 "d98ea0e910959e64133065927cbe4a3399e96a04cc0c85c69f14514988ad6025"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.21.0/accompany-0.21.0-linux-x64"
      sha256 "34383eeb9131ae2f54bdd91e458344eae71f73b408e50f31718c5d7a55c63b32"
    end
  end

  def install
    bin.install Dir["accompany-*"].fetch(0) => "accompany"
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
