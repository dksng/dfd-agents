# 工程オーケストレーションツール 仕様書

> 本書は `req.md` を仕様書として整理したものです。確定済みの設計判断と、未確定の論点を明示します。
> ステータス: 確定 v1.0 / 最終更新: 2026-06-02

---

## 1. 概要

### 1.1 目的
ローカル環境で、AIコーディングエージェント（Claude Code / 将来的に Codex / Copilot CLI）を**工程（設計・実装・評価など）単位**で実行するためのオーケストレーションツール。
Web UI 上で **DFD（データフロー図）的に工程と成果物を定義・接続**し、各工程を独立したディレクトリで自律エージェントとして駆動させる。人間のレビュー・QA を挟みながら、トークン量とコストをリアルタイムに監視できる。

### 1.2 一言で
**「AIエージェントによる開発工程を、DFDで設計し、ローカルで手動オーケストレーションし、レビュー・コスト管理するワークベンチ」**

### 1.3 確定済みの主要設計判断
| 項目 | 決定 | 備考 |
|---|---|---|
| バックエンド | **Python / FastAPI** | Claude Agent SDK(Python)、skillのPythonスクリプトと相性が良い |
| フロントエンド | **React / TypeScript** | DFDキャンバス・リアルタイム表示 |
| MVP対応エージェント | **Claude Code のみ** | アダプタ層を抽象化し、後から Codex / Copilot を追加 |
| 実行・進行モデル | **手動トリガー型 ＋ 人間レビューゲート** | ユーザが工程を1つずつ実行・承認 |
| 永続化 | **SQLite ＋ ファイルシステム** | メタデータはDB、成果物実体はFS |
| QA/submit通信 | **localhost HTTP API** | utils スクリプトが REST に POST |
| エージェント実行環境 | **ホストプロセス** | 将来的にコンテナ隔離を選択可能にする設計 |
| 成果物の接続 | **成果物を独立ノード化**し `工程→成果物→工程` で接続 | produces/consumes エッジ（§6.1）|
| 料金テーブル | **設定ファイル**（`pricing.yaml`）に記載 | モデル別単価。UIから参照、ファイル編集で更新 |
| 成果物の版管理 | **Run ごとに全保存** | 実行/resume のたびに workdir・output を版として累積 |
| 同時実行 | **複数工程の同時実行可** | 依存のない工程を並行起動。Run は独立プロセス/workdir |
| テンプレート | **共通ベース ＋ 工程ごとに AGENTS.md 追記** | utils（question.py/submit.py）は固定・変更不可 |
| 失敗時の再実行 | **resume / 新規Run をユーザが選択** | session 生存時は resume、無ければクリーン新規Run |
| SKILL 探索 | **リモート git 対象（`gh` 前提）** | ローカルパス＋リモートリポジトリの両対応 |

---

## 2. 用語定義

| 用語 | 定義 |
|---|---|
| **Workflow** | 工程と成果物、それらの接続関係（エッジ）で構成される DFD 全体。1つの「仕事の設計」。 |
| **Process（工程）** | 設計・実装・評価などの作業単位。1つのエージェント実行に対応。consumes/produces で成果物ノードに接続し、割当エージェント、SKILL、Goal.md を持つ。 |
| **Artifact（成果物）** | 工程間で受け渡されるデータ。種別は `file` / `url` / `text`。 |
| **Edge（接続）** | 「上流工程の output artifact」→「下流工程の input artifact」を結ぶ明示的なマッピング。 |
| **Run（実行）** | ある工程の1回のエージェント起動。トークン・コスト・ログ・セッションIDを保持。 |
| **Session** | エージェントの会話セッション。resume により差し戻し・QA後に同一文脈で再開。 |
| **Review** | 工程出力に対する人間の承認/差し戻し（Feedback付き）。 |
| **QA** | エージェントが作業中にユーザへ質問し、回答を得て同一セッションで作業を継続する仕組み。 |
| **Skill** | `.claude/skills/<name>/` 形式の能力定義。工程に割当てるとコピーが注入される。 |

---

## 3. スコープ

### 3.1 MVP に含む
- Web UI による DFD ワークフロー設計（工程・成果物の追加/削除/接続）
- 工程ごとのエージェント（Claude Code）・SKILL・Goal.md 設定
- 工程ディレクトリの自動生成と成果物注入
- 手動トリガー実行 ＋ リアルタイム出力ストリーミング
- QA（質問→回答→resume）
- 人間レビュー（承認/差し戻し→Feedback→resume）
- 成果物ビューア（file=DL / text=表示 / url=リンク）
- トークン・コストのリアルタイム監視（Run単位・Workflow単位）
- 環境変数で指定したリポジトリからの SKILL 検索・選択
- Goal.md 記述時の in/out 成果物名のオートコンプリート（`/` トリガー）

### 3.2 MVP に含まない（将来拡張）
- Codex / Copilot CLI アダプタ
- 自動カスケード実行（承認後の下流自動起動）
- コンテナによる工程隔離実行
- マルチユーザ / 認証 / 権限管理
- ワークフローのバージョン管理・テンプレート共有
- 分岐・条件・ループなど高度なフロー制御

---

## 4. アクターとユースケース

### 4.1 アクター
- **設計者/オペレータ（単一ユーザ）**: ワークフローを設計し、工程を実行・レビューする人間。
- **エージェント**: 工程ディレクトリ内で駆動する Claude Code プロセス。

### 4.2 主要ユースケース
1. ワークフローを新規作成し、工程・成果物をDFDで配置・接続する
2. 工程にエージェント/SKILL/Goal.md を設定する
3. 工程を実行し、出力をリアルタイムで監視する
4. エージェントからのQAに回答する
5. 出力をレビューし、承認 or 差し戻し（Feedback）する
6. 差し戻し後、エージェントが同一セッションで修正する
7. Workflow全体のトークン・コストを確認する

---

## 5. システムアーキテクチャ

### 5.1 構成図
```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (React/TS)                       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │ DFD Canvas   │ │ Process       │ │ Live Log / Cost      │  │
│  │ (workflow)   │ │ Config Panel  │ │ Dashboard            │  │
│  └──────────────┘ └──────────────┘ └──────────────────────┘  │
└───────────────▲───────────────────────────▲──────────────────┘
       REST/JSON │                WebSocket  │ (logs, cost, QA, status)
┌───────────────┴───────────────────────────┴──────────────────┐
│                  Backend (FastAPI / Python)                    │
│  ┌────────────┐ ┌─────────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ Workflow   │ │ Execution    │ │ Skill    │ │ Cost/Token  │  │
│  │ Service    │ │ Engine       │ │ Registry │ │ Meter       │  │
│  └────────────┘ └─────┬───────┘ └──────────┘ └─────────────┘  │
│  ┌────────────┐ ┌──────┴───────┐ ┌──────────────────────────┐ │
│  │ SQLite     │ │ Agent Adapter │ │ utils callback API       │ │
│  │ (metadata) │ │ (Claude SDK) │ │ /api/qa /api/submit      │ │
│  └────────────┘ └──────┬───────┘ └──────────▲───────────────┘ │
└────────────────────────┼────────────────────┼─────────────────┘
                         │ spawn (host process)│ localhost HTTP
              ┌──────────▼────────────────────┴──────────┐
              │   Process Working Directory (per Run)      │
              │   .claude/skills/ input/ output/           │
              │   AGENTS.md Goal.md utils/                  │
              │      └─ Claude Code agent runs here         │
              └────────────────────────────────────────────┘
```

### 5.2 コンポーネント責務
- **Workflow Service**: ワークフロー/工程/成果物/エッジのCRUD、永続化。
- **Execution Engine**: 工程ディレクトリ生成 → 成果物注入 → エージェント起動 → ストリーム集約 → 状態遷移。
- **Agent Adapter**: エージェント差異を吸収する抽象インタフェース（MVPは ClaudeAdapter のみ実装）。start / resume / streamイベント / token・cost取得 を提供。
- **Skill Registry**: ローカルおよび環境変数指定リポジトリ内 SKILL の探索・コピー注入。
- **Cost/Token Meter**: SDKイベントからトークンを集計し、料金テーブルでコスト換算。
- **utils callback API**: 工程内 `question.py` / `submit.py` からの localhost HTTP 受け口。

---

## 6. ドメインモデルとデータモデル

### 6.1 ドメイン関係（成果物ノード方式）
成果物（Artifact）は**工程と並ぶ第一級ノード**。DFDは `工程 →(produces)→ 成果物 →(consumes)→ 工程` で描く。
```
Workflow 1───* Process
Workflow 1───* Artifact            -- 独立ノード（name, type, 位置, ソース値）
Workflow 1───* Edge                -- kind='produces' (Process→Artifact) | 'consumes' (Artifact→Process)
Process  1───* Run 1───* QA / 1───* Review / 1───1 Session
Run      1───* ArtifactValue       -- そのRunが生成した成果物の実値（artifact_id 紐付け）
```
**制約**
- `produces`：1つの成果物の生成元は**最大1工程**（0件＝ソース成果物）。1工程は**複数成果物**を生成可。
- `consumes`：**fan-out可**（1成果物→複数工程）。同一工程が同一成果物を二重consumeは不可。
- 成果物経由で構成される工程間有向グラフに**循環を作るエッジは拒否**。
- 工程の `input/` ＝その工程に `consumes` で入る成果物群、`output/` ＝その工程が `produces` する成果物群。

### 6.2 SQLite スキーマ（主要テーブル・概略）
```sql
workflow(id, name, created_at, updated_at, layout_json)

process(id, workflow_id, name, type,           -- type: design|implement|evaluate|...
        agent_kind,                             -- 'claude' (MVP)
        agent_model, goal_md, template_id,
        agents_md_append,                       -- 共通base AGENTS.md への工程別追記
        pos_x, pos_y, execution_mode)           -- execution_mode: 'manual' (MVP)

artifact(id, workflow_id,                       -- 独立した成果物ノード
        name, type,                             -- type: file|url|text
        pos_x, pos_y,                           -- キャンバス座標
        source_text, source_url, source_file_path,  -- ソース成果物（producer無し）の値
        spec_json)

process_skill(process_id, skill_name, skill_source, skill_ref)

edge(id, workflow_id,
     kind,                                      -- 'produces' | 'consumes'
     process_id, artifact_id)                   -- produces: process→artifact / consumes: artifact→process
-- 制約:
--   produces は artifact ごとに最大1件: UNIQUE INDEX(workflow_id, artifact_id) WHERE kind='produces'
--   consumes の二重接続防止:            UNIQUE INDEX(process_id, artifact_id, kind)

run(id, process_id, status,                     -- status: §8.2 参照
    session_id, started_at, ended_at,
    input_snapshot_json, output_snapshot_json,
    workdir_path)

run_token_usage(id, run_id, ts, input_tokens, output_tokens,
    cache_read, cache_write, cost_usd, model)

qa(id, run_id, question_text, answer_text, status, created_at, answered_at)

review(id, run_id, status, feedback_text,       -- status: pending|approved|rejected
    created_at, resolved_at)

artifact_value(id, run_id, artifact_id, artifact_type,
    file_path, url, text_value)                 -- そのRunが生成した成果物の実体メタ（fileはworkdir内パス）
```

### 6.3 ファイルシステム配置
```
<CONFIG_ROOT>/
  pricing.yaml                   # 料金テーブル（§8.8）
  templates/
    base/AGENTS.md               # 共通ベース AGENTS.md
    base/utils/{question,submit}.py   # 固定 utils（変更不可）
  skills_cache/<owner>/<repo>@<ref>/  # gh で取得したリモートSKILLのキャッシュ

<DATA_ROOT>/
  app.db                         # SQLite
  workflows/<workflow_id>/
    runs/<run_id>/               # = 工程ワーキングディレクトリ（§7）。Run単位＝版（§8.9）
```

---

## 7. 工程ワーキングディレクトリ仕様

各工程の各 Run ごとに新規ディレクトリを生成し、テンプレートと成果物を注入する。

```
<workdir>/
├── .claude/
│   └── skills/
│       └── <skill-name>/        # 工程に指定された SKILL のコピーを注入
├── input/
│   ├── input.yaml               # 入力成果物の定義（下記スキーマ）
│   └── <file artifacts...>      # type:file の実体（input/ 配下に配置）
├── output/
│   ├── output.yaml              # 出力成果物の定義（input.yaml と同形式）
│   └── <file artifacts...>      # エージェントが生成する成果物
├── AGENTS.md                    # テンプレートから注入。Goal/構成/utils利用方針を指示
├── Goal.md                      # 工程ごとに設定したゴール（in/out名を埋め込み可）
└── utils/
    ├── question.py              # ユーザへのQA送信（localhost HTTP）
    └── submit.py                # 成果物提出/レビュー依頼（localhost HTTP）
```

### 7.1 input.yaml / output.yaml スキーマ
```yaml
input:
  - id: artifact_xxx
    name: design_doc
    type: file                 # file | url | text
    path: input/hoge.md        # type:file のとき。実体は input/ に存在
  - id: artifact_yyy
    name: usdm_pr
    type: url
    url: https://github.com/anthropics/skills/pull/1229
  - id: artifact_zzz
    name: branch_name
    type: text
    text: hmi/dev/milestone_1
```
- `type: file` → 実体は `input/` 配下に配置済み、`path` で参照。
- `output.yaml` も同形式。エージェントは `output/` に実体を生成し `output.yaml` に登録する。

#### 入出力の導出（成果物ノード方式）
- `input.yaml` ＝ その工程が `consumes` する成果物群。各成果物の値は:
  - **producerあり** → 生成元工程の**最新承認Run**の `artifact_value` から取得（file は input/ にコピー）。
  - **ソース成果物（producer無し）** → 成果物ノードに保存された `source_*` 値を使用。
- `output.yaml` ＝ その工程が `produces` する成果物群（期待出力）。`id` には **artifact_id** を埋め込み、エージェントは値を変更しない（§7.2 と同様の不変規約）。
- 各 `input`/`output` 項目の `id` は **artifact_id**（旧 port_id 廃止）。

### 7.2 AGENTS.md / utils の役割と管理
- **AGENTS.md**: このディレクトリ構成と `Goal.md` を満たすよう `output/` を完成させる指示、および QA は `utils/question.py`・提出は `utils/submit.py` を使う旨を含む。
  - **共通テンプレート（base AGENTS.md）をベースに注入**し、その後に**工程ごとの追記内容を末尾に連結**する。
  - 実体: `<base AGENTS.md>` ＋ `\n` ＋ `process.agents_md_append`（工程設定でUI編集可）。
- **utils（question.py / submit.py）**: **固定・変更不可**。共通テンプレートのものをそのまま注入し、ユーザ/工程からの改変対象にしない（QA/submit プロトコルの一貫性を担保）。
- テンプレートはリポジトリ内で管理し、工程種別ごとの base を持てる（§5.2 Skill/Template 管理、§12 参照）。

### 7.3 utils スクリプトの通信（localhost HTTP）
- 起動時に環境変数で `ORCH_API_BASE`（例 `http://127.0.0.1:PORT`）, `ORCH_RUN_ID`, `ORCH_TOKEN` を注入。
- `question.py`: `POST /api/runs/{run_id}/qa` で質問を登録 → 回答が返るまで待機（ロングポーリング/ブロッキング）。
- `submit.py`: `POST /api/runs/{run_id}/submit` で成果物提出・レビュー依頼。

---

## 8. 機能要件

### 8.1 ワークフロー設計UI（DFD）
- キャンバス上に**工程ノード**と**成果物ノード**を独立配置（`工程 → 成果物 → 工程` のDFD）。
- ドラッグ&ドロップで接続：`工程(出力ハンドル) → 成果物`（produces）、`成果物 → 工程(入力ハンドル)`（consumes）。
- 工程・成果物を随時**追加/削除**可能。成果物ノードは name / type(file|url|text) を持つ。
- **ソース成果物**（producerエッジ無し）は、ノードのインスペクタで**値（text/url/file）をユーザ入力**。
- 接続制約：成果物の生成元は最大1工程、consumesはfan-out可、循環エッジは拒否（§6.1）。
- レイアウト（両ノードの座標）は各ノードの `pos_x/pos_y` ＋ `workflow.layout_json` に永続化。

### 8.2 工程の実行と状態遷移（手動トリガー型）
状態遷移:
```
draft ─(実行)→ running ─(submit)→ in_review
in_review ─(承認)→ approved
in_review ─(差し戻し+Feedback)→ running(resume) ── …
running ─(QA発生)→ waiting_qa ─(回答)→ running(resume)
running ─(失敗)→ failed
```
- 下流工程の実行は**ユーザが手動で起動**（MVPでは自動カスケードしない）。
- 実行時に Execution Engine が workdir を生成し、接続元の output 成果物を本工程の input に注入。

### 8.3 QA機構
- エージェントが `question.py` 経由で質問 → UI の通知/QAパネルに表示。
- ユーザが回答 → エージェントは**同一セッションを resume** し、フィードバックとともに作業継続。

### 8.4 レビュー / 差し戻し
- 工程は基本的に人間レビューを通す。
- `submit.py` で提出された成果物は **Review アイテム**として UI に表示:
  - `file` → ブラウザからダウンロード可能
  - `text` → テキストボックスに表示
  - `url` → リンクで表示
- **承認** → 工程 approved、下流を手動起動可能に。
- **差し戻し** → Feedback を受け取り、**元のエージェントセッションを resume** して成果物を修正。

### 8.5 SKILL 設定と検索
- 工程ごとに割当エージェントが使う SKILL を指定。
- **環境変数（例 `ORCH_SKILL_REPOS`）にリポジトリを設定**しておくと、そのリポジトリ内の SKILL（`SKILL.md` を含むディレクトリ）を自動探索して選択可能。
- **探索対象はローカルパスとリモート git の両方**。リモートは **`gh` CLI が利用可能な前提**で取得する（`gh repo clone` / `gh api` 等）。取得したリポジトリはローカルにキャッシュし、`SKILL.md` を持つディレクトリを走査して候補化。
- 実行時、選択した SKILL のコピーを workdir の `.claude/skills/<name>/` に注入。
- リモート参照は `skill_source`（local|git）と `skill_ref`（パス or `owner/repo[@ref]/path`）で永続化（§6.2 `process_skill`）。

### 8.6 Goal.md オートコンプリート
- Goal.md 記述欄で、その工程に**接続済みの成果物ノード**（consumes/produces 両方）の名前を `/` トリガーで候補表示しショートカット入力。
- 例: `{Review後のUSDM PR}の内容を満たした、{詳細設計書} が完成している。`
  - `/` 入力時に接続済み成果物 `{Review後のUSDM PR}` を候補から選択。
- 内部的にはトークン（`{{artifact:<artifact_id>}}`）として保存し、実行時に成果物名へ解決。

### 8.7 リアルタイム出力
- 実行中のエージェント標準出力/イベントを WebSocket で UI にストリーミング表示。

### 8.8 トークン・コスト監視
- エージェント呼び出し（Run）ごとに使用トークンを SDK イベントから集計。
- **料金テーブルは設定ファイル `pricing.yaml`** にモデル別単価（input / output / cache_read / cache_write、USD/1Mトークン等）を記載。バックエンドが起動時に読み込み、コスト換算してリアルタイム表示。
  ```yaml
  # pricing.yaml 例
  currency: USD
  models:
    claude-opus-4-8:
      input: 15.0          # per 1M tokens
      output: 75.0
      cache_read: 1.5
      cache_write: 18.75
  ```
- **Run 単位**および **Workflow 全体**での累積トークン・コストを可視化。

### 8.9 成果物の版管理（Run単位）
- 実行・resume・差し戻し修正のたびに **Run を版として全保存**（workdir・output実体・トークン履歴を含む）。
- UI から版（Run履歴）を選択し、output 成果物の参照・ダウンロード・版間 diff（file/text）が可能。
- 「最新承認版」を工程の確定出力として下流へ供給する。

### 8.10 同時実行
- 依存関係（エッジ）のない工程は**複数同時に実行可能**。
- 各 Run は独立プロセス・独立 workdir のため相互干渉しない。UI は実行中Runを一覧表示。

### 8.11 失敗・中断時の再実行
- Run が `failed` の場合、UI から **「resume」または「新規Run」** を選択。
  - **resume**: session_id が生存していれば同一セッションで継続（途中文脈を維持）。
  - **新規Run**: クリーンな workdir で再起動（session 喪失時の既定）。

---

## 9. API 設計（主要・概略）

### 9.1 REST（UI ⇄ Backend）
```
# Workflow / 設計
GET    /api/workflows
POST   /api/workflows
GET    /api/workflows/{id}
PUT    /api/workflows/{id}            # ノード/エッジ/レイアウト更新
POST   /api/workflows/{id}/processes
DELETE /api/processes/{id}
POST   /api/workflows/{id}/artifacts       # 成果物ノード作成（name/type/座標/ソース値）
PUT    /api/artifacts/{artifact_id}        # 成果物の更新（ソース値・name・type・座標）
DELETE /api/artifacts/{artifact_id}
POST   /api/workflows/{id}/edges           # {kind:'produces'|'consumes', process_id, artifact_id}
DELETE /api/edges/{id}

# 工程設定
PUT    /api/processes/{id}/config     # agent/model/goal_md/skills
GET    /api/skills?repo=...           # SKILL 検索（env指定リポジトリ含む）

# 実行・レビュー
POST   /api/processes/{id}/run        # 手動トリガー実行
POST   /api/runs/{run_id}/resume      # QA回答後/差し戻し後の再開
GET    /api/runs/{run_id}
POST   /api/runs/{run_id}/review      # approve/reject + feedback
GET    /api/runs/{run_id}/artifacts/{artifact_id}/download

# コスト
GET    /api/workflows/{id}/cost
GET    /api/runs/{run_id}/cost
```

### 9.2 utils コールバック（工程スクリプト → Backend, localhost）
```
POST   /api/runs/{run_id}/qa          # question.py: 質問登録→回答待ち
POST   /api/runs/{run_id}/submit      # submit.py: 成果物提出/レビュー依頼
```

### 9.3 WebSocket（Backend → UI）
```
/ws/runs/{run_id}    # log行 / status遷移 / token・cost増分 / QA発生 通知
```

---

## 10. 実行シーケンス（工程1回の実行）

```
User ─run→ Backend
  Backend: workdir 生成 / .claude/skills 注入 / input.yaml+実体注入 /
           AGENTS.md・Goal.md（成果物名解決）・utils 配置
  Backend ─spawn(host)→ Claude Code (session作成, session_id保存)
  Agent ─stream→ Backend ─WS→ UI（ログ/トークン/コスト）
  ┌ QA: Agent→question.py→POST /qa→UI通知→User回答→resume(同session)
  └ 完了: Agent→submit.py→POST /submit→status=in_review
  User: Review
    ├ approve → status=approved（下流を手動起動可能）
    └ reject(feedback) → resume(同session) で修正 → 再 submit
```

---

## 11. 非機能要件

- **動作環境**: ローカル単一マシン / 単一ユーザ。ブラウザからアクセス。
- **エージェント実行**: ホストプロセスとして起動（ホストの Claude 認証・環境を利用）。
- **拡張性**: Agent Adapter 抽象化により Codex / Copilot を後付け可能。実行環境もホスト/コンテナを選択可能な設計余地を残す。
- **可観測性**: ログ/トークン/コストを Run 単位で永続化し後から参照可能。
- **データ保全**: workdir と成果物は Run 単位で保存し、差し戻し履歴を追跡可能。

---

## 12. 論点の確定状況

### 12.1 確定済み（本書に反映済み）
| # | 論点 | 決定 |
|---|---|---|
| 1 | 料金テーブルの管理 | **設定ファイル `pricing.yaml`** に記載（§8.8） |
| 2 | 成果物の世代管理 | **Run ごとに全保存・版管理**（§8.9） |
| 3 | 同時実行 | **複数工程の同時実行可**（§8.10） |
| 4 | テンプレート管理 | **共通ベース ＋ 工程ごとに AGENTS.md 追記。utils は固定**（§7.2） |
| 5 | failed/中断時の再実行 | **resume / 新規Run をユーザ選択**（§8.11） |
| 6 | SKILL 探索リポジトリ | **ローカル＋リモート git（`gh` 前提）**（§8.5） |

### 12.2 確定（軽微な論点・採用方針）
| # | 論点 | 決定 |
|---|---|---|
| A | セッション resume の上限 | **SDK のコンパクション任せ**。上限超過時は警告表示のみ（打ち切りはしない） |
| B | 成果物 `url` の検証 | **検証せずリンク表示のみ**（到達性は人間レビューで担保） |
| C | UI のDFD描画基盤 | **React Flow を採用**（ノード/エッジ/ポート/ドラッグ接続が標準対応） |
| D | リモートSKILLキャッシュ更新 | **明示的な「更新」操作 ＋ ref（タグ/ブランチ/SHA）でピン留め** |

> 全論点が確定済み。以降の細部は実装フェーズで本書に追記する。

---

## 付録A: req.md との対応
本書は `req.md`（やりたいこと一覧）の全項目を、確定した設計判断（§1.3）を反映して構造化したものです。原文の要求はすべて §3〜§8 に反映済みです。
