# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.18.0"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.18.0/accompany-0.18.0-darwin-arm64"
      sha256 "add8c9beebf035ee446a57d7808dfdee11250ab16732220fabe27c6ff8bd4128"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.18.0/accompany-0.18.0-darwin-x64"
      sha256 "498a9d37b49d2c6c3bcf2e3b1cea3df1c8f4ec38b7e93b359b20ca303621176a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.18.0/accompany-0.18.0-linux-arm64"
      sha256 "c22aa324d22032f578325c8f1a0e356445537d5555566533fbcb00c1a42f1be2"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.18.0/accompany-0.18.0-linux-x64"
      sha256 "c7e89855bafb2637801985a7b8efe0eb445d4bef50c0261fda9c19cb75b47775"
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
