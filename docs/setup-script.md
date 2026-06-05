# 一括セットアップ / 起動・停止スクリプト 仕様

> 別マシンでも 1〜2 コマンドで導入・起動・停止できる管理スクリプト `scripts/orch.sh` の詳細仕様。
> ステータス: 確定（実装前） / 最終更新: 2026-06-05

---

## 1. 目的・スコープ
- **必要物をすべて自動導入**し、**サーバ起動＋ブラウザでUIを開く**までを 1 コマンドで行う。
- **1ユーザ1インスタンス**のみ許可（多重起動防止）。サーバは**バックグラウンド常駐**（端末を閉じても継続）。
- 同じスクリプトで **stop / restart / status / logs** ができる。
- 対象環境: **Linux（ネイティブ）/ macOS / WSL2**。ローカル単一ユーザ用途。
- **非対象**: OS再起動後の自動起動（systemd/launchd 常駐）。複数ユーザ/リモート公開。

---

## 2. 前提・対応環境
- **必須ランタイム**: Python **3.11+**、Node.js **20.19+ / 22.12+**（vite7 + react19 要件）、`git`。
- **任意**: `claude` CLI（実エージェント実行に必要。無ければ mock 動作）、`gh` CLI（リモートSKILL探索）。
- スクリプト自身は **bash**（Linux/macOS/WSL のデフォルトシェルで動作）。

---

## 3. コマンド体系

```
scripts/orch.sh <command> [options]
```

| コマンド | 概要 |
|---|---|
| `setup [--auto-deps]` | 必要物をすべて導入（venv・pip・npm・フロントbuild）。冪等 |
| `start [--dev] [--no-open] [--port N]` | サーバ起動（裏で常駐）→ health 待機 → ブラウザで UI を開く |
| `stop [--force]` | サーバ停止（graceful → 強制）。進行中Runがあれば警告 |
| `restart [options]` | stop → start |
| `status` | 起動状態・PID・ポート・稼働時間・health・adapter・commit を表示 |
| `logs [-f]` | サーバログを表示（`-f` で追従） |
| `open` | 起動中インスタンスをブラウザで開く（起動はしない） |
| `doctor` | 環境診断（バージョン・claude/gh・ポート・権限モード） |
| `update` | `git pull` → 依存再導入 → リビルド → restart |
| `clean` / `uninstall` | venv・node_modules・dist を削除（`.orch` データは確認付きで任意） |

終了コード: 成功 `0` / 前提不足 `1` / 多重起動・競合 `2` / health 失敗 `3`（CI・自動化用）。

---

## 4. 各コマンドの詳細

### 4.1 `setup`
1. **前提チェック**（`doctor` 相当）。Python 3.11+ と Node 20+ を検出。
2. **ランタイム不足時の対応**:
   - **Node**: 不足/古い かつ `--auto-deps` 指定時、**ユーザ空間のバージョンマネージャで自動導入**（sudo不要）:
     - 優先: 既存の `fnm` → 無ければ `nvm` → どちらも無ければ **`fnm` を `~/.local/share/fnm` に導入** → `fnm install`（`.node-version` 準拠）。
     - リポジトリに **`.node-version`**（例 `22`）を置き、マネージャがバージョンを自動選択。
     - `--auto-deps` 無し時は導入コマンドを**案内のみ**（自動では入れない）。
   - **Python**: 自動導入はしない（システム影響大）。不足時は導入手順を案内。
3. **バックエンド**: `python3 -m venv .venv` → `.venv/bin/pip install -e ".[dev]"`。
4. **フロントエンド**: `cd frontend && npm ci`（lockfile厳守）→ `npm run build`（prod用 `dist` 生成）。
5. **設定初期化**: `scripts/orch.env` が無ければ `orch.env.example` から生成し、**`ORCH_TOKEN` をランダム生成**して書き込む（既定値のままにしない）。
6. 冪等。再実行しても安全（既存 venv/deps はスキップ or 更新）。

### 4.2 `start`
1. `.venv` または `frontend/dist` が無ければ **自動的に `setup` を実行**。
2. **シングルトン判定**（§5）: 既に起動中（pid生存＋health応答）なら**新規起動せず**、ブラウザを開いて `exit 0`。
3. **自動リビルド**: `dist` 不在、または `git HEAD` が前回ビルド時の commit と異なる場合、`npm run build` を実行（UIを常に最新に）。
4. **環境変数の解決**: `orch.env` を読み込み、`ORCH_API_BASE=http://HOST:PORT` を **export**（エージェントの `utils/submit.py`・`question.py` の callback に必須）。
5. **バックグラウンド起動**（prod単一ポート）:
   ```
   setsid nohup .venv/bin/python -m agent_orchestrator.cli serve --host HOST --port PORT \
     > <state>/server.log 2>&1 &
   ```
   PID を `<state>/orch.pid` に記録、`meta.json` に port/repoパス/commit/started_at を保存。
6. **health 待機**: `/api/health` を最大 ~30s ポーリング。成功で次へ、失敗なら `server.log` 末尾を表示して `exit 3`。
7. **ブラウザ起動**（§7）。`--no-open` でスキップ。
8. オプション: `--dev` は vite devサーバ（5173）＋backend（PORT）の2プロセス構成（HMR開発用）。`--port N` でポート上書き。

### 4.3 `stop`
1. `orch.pid` から PID を取得。**進行中Run**（`/api/attention` 等で running/waiting_qa を確認）があれば**警告**し、`--force` または対話確認が無ければ中止。
2. **SIGTERM → 最大5s待機 → 生存していれば SIGKILL**。`--dev` 時は vite も停止。
3. `orch.pid` / `orch.lock` を解放・削除。`meta.json` を更新（stopped）。

### 4.4 その他
- `restart`: `stop` 後に `start`（オプション引き継ぎ）。
- `status`: running/stopped、PID、PORT、uptime、`/api/health` の `active_adapter`（mock/claude）、commit を表示。
- `logs [-f]`: `<state>/server.log` を表示（`-f` で `tail -f`）。
- `open`: 起動中なら `meta.json` の URL をブラウザで開く。未起動ならエラー。
- `doctor`: §8。
- `update`: `git pull --ff-only` → `setup` → `restart`。ローカル変更があれば中止して警告。
- `clean`/`uninstall`: `.venv` / `frontend/node_modules` / `frontend/dist` を削除。`.orch`（DB・workdir）は **`--purge-data` 指定＋確認**でのみ削除。

---

## 5. シングルトン機構（1ユーザ1インスタンス）
- **ランタイム状態を固定ユーザパスに集約**: `${XDG_STATE_HOME:-$HOME/.local/state}/agent-orch/`
  - `orch.pid`（PID）、`orch.lock`（flock用）、`server.log`、`meta.json`（port・repo path・commit・started_at・url）。
  - → **どのクローン・どのディレクトリから実行しても同一インスタンスを制御**でき、1ユーザ1サーバを担保。
- **`start` の排他**:
  1. `flock -n <state>/orch.lock` を取得（取れない=別の start 実行中 → `exit 2`）。
  2. `orch.pid` の PID が生存し `/api/health` が応答 → **既に起動中**（ブラウザを開いて `exit 0`）。
  3. PID が死んでいれば **stale を掃除**して起動続行。
  4. 設定ポートが**他プロセス**に使用されていれば `exit 2`（ポート競合）。
- 固定ポート（既定 `8000`、`orch.env` で変更可）。OS のポート bind と pidfile の二重で多重起動を防止。

---

## 6. プロセス / 常駐
- `setsid nohup ... &` でデタッチ。**端末を閉じても継続**。ログは `server.log`（追記）。
- **OS再起動後の自動起動は対象外**（決定）。必要になれば将来 `install-service`（systemd user / launchd）を追加可能。
- ログは肥大防止に簡易ローテーション（起動時に一定サイズ超なら `server.log.1` へ退避）。

---

## 7. ブラウザ起動（クロスプラットフォーム）
検出順に最初に使えるものを採用:
1. **macOS**: `open <url>`
2. **WSL2**（`/proc/version` に `microsoft`）: `wslview <url>` → 無ければ `cmd.exe /c start <url>` → `powershell.exe -NoProfile Start-Process <url>`（**Windows側ブラウザを開く**）
3. **ネイティブ Linux**: `xdg-open <url>`（無ければ `$BROWSER`、それも無ければ URL を表示して案内）
4. **Windows（Git Bash等）**: `start <url>`
- いずれも失敗時は **URL を標準出力に表示**してユーザーが手動で開けるようにする。`--no-open` で常にスキップ。

---

## 8. `doctor`（診断項目）
- Python バージョン（≥3.11）/ Node バージョン（≥20）。
- `.venv` と pip 依存の導入状況、`frontend/node_modules` / `dist` の有無。
- **`claude` CLI の有無**（無ければ「mock動作になる」と警告）。
- **権限モード**: `ORCH_DEFAULT_PERMISSION_MODE` の値（`default` のまま広い許可リストが無いと提出失敗しうる旨を注意）。
- `gh` CLI の有無（リモートSKILL用）。
- 設定ポートの空き、`ORCH_TOKEN` が既定値でないか。
- WSL 判定とブラウザ起動手段の可否。

---

## 9. 設定（`scripts/orch.env`）
`setup` が `orch.env.example` から生成。`start`/`stop` 等が読み込む。
```bash
HOST=127.0.0.1
PORT=8000
# エージェント実行
ORCH_AGENT_MODE=claude                 # auto|claude|mock
ORCH_DEFAULT_PERMISSION_MODE=bypassPermissions
ORCH_TOKEN=<setup が自動生成>
ORCH_SKILL_REPOS=                      # カンマ区切り（gh前提）
# 保存先（既定 .orch/data, .orch/config）
# ORCH_DATA_ROOT=.orch/data
# ORCH_CONFIG_ROOT=.orch/config
```
- `start` は `ORCH_API_BASE=http://HOST:PORT` を export（callback整合のため）。

---

## 10. prod 単一ポート構成（既定の理由）
- フロントを `npm run build` し、**バックエンドが `dist` を `/` で配信**＋ API/WS を同一ポートで提供。
- ブラウザアクセスとエージェント callback（`ORCH_API_BASE`）が**同一オリジン**になり、CORS/プロキシのズレを排除（過去の不具合予防）。
- 開発時のみ `--dev`（vite 5173 + backend）に切替。

---

## 11. ファイル / ディレクトリ
| パス | 用途 |
|---|---|
| `scripts/orch.sh` | 管理スクリプト本体 |
| `scripts/orch.env(.example)` | 設定（実体は gitignore 推奨） |
| `.node-version` | Node バージョン固定（fnm/nvm 用） |
| `.venv/` | Python 仮想環境（gitignore済） |
| `frontend/dist/` | ビルド済UI（gitignore済） |
| `${XDG_STATE_HOME:-~/.local/state}/agent-orch/` | pid・lock・log・meta（固定ユーザパス） |

---

## 12. 実装インパクト（参考）
- 新規: `scripts/orch.sh`、`scripts/orch.env.example`、`.node-version`。
- 既存への追記: README に「別マシン向けクイックスタート」、`.gitignore` に `scripts/orch.env`。
- バックエンド変更は基本不要（`agent-orch serve` をそのまま利用）。`stop` の進行中Run確認に `/api/attention`（通知仕様と共通）が使えると綺麗（無ければ runs 走査でも可）。

---

## 13. 確定事項
- シングルトン: **1ユーザ1インスタンス**（固定ユーザパス＋flock＋ポートbind）。
- 常駐: **端末クローズ耐性のみ**（nohup/setsid）。OS再起動自動起動は**対象外**。
- 依存自動導入: venv/pip/npm/build は自動。**Node は `--auto-deps` で fnm/nvm により自動導入**、それ以外（Python本体等）は**検出＋案内**。
- 対象環境: **WSL2（Windows側ブラウザ）＋ ネイティブ Linux/macOS でも動作**。

> 仕様確定。次段階で `scripts/orch.sh` を実装。
