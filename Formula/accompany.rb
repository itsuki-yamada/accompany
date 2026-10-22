# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.16.0"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.16.0/accompany-0.16.0-darwin-arm64"
      sha256 "79b1e1806b7126bf751013329722163687938ebfc46c37bbeffcb3dc0c1cee9f"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.16.0/accompany-0.16.0-darwin-x64"
      sha256 "764e2b4b26196e30dbec41b0e21614f9a60a62b9f360e4b0a60ffdac6997cb25"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.16.0/accompany-0.16.0-linux-arm64"
      sha256 "7e8884abb51a2c04a4db9b63e9f56b2b4e8453461ba6ce38d99c0aa7286f45e9"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.16.0/accompany-0.16.0-linux-x64"
      sha256 "880d72f0bce274303a929910793fdce1704dc8e1a9b6b5b25931824750846318"
    end
  end

  def install
    bin.install Dir["accompany-*"].fetch(0) => "accompany"
  end

  test do
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
