# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.23.0"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.23.0/accompany-0.23.0-darwin-arm64"
      sha256 "e7aa088b1cef6817fafea881d9cb62d2b5397ae57c16ac40e38854e4cbc75345"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.23.0/accompany-0.23.0-darwin-x64"
      sha256 "ae1d5f5d4fe9253c0dbc1e09db67fb1b6056d47352b1a6aa54b5d8ece861ea91"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.23.0/accompany-0.23.0-linux-arm64"
      sha256 "c9e1f55ccd5c6a89e10d886c748ff01af0f1d1e6aeb9bb8e62524498ea0f775e"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.23.0/accompany-0.23.0-linux-x64"
      sha256 "ae303b59369e6093b4086e4764e32a0af9c8ea2f2d3a61d83cd9a822da56486e"
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
