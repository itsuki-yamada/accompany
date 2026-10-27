import { basename } from "node:path";

// シェルの統合のスクリプト。利用者が自分の rc に `eval "$(accompany activate zsh)"` のように書いて入れる（mise activate と同じ形）。
// コマンドを実行する前に OSC 133 の C（出力の始まり）を、実行し終えたら D（出力の終わり）と A（プロンプトの始まり）を出し、
// Accompany は直前のコマンドの出力の範囲を見分ける（docs/adr/112-copy-last-output.md）。
// mise activate にならい、前に読み込んだフックを外してから入れ直すので、何度読み込んでも 1 回分だけ効く。
// プロンプト（PS1 など）は書き換えない。Accompany の外の端末で読み込んでも、OSC 133 を知らない端末は印を無視する
export const shells = ["zsh", "bash", "fish"] as const;
export type Shell = (typeof shells)[number];

export function isShell(name: string): name is Shell {
  return (shells as readonly string[]).includes(name);
}

// シェルを省いたときは、$SHELL の名前（/bin/zsh なら zsh）から決める
export function shellFromEnv(shellPath = process.env.SHELL ?? "") {
  return basename(shellPath);
}

const scripts: Record<Shell, string> = {
  // 終了コードを、ほかのフックより先に読むため、precmd のフックは先頭に入れる
  zsh: `# Accompany のシェルの統合（OSC 133）。~/.zshrc に eval "$(accompany activate zsh)" と書いて読み込む
autoload -Uz add-zsh-hook
_accompany_hook() {
  local code=$?
  print -n "\\e]133;D;\${code}\\a\\e]133;A\\a"
  return $code
}
_accompany_hook_preexec() {
  print -n "\\e]133;C\\a"
}
typeset -ag precmd_functions
precmd_functions=(_accompany_hook \${precmd_functions:#_accompany_hook})
add-zsh-hook -d preexec _accompany_hook_preexec 2>/dev/null
add-zsh-hook preexec _accompany_hook_preexec
`,
  // PS0（コマンドを読んでから実行する前に出す）を使うので、bash 4.4 以上で効く。PROMPT_COMMAND は文字列でも配列でもよい
  bash: `# Accompany のシェルの統合（OSC 133）。~/.bashrc に eval "$(accompany activate bash)" と書いて読み込む（bash 4.4 以上）
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
	_accompany_hook() {
		local code=$?
		printf '\\e]133;D;%s\\a\\e]133;A\\a' "$code"
		return $code
	}
	if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
		_accompany_commands=()
		for _accompany_command in \${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}; do
			if [[ $_accompany_command != _accompany_hook ]]; then
				_accompany_commands+=("$_accompany_command")
			fi
		done
		PROMPT_COMMAND=(_accompany_hook \${_accompany_commands[@]+"\${_accompany_commands[@]}"})
		unset _accompany_commands _accompany_command
	else
		_accompany_command="\${PROMPT_COMMAND-}"
		_accompany_command="\${_accompany_command//_accompany_hook;/}"
		_accompany_command="\${_accompany_command//_accompany_hook/}"
		PROMPT_COMMAND="_accompany_hook\${_accompany_command:+;$_accompany_command}"
		unset _accompany_command
	fi
	_accompany_output_start=$'\\e]133;C\\a'
	PS0="\${PS0//"$_accompany_output_start"/}$_accompany_output_start"
	unset _accompany_output_start
fi
`,
  // fish 4.0 以上は自分で OSC 133 を出すので、入れなくてもよい（入れても重なるだけ）
  fish: `# Accompany のシェルの統合（OSC 133）。~/.config/fish/config.fish に accompany activate fish | source と書いて読み込む
functions --erase _accompany_hook _accompany_hook_preexec _accompany_hook_postexec
function _accompany_hook_preexec --on-event fish_preexec --description 'Accompany: コマンドの出力の始まり（OSC 133 C）'
  printf '\\e]133;C\\a'
end
function _accompany_hook_postexec --on-event fish_postexec --description 'Accompany: コマンドの出力の終わり（OSC 133 D）'
  printf '\\e]133;D;%s\\a' $status
end
function _accompany_hook --on-event fish_prompt --description 'Accompany: プロンプトの始まり（OSC 133 A）'
  printf '\\e]133;A\\a'
end
`,
};

export function activateScript(shell: Shell) {
  return scripts[shell];
}

export const activateUsage = `シェルの統合のスクリプトを表示する

表示したスクリプトを、シェルで評価して使う（実行するだけでは表示するだけ）。
シェルの統合を入れると、コマンドの区切り（OSC 133）が分かり、ターミナルの右下の「コピー」や右クリックのメニューで、
直前に実行したコマンドの出力をコピーできる。プロンプトは書き換えない。

対話シェルの設定ファイル（bash は ~/.bashrc、zsh は ~/.zshrc、fish は ~/.config/fish/config.fish）に、
次のうち合うものを 1 回だけ書く。

  eval "$(accompany activate zsh)"
  eval "$(accompany activate bash)"      # bash 4.4 以上
  accompany activate fish | source       # fish 4.0 以上は書かなくてもよい

使い方: accompany activate [シェル]

引数:
  [シェル]    スクリプトを出すシェル（${shells.join("・")}）。省くと $SHELL から決める

オプション:
  -h, --help  この使い方を表示する

activate という名前のコマンドを最初のターミナルで動かすときは、accompany -- activate と書く`;
