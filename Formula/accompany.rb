# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.19.0"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.19.0/accompany-0.19.0-darwin-arm64"
      sha256 "bb1fa2f84072b29c554afa69d564edd59488f736a199793633452713cf5bcdcb"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.19.0/accompany-0.19.0-darwin-x64"
      sha256 "fb45f84057ebfa0a0d76f126cba16996eb1c74b1edc7b95559a3c394d1bb0d1b"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.19.0/accompany-0.19.0-linux-arm64"
      sha256 "5eee98ba80a76833471a4c265a8ec3f041d050facd3f6ae0040f4d16414bd94c"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.19.0/accompany-0.19.0-linux-x64"
      sha256 "3041d86556cf491e9c47ed89294d252086b827dd3f03648022f00dacb24457ce"
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
