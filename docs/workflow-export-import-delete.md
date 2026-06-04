# ワークフローの 保存 / インポート / 削除 仕様

> このツールのワークフロー定義（DFD）を、**ファイルとして保存（エクスポート）**・**取り込み（インポート）**・**削除**するための仕様。
> 本書は [SPEC.md](./SPEC.md) §8.12 を独立・詳細化したもの。ステータス: ドラフト / 最終更新: 2026-06-04

---

## 0. 前提と用語
- ワークフロー定義（工程・成果物ノード・エッジ・各設定）は**常時 SQLite に保存**されている（UIの自動保存）。
- ここでの「**保存（エクスポート）**」は、その定義を**可搬なJSONファイル**として外に出すことを指す（バックアップ・共有・Git管理用）。
- 「**Run（実行）**」「**workdir**」= 工程を実行した履歴と作業ディレクトリ実体（`<data_root>/workflows/<id>/runs/...`）。

## 1. 決定事項（サマリ）
| 項目 | 決定 |
|---|---|
| エクスポート範囲 | **定義のみ**（Run履歴・ログ・コスト・成果物実体は含めない） |
| インポート挙動 | **常に新規ワークフロー**として取り込む（新ID採番・既存を上書きしない） |
| 削除範囲 | **DBカスケード ＋ workdir 実体も削除** |
| 進行中Run | 削除時に `running`/`waiting_qa` の Run があれば**拒否（409）** |

---

## 2. エクスポート（保存）

### 2.1 含めるもの / 含めないもの
**含める（定義）**
- workflow: `name`, `layout_json`
- process: `name`, `type`, `agent_kind`, `agent_model`, `agent_effort`, `permission_mode`, `allowed_tools`, `disallowed_tools`, `goal_md`, `template_id`, `agents_md_append`, `execution_mode`, `pos_x`, `pos_y`, `skills[]`
- artifact: `name`, `type`(text|file|url), `pos_x`, `pos_y`, `source_text`, `source_url`, `source_file_path`, `spec_json`
- edge: `kind`(produces|consumes), 参照（process / artifact）

**含めない（実行履歴）**
- run / run_log / token_usage / review / qa / artifact_value / workdir 実体

### 2.2 ファイル形式（JSON）
- ノード参照は **可搬 ref** で表す：エクスポート時の元IDを `ref` / `process_ref` / `artifact_ref` として保持する。
- `goal_md` 内のトークン `{{artifact:<ref>}}` も ref で持つ（インポート時に新IDへ再マッピングするため）。
- 先頭に `format_version` を持ち、将来の互換性に備える。

```json
{
  "format_version": 1,
  "tool": "agent-process-orchestrator",
  "exported_at": "2026-06-04T00:00:00Z",
  "workflow": {
    "name": "詳細設計フロー",
    "layout_json": {}
  },
  "processes": [
    {
      "ref": "proc_aaaaaaaaaaaa",
      "name": "詳細設計",
      "type": "design",
      "agent_kind": "claude",
      "agent_model": "claude-opus-4-8",
      "agent_effort": "high",
      "permission_mode": "",
      "allowed_tools": "",
      "disallowed_tools": "",
      "goal_md": "{{artifact:art_111111111111}} を満たす詳細設計書を作成する",
      "template_id": "base",
      "agents_md_append": "",
      "execution_mode": "manual",
      "pos_x": 120,
      "pos_y": 140,
      "skills": [
        { "skill_name": "karpathy-guidelines", "skill_source": "git", "skill_ref": "owner/repo#skills/karpathy-guidelines" }
      ]
    }
  ],
  "artifacts": [
    {
      "ref": "art_111111111111",
      "name": "Review後のUSDM PR",
      "type": "url",
      "pos_x": 460,
      "pos_y": 160,
      "source_text": null,
      "source_url": "https://github.com/example/repo/pull/1",
      "source_file_path": null,
      "spec_json": {}
    },
    {
      "ref": "art_222222222222",
      "name": "詳細設計書",
      "type": "file",
      "pos_x": 800,
      "pos_y": 160,
      "source_text": null,
      "source_url": null,
      "source_file_path": null,
      "spec_json": { "path": "output/design.md" }
    }
  ],
  "edges": [
    { "kind": "consumes", "process_ref": "proc_aaaaaaaaaaaa", "artifact_ref": "art_111111111111" },
    { "kind": "produces", "process_ref": "proc_aaaaaaaaaaaa", "artifact_ref": "art_222222222222" }
  ]
}
```

### 2.3 可搬性の注意
- `source_file_path`（file ソース成果物）と `skill_source = "local"` の `skill_ref` は**実行環境のローカルパス**。文字列はそのまま保存するが、**別環境では解決できない**ことがある（インポート後に手動修正）。
- `skill_source = "git"` の `skill_ref`（`owner/repo#path`）は可搬。

---

## 3. インポート

### 3.1 振る舞い
- **常に新規ワークフロー**として取り込む（既存は一切上書きしない）。同じファイルを何度でも取り込め、その都度コピーが増える。
- `format_version` を検証。未知の新しいバージョンは**拒否または警告**。
- 取り込み後は、そのワークフローへ**自動で切り替える**。
- `name` は任意で上書き可能（既定は元の名前。必要なら「(imported)」を付与する運用も可）。

### 3.2 ID 再マッピング手順
1. `artifacts[]` を**新IDで作成**し、`art_ref → 新artifact_id` の対応表を作る。
2. `processes[]` を**新IDで作成**。このとき `goal_md` 内の `{{artifact:<ref>}}` を対応表で**新IDに書き換える**。`skills[]` も併せて登録。
3. `edges[]` を、`process_ref`/`artifact_ref` を新IDへ解決して作成。
- すべて1トランザクションで実施（途中失敗時はロールバック）。

---

## 4. 削除

- ワークフローを **DBからカスケード削除**：process / artifact / edge / process_skill / run / run_log / token_usage / review / qa / artifact_value。
- 加えて **workdir 実体** `<data_root>/workflows/<id>/` を削除（ディスクに残さない）。
- **進行中Runガード**：当該ワークフローに `running` または `waiting_qa` の Run があれば **HTTP 409** を返す（先に停止が必要）。
- UI は**確認ダイアログ**を必ず挟む（不可逆操作）。

---

## 5. API

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/api/workflows/{id}/export` | 定義のみJSONを返す（`Content-Disposition: attachment` でダウンロード） |
| `POST` | `/api/workflows/import` | body = エクスポート文書（任意 `name` 上書き）→ **新規ワークフロー**を返す |
| `DELETE` | `/api/workflows/{id}` | カスケード削除＋workdir削除。進行中Runがあれば 409 |

### リクエスト/レスポンス例
```http
GET /api/workflows/wf_123/export
200 OK  (application/json, Content-Disposition: attachment; filename="詳細設計フロー.workflow.json")
{ "format_version": 1, ... }
```
```http
POST /api/workflows/import
{ "name": "詳細設計フロー (copy)", "document": { "format_version": 1, ... } }
200 OK  → { "id": "wf_new...", "name": "...", "processes": [...], "artifacts": [...], "edges": [...] }
```
```http
DELETE /api/workflows/wf_123
200 OK  → { "ok": true }
409 Conflict → { "detail": "Workflow has active runs; stop them first" }
```

---

## 6. UI
- ワークフロー切替セレクトの近くに **Export / Import / Delete** を配置。
  - **Export**：現在のワークフローをJSONとしてブラウザ保存（Blobダウンロード）。
  - **Import**：ファイル選択 → 中身を `POST /import` → 返ってきた新ワークフローへ切替。
  - **Delete**：確認ダイアログ → `DELETE` → 別ワークフローへ切替（無ければ空状態）。

---

## 7. 実装インパクト（参考）
- **db.py**：`export_workflow(id)`（`get_workflow` から定義サブセット抽出）、`import_workflow(document, name=None)`（ref→ID再マッピング＋`goal_md`書換、トランザクション）、`delete_workflow(id)`。
- **api.py**：export（JSON添付）/ import / delete エンドポイント。delete は workdir を `shutil.rmtree`、進行中Run判定で 409。
- **models.py**：`WorkflowImport`（`document` ＋任意 `name`）。
- **frontend**：ヘッダーに Export(Blob) / Import(file input) / Delete(confirm)、操作後のワークフロー切替。
- **tests**：export→import 往復で定義一致・新ID採番・`goal_md` 再マッピング、delete の workdir 除去・進行中 409。
- DBスキーマ変更は**不要**（既存テーブルのみで実現、非破壊）。

---

## 8. 未確定 / 任意
- インポート名へ自動で「(imported)」「(copy)」を付けるか（既定は元名のまま）。
- 将来拡張：定義＋Run履歴を含む「フルスナップショット」エクスポート、`source_file_path` のファイル同梱、複数ワークフローの一括エクスポート。
