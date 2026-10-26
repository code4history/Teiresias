# Teiresias

[![CI](https://github.com/code4history/Teiresias/actions/workflows/test.yml/badge.svg)](https://github.com/code4history/Teiresias/actions/workflows/test.yml)

`@c4h/teiresias` estimates the best CRS and world-file parameters from GCPs and a supplied candidate CRS set.

- Input: GCPs plus candidate CRSs
- Output: selected CRS plus world-file 6 parameters
- Runtime: Node.js と browser（bundler = 検証済 ／ 実ブラウザ = 1 回観測済 ／ 継続的・自動のブラウザ実行は未検証。下記「既知の制限」）
- Scope: 当てはめの統括。カタログ検索は行わない（候補は呼出側が渡す）

English README is [here](./README.md).

## 公開 API

`package.json` の `exports` は public root `"."` のみである。公開されるのは `estimateCrs` と
公開型だけで、内部 helper（ranking / status 導出）は公開しない。

```ts
import { estimateCrs } from '@c4h/teiresias';
import type { CandidateCrs, EstimateOptions, EstimationResult } from '@c4h/teiresias';

const result: EstimationResult = await estimateCrs(gcps, candidates, {
  transformer,                 // 必須。候補 CRS への変換 adapter
  geoBasis,                    // 省略時 { kind: 'lonlat_deg', axisOrder: 'lon-lat' }
  minCandidates,               // 省略時 1
  topK,                        // 省略時 usable 全件
  normalizeEpsilonMeters,      // 省略時 100（m）
  datumFamilyPrior,            // 省略時 中立（prior なし）
});
```

`WorldFile` / `GcpPair` / `GeoBasis` / `FitStatus` / `QualityGate` / `FitWarning` /
`MaybePromise` は `@c4h/daedalus` の公開型を再 export したものであり、Teiresias では再定義しない。

### `CandidateCrs` と identity

候補は `{ authority, code, datumFamily? }` の最小構造型で渡す。candidate id は Teiresias が
`` `${authority}:${code}` `` として 1 箇所で組み立てるため、呼出側が独立した id を渡すことはない。
`authority` / `code` の空文字は候補失敗、identity の重複は最初の 1 件だけを評価する。

### `CandidateTransformer` の契約

呼出側が注入する transformer は次の契約を満たすこと。

| # | 契約 |
|---|---|
| (1) | id は `` `${authority}:${code}` `` |
| (2) | 入力は `geoBasis` が示す順序の geo 点列（同順） |
| (3) | 出力は同順同数の projected `[easting, northing]` 点列 |
| (4) | 空入力は `null`（`[]` を返さない） |
| (5) | 一点でも非有限 / 変換不能なら全体 `null`（部分成功を返さない） |
| (6) | 入出力の長さ不一致は adapter contract failure |
| (7) | 業務的に変換不能な事象は `null`。throw は adapter bug のときだけ |
| (8) | 同じ id・点列・basis に対して決定的 |

同期返却と `Promise` 返却の双方が適合する。Teiresias は候補を**入力順に逐次**処理し、
返却を `await` で正規化する（failure / warning の順序と adapter 呼出し順を決定的にするため）。

transformer の成功出力を **metre の projected `[E, N]`** と解釈する。Teiresias は
Daedalus へ常に `{ kind: 'planar_xy', axisOrder: 'xy', unit: 'm' }` を渡し、入力側 `geoBasis` を
そのまま横流ししない。native 単位が metre でない候補の扱いは現在の API に存在しない。

## ranking と score

- 順位は **shear 前の basic（similarity）RMS** で決める。Daedalus が最終的に affine を採用し得るため、
  final RMS を順位に使うと「affine が誤候補を救済して順位を逆転する」ことが起きる。
- `score = basicRmsMeters / L_geo`。`L_geo` は入力 GCP 全体に共通する観測域スケール（m）であり、
  同じ推定呼出し内では basic RMS 昇順と同値である。score は観測域に対する相対誤差であり、
  確率・信頼度ではない。
- 同着（機械精度内）のときだけ `datumFamilyPrior` の指定順が働く。prior は明確な fit 差を逆転しない。
  最後は identity の code-unit 順で決定的に閉じる。

### `rmsMeters` の意味の違い（重要）

| 値 | 意味 |
|---|---|
| `ranked[].rmsMeters` / `selected.rmsMeters` | **ranking に用いた shear 前 basic RMS** |
| `selected.worldFile` / `selected.qualityGate` | **同じ候補に対する Daedalus の最終返却**（affine 採用を含み得る） |

∴ `selected.worldFile` が affine のとき、`selected.rmsMeters` はその worldFile の残差ではない。
final RMS を別名で公開する API は無い。

## status と診断

| 条件 | `status` | `selected` |
|---|---|---|
| usable 件数 >= `minCandidates`、選択候補の warnings 0 件 | `ok` | 先頭候補 |
| usable 件数 >= `minCandidates`、選択候補の warnings 1 件以上 | `ok_with_warnings` | 先頭候補 |
| usable 件数 < `minCandidates` | `insufficient` | `null` |
| usable 0 件で adapter contract failure / adapter bug / dependency contract failure が 1 件以上 | `failed` | `null` |

最後の 2 条件が重なる場合は、実装失敗を候補不足へ埋没させないため `failed` を優先する。

- `warnings` は成功時は **selected 候補の Daedalus `FitWarning` だけ**を同順・同形で返す。
  敗北候補の warning を identity なしで混ぜない。`WarningCode` は Daedalus の凍結 7 値のままで、
  transformer の失敗を既存 code へ流用しない。
- `untransformableIds` は **transformer / candidate 入力層の失敗だけ**を候補入力順・重複なしで収容する。
  Daedalus fitting 層の不足（`insufficient` / `unusable`）とは混ぜない。
  `ranked` / `selected` の identity と交差しない。

## 保存境界

`EstimationResult` は**診断返却**である。Editor が明示的に採用した後に永続化してよいのは
**選択された identity と採用 worldFile だけ**である。

`ranked` / `score` / basic RMS / `qualityGate` / `warnings` / `untransformableIds` /
`selected` object 全体は保存しない。`qualityGate: 'preview'` の返却も同様で、保存・採用の判断は
ライブラリではなく Editor の責務である。

## 既知の制限

- **ブラウザ対応の 3 段**（ある段の実績を別の段へ流用しない）:
  - **bundler = 検証済み**: `pnpm run verify:demo-bundle`（`scripts/verify-demo-browser-bundle.mjs`）が
    demo build の出力チャンクを走査し、Node 固有指定子が残っていないことと Daedalus 由来コードが
    実在することを機械検証する。CI（`.github/workflows/{test,deploy}.yml`）から継続的に走る。
  - **browser runtime = 手動で 1 回確認済み**: 2026-08-29 に `demo/crs-estimate-ranking.html`
    を実ブラウザで開き、proj-wasm の初期化・候補順位・y 軸反転による識別力の消滅・GCP ドラッグによる
    順位入替を確かめた。**1 回の手動確認であって自動テストではない ∴ 回帰は防げない。**
  - **CI 上での継続的・自動のブラウザ実行と canvas ドラッグの自動操作 = 未対応。**
- **実 engine の E2E は接続済み**: `tests/estimate-crs.real-engine.e2e.test.ts` が実 CRS engine
  （Atlas / proj-wasm）を注入した E2E を持つ。mock E2E（`estimate-crs.e2e.test.ts`）は
  契約の決定的な検証として併存する。
- **`status: 'ok'` は現行公開 API から到達不能**: `EstimateOptions` は Daedalus の `holdout` を
  公開しないため、実 Daedalus の成功 fit は必ず warning を 1 件以上持つ。分岐は `FitStatus` 互換と
  将来の holdout 対応のために保持し、内部 helper の単体検証で担保している。
- **単位**: 成功候補の transformer 出力は metre 固定。foot / native unit の扱いは未対応である。
- **同値な候補**: カタログには、識別子は違うが投影の定義（PROJ 文字列）が同じ CRS が含まれうる
  （例: `EPSG:2448`・`EPSG:6674`・`ESRI:112206`）。これらは推定でまったく同じ値になるため、`ranked` の
  中の並びは identity の順で決まる。同値な候補の群を返す API は無い。候補の `proj4` を比べれば
  見分けられる（[Issue の一覧](https://github.com/code4history/Teiresias/issues)で扱う）。
- **未対応**: inverse 変換による geodesic RMS、アンチメリディアン、極域、epoch / grid provenance、
  robust / weight / LOO / bootstrap、進捗 callback、並列候補処理、キャンセル。キャンセルは npm の
  初版で対応する予定。それ以外は [Issue の一覧](https://github.com/code4history/Teiresias/issues)で扱う。
- **CLI は無い**: Teiresias はライブラリだけを提供する。コマンドラインの道具は無い。
- **配布**: 本 package はまだ npm に公開していない（`private: true`）。`@c4h/daedalus` は
  ローカル sibling の `link:../Daedalus` で解決している。

## 開発

```bash
pnpm --ignore-workspace install --ignore-scripts
pnpm --ignore-workspace run typecheck
pnpm --ignore-workspace run test:types
pnpm --ignore-workspace run test
pnpm --ignore-workspace run build
pnpm --ignore-workspace run coverage
```

`@c4h/daedalus` は `dist` を exports 経由で解決するため、先に Daedalus を build しておくこと。
親リポジトリの worktree では、素の `pnpm run <script>` が親の `pnpm-lock.yaml` を縮退再生成する
ため、**必ず `--ignore-workspace` を付ける**こと。

### デモ

`demo/crs-estimate-ranking.html` は、`Atlas`（投影）→ `Daedalus`（当てはめ）→ `Teiresias`
（順位づけ）の推定パイプラインをブラウザで触れるデモである。`@c4h/atlas` の `dist` を解決する
ため、**先に Atlas も build しておくこと**。

```bash
# 開発サーバ
pnpm --ignore-workspace run dev

# Pages 成果物のビルドと検証（GITHUB_PAGES=true で base が /Teiresias/ になる）
pnpm --ignore-workspace run verify:demo
pnpm --ignore-workspace run verify:demo-bundle

# 手元のブラウザで確認する（base が "/" のビルドと対で使う）
pnpm --ignore-workspace run build:demo
pnpm --ignore-workspace run preview
```

proj-wasm は Worker と WASM を読むため、**`file://` では動かない**（HTTP で配信すること）。

## ライセンス

MIT License です。[LICENSE](./LICENSE) を参照してください。
