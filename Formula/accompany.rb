# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.22.0"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.22.0/accompany-0.22.0-darwin-arm64"
      sha256 "2e5c636dc150e692137aca8c2298f3139b69e9103f99534e525b73da570c4876"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.22.0/accompany-0.22.0-darwin-x64"
      sha256 "d62f19d99e934c37d53a99e56abc06ad7265b84ad19e81865ee362a54f96f6b0"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.22.0/accompany-0.22.0-linux-arm64"
      sha256 "9a25adf367d991334ecd40fdc61d663498349324b330cb6246574e7f863f6154"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.22.0/accompany-0.22.0-linux-x64"
      sha256 "8fc9b9354e98d3deac945ccbf5dc989d2dc1368b68f2a69da82024bd80d3413e"
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
