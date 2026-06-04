# リファクタリング計画

> コードベース全体を俯瞰し、保守性向上のための段階的リファクタリングを計画したもの。
> ステータス: ドラフト / 最終更新: 2026-06-04

---

## 1. 現状サマリ（ホットスポット）

| モジュール | 行数 | 主な問題 |
|---|---|---|
| **frontend/src/App.tsx** | **2477**（`App()` 本体 ≈1860 / useState 44・useEffect 14・useCallback 10・api呼び出し 44） | 単一巨大コンポーネントが全機能（ロード・選択・ドラフト・autosave・グラフ・QA・レビュー・diff・export/import・skills・settings・health・ログ）を保持。**最優先** |
| **agent_orchestrator/db.py** | **1116** | `Store` 神オブジェクト。8エンティティのCRUD＋スキーマ＋マイグレーション＋コスト集計＋循環検出＋export/import を1クラスに集約。全メソッドが `dict[str, Any]` を返し型安全性が無い |
| **agent_orchestrator/execution.py** | 525 | `ExecutionEngine`（状態機械・QAポーリング・プロセス管理・usage/コスト・publish）と Adapter群（subprocess・stream-json解析・権限/コマンド生成・prompt）が混在 |
| **agent_orchestrator/api.py** | 371 | 全約30ルートが単一の `create_app` クロージャ内。`KeyError→404 / ValueError→409` のtry/exceptが**ほぼ全ルートで重複** |
| その他 | — | workspace.py(184)・skills.py(142)・config.py(111)・models.py(109) は比較的健全 |

- テスト: `tests/test_api.py` に集約、**34 passed**（バックエンドは良好なカバレッジ。フロントはテスト無し）。
- **注意**: 着手時点で作業ツリーに別作業の未コミット変更（AppSettings / skill_repos / source-file 等が api/db/execution/models/skills/workspace に）が残存。

---

## 2. 原則

- **挙動不変**かつ**段階的**。各ステップで `python3 -m pytest`（34）green ＋ `npm run build` 成功を維持する。ビッグバン書き換えはしない。
- **着手前に in-flight の未コミット変更を確定（コミット）**してクリーンツリーにする（衝突回避）。
- 順序は **バックエンド（テストで守られる・低リスク）→ フロント（テスト薄く慎重に）**。
- 1コミット = 1関心事。各コミットでビルド/テストを緑に保つ。

---

## 3. フェーズ別計画

### Phase 0 — 下地（目安: 半日）
1. **Lint/Format 導入**: Python に `ruff`（lint+format）、TS に `eslint` + `prettier`。`make lint` / `npm run lint` を用意し、機械的差分を一括適用して基準化。
2. **ドメイン例外の定義**: `agent_orchestrator/exceptions.py` に `NotFoundError` / `ConflictError` / `ValidationError`。`Store` 等の `raise KeyError / ValueError` を置換。
3. **FastAPI 例外ハンドラで中央化**: 上記例外 → 404 / 409 / 422 にマップする例外ハンドラを登録し、**api.py の全 try/except を削除**（各ルートが大幅に痩せる）。

### Phase 1 — バックエンド構造化（目安: 2〜3日）
4. **db.py の分割**（`Store` 神オブジェクトの解体）:
   - `db/connection.py`（`connect()` / PRAGMA）、`db/schema.py`（SCHEMA 定数）、`db/migrations.py`（additive / reset 判定）、`db/serde.py`（`_json_load` / `_json_dump`、row→dict）。
   - `repositories/{workflow,process,artifact,edge,run,review,qa,usage}.py` に分割。`get_workflow` の組み立て・export/import は `WorkflowRepository` に集約。
   - 共通 `connect()` を共有し、**export/import/delete のトランザクション境界を明示**（現状はメソッド単位で接続を開く）。
5. **execution.py の分割**:
   - `adapters/` パッケージ化: `adapters/base.py` / `mock.py` / `claude.py`。
   - **純粋関数を抽出**（テスト容易化）: `claude_stream.py`（`_parse_event` / `_usage_for_event` / `_final_cost_for_event` / `_normalize_usage`）、`claude_command.py`（`_command_for_process` / `_apply_permissions` / `_split_tools`）。
   - **状態機械の明文化**: `run_state.py` に `RunStatus` enum ＋ 許可遷移（現状の `RUN_STATUSES_ALLOWING_*` 定数とガードを集約）。
   - `ExecutionEngine` はオーケストレーション（QAポーリング・プロセス登録・publish）に専念し痩せさせる。
6. **api.py のルーター分割**:
   - `routers/{system,workflows,processes,artifacts,edges,runs,skills,settings}.py`（`APIRouter`）＋ `deps.py`（`get_store` / `get_engine` を `Depends` で注入）。
   - `create_app` は組み立てとミドルウェア/ハンドラ登録だけに縮小。

### Phase 2 — フロント構造化（目安: 3〜5日・最重要）
7. **純粋ヘルパーを `lib/` へ抽出**（低リスク・即効）:
   - `lib/logClassify.ts`（`classifyLog` / `summarizeToolInput` / `firstLine` / `toolResultText`）。
   - `lib/goal.ts`（`normalizeGoalForDisplay` / `normalizeGoalForStorage` / `artifactDisplayLabel`）。
   - `lib/format.ts`（`formatCost` / `compactModelName` / `simpleLineDiff` / `sourceFileName`）。
   - `lib/payloads.ts`（`processPayload` / `artifactPayload`）。
8. **コンポーネント抽出**（`components/`）:
   - `LogViewer` / `LogCard`、`ProcessFlowNode` / `ArtifactFlowNode`、`Topbar`、`WorkflowControls`（rename / export / import / delete）、`LeftPanel`、`CanvasView`、`ProcessInspector`、`ArtifactInspector`、`ReviewPanel`。
9. **カスタムフックで状態を分離**（`hooks/`）:
   - `useWorkflow`（load / select / CRUD / rename）、`useDrafts`（process / artifact ＋ デバウンス autosave）、`useRunStream`（選択Run・WS・ポーリング）、`useFlowGraph`（nodes / edges / onConnect / onNodesChange / 位置）、`useHealth`、`useSkills`、`useGoalAutocomplete`。
   - **目標**: `App()` を「レイアウト＋フック呼び出し」だけの薄い容器（〜200行）に。

### Phase 3 — 契約・品質（任意・目安: 1〜2日）
10. **型のドリフト防止**: FastAPI の `/openapi.json` から `openapi-typescript` で `types.gen.ts` を生成し、手書き `types.ts` を置換（バック↔フロントの不整合を機械的に防止）。
11. **テスト整理/補強**: `tests/` を `test_workflows / test_runs / test_permissions / ...` に分割。抽出した純粋モジュール（`claude_stream` / `claude_command` / `run_state`）に**ユニットテスト追加**。フロントは Vitest で `logClassify` / `goal` の純粋関数テストだけでも導入。

---

## 4. 優先順位と効果

| 施策 | 効果 | リスク | 推奨順 |
|---|---|---|---|
| Phase 0（例外中央化・lint） | 中（api.py が即痩せる） | 低 | **1** |
| Phase 2-7（lib 抽出） | 高（App.tsx が即軽量化） | 低 | **2** |
| Phase 1（db / execution / api 分割） | 高（保守性） | 低（テストで担保） | 3 |
| Phase 2-8/9（component / hook） | 最高（フロント保守性） | 中（テスト薄） | 4 |
| Phase 3（型生成・テスト） | 中 | 低 | 5 |

**最初の一手**: リスクが低く効果が見える **Phase 0**（ドメイン例外＋FastAPI例外ハンドラで api.py の try/except を一掃）と **Phase 2-7**（App.tsx の純粋ヘルパーを `lib/` へ抽出）。どちらもテスト/ビルドを緑のまま小さく刻める。

---

## 5. 進め方（チェックリスト）
- [x] 未コミットの in-flight 変更を確定（クリーンツリー化）
- [x] Phase 0: lint/format 導入、例外中央化 → api.py の try/except 削除（lint/test/build 緑を確認）
- [x] Phase 2-7: lib/ へ純粋関数抽出（build 緑を確認）
- [ ] Phase 1: db.py → repositories、execution.py → adapters/純粋関数、api.py → routers（execution/api は完了、db repository 分割は未完了）
- [ ] Phase 2-8/9: components/ と hooks/ へ分解、App() を薄く
- [ ] Phase 3: 型生成・テスト分割/補強

各フェーズは独立して着手・中断可能。1コミット1関心事を厳守し、緑を維持する。
