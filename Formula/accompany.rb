# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.15.0"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.15.0/accompany-0.15.0-darwin-arm64"
      sha256 "4eb7d1da03be3ac1b5efed611cc9c043da281ac8ff2d59769f89bb5051933b13"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.15.0/accompany-0.15.0-darwin-x64"
      sha256 "c9fb7b526cd2664baed5c2b52e379043844e2437ab86c27b567a1872a8e12141"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.15.0/accompany-0.15.0-linux-arm64"
      sha256 "684018f91b9faeef1bb6c35eea445b528595c1ab9d0f189c81e761ad68285534"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.15.0/accompany-0.15.0-linux-x64"
      sha256 "7bcf95762b6713649f57cda50327facad2f386d45b30925a0eac13bce14b1b94"
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
