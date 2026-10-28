# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.23.1"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.23.1/accompany-0.23.1-darwin-arm64"
      sha256 "4287217fa3803e1d607616c3982c1bcf11199bc6f9a225a3c177b26e5b11ce3e"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.23.1/accompany-0.23.1-darwin-x64"
      sha256 "0b549acab5e0c2a23db42fae1971fd79aae157cf1b01ad90bece23612b035666"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.23.1/accompany-0.23.1-linux-arm64"
      sha256 "13dee3141b4cf55c0dbd045fe745690221f51dbdc7e337b10a53d51fae343721"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.23.1/accompany-0.23.1-linux-x64"
      sha256 "b534f5830d4844a337599847912f9019ee6543d4d4266e4d84b8d6e5b775ddb1"
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
