# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.17.0"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.17.0/accompany-0.17.0-darwin-arm64"
      sha256 "6641e6d4566d317167b02a3554f19d2f22e8be33503dc59420437277a1d3a760"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.17.0/accompany-0.17.0-darwin-x64"
      sha256 "42b7a047b64b30f94bcaaa38b3a0f8bfbbd949fe9ec2e8d9faf5bdd2d8620c8c"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.17.0/accompany-0.17.0-linux-arm64"
      sha256 "874b735c5d77e89f277b3d353cc6eb465c15ebff3da35d46008a1d8409282316"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.17.0/accompany-0.17.0-linux-x64"
      sha256 "08e33e7ae3750b0bc2c86439e37c1f5e6fa5db25ebb99eea759fdc40c2d705f8"
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
