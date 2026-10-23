// シェルの統合のスクリプト。利用者が自分の rc に `eval "$(accompany --shell-integration zsh)"` のように書いて入れる。
// コマンドを実行する前に OSC 133 の C（出力の始まり）を、実行し終えたら D（出力の終わり）と A（プロンプトの始まり）を出し、
// Accompany は直前のコマンドの出力の範囲を見分ける（docs/adr/112-copy-last-output.md）。
// プロンプト（PS1 など）は書き換えない。Accompany の外の端末で読み込んでも、OSC 133 を知らない端末は印を無視する
export const shells = ["zsh", "bash", "fish"] as const;
export type Shell = (typeof shells)[number];

export function isShell(name: string): name is Shell {
  return (shells as readonly string[]).includes(name);
}

const scripts: Record<Shell, string> = {
  zsh: `# Accompany のシェルの統合（OSC 133）。~/.zshrc に eval "$(accompany --shell-integration zsh)" と書いて読み込む
if [[ -o interactive && -z \${__accompany_integrated-} ]]; then
  typeset -g __accompany_integrated=1
  __accompany_precmd() {
    local code=$?
    print -n "\\e]133;D;\${code}\\a\\e]133;A\\a"
  }
  __accompany_preexec() {
    print -n "\\e]133;C\\a"
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __accompany_precmd
  add-zsh-hook preexec __accompany_preexec
fi
`,
  // PS0（コマンドを読んでから実行する前に出す）を使うので、bash 4.4 以上で効く
  bash: `# Accompany のシェルの統合（OSC 133）。~/.bashrc に eval "$(accompany --shell-integration bash)" と書いて読み込む（bash 4.4 以上）
if [[ $- == *i* && -z \${__accompany_integrated-} ]] && (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  __accompany_integrated=1
  __accompany_prompt() {
    local code=$?
    printf '\\e]133;D;%s\\a\\e]133;A\\a' "$code"
    return $code
  }
  PS0+=$'\\e]133;C\\a'
  PROMPT_COMMAND="__accompany_prompt\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
fi
`,
  // fish 4.0 以上は自分で OSC 133 を出すので、入れなくてもよい（入れても重なるだけ）
  fish: `# Accompany のシェルの統合（OSC 133）。~/.config/fish/config.fish に accompany --shell-integration fish | source と書いて読み込む
if status is-interactive; and not set -q __accompany_integrated
  set -g __accompany_integrated 1
  function __accompany_preexec --on-event fish_preexec
    printf '\\e]133;C\\a'
  end
  function __accompany_postexec --on-event fish_postexec
    printf '\\e]133;D;%s\\a' $status
  end
  function __accompany_prompt --on-event fish_prompt
    printf '\\e]133;A\\a'
  end
end
`,
};

export function shellIntegrationScript(shell: Shell) {
  return scripts[shell];
}
