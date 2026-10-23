# Release の OS と CPU ごとの実行ファイルを入れる（docs/adr/131-homebrew.md）。
# 版と sha256 は、Release を出したあとに .github/scripts/update-formula.sh <版> で書き換える
class Accompany < Formula
  desc "Share AI coding agent terminals in the browser for remote pair programming"
  homepage "https://github.com/itsuki-yamada/accompany"
  version "0.20.0"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.20.0/accompany-0.20.0-darwin-arm64"
      sha256 "e626d6734c131f2d6f1fd5dfac34cd95991d3e737b7c03ce64b4a1219cdd70ae"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.20.0/accompany-0.20.0-darwin-x64"
      sha256 "1471e21729f952d7a2772232e1f1c1b555674a96783ec2ec0c1eeb2fd527f48c"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.20.0/accompany-0.20.0-linux-arm64"
      sha256 "5ea1862e6f99498f88261ba6a77fe4725b9855d5cdf460213c2fa55e53e4ad6f"
    end
    on_intel do
      url "https://github.com/itsuki-yamada/accompany/releases/download/v0.20.0/accompany-0.20.0-linux-x64"
      sha256 "2021e0c8bcd5fc209b7ec8bd0818cd52274d1675c847547fe598e103575fa9a9"
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
