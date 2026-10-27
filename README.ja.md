# Teiresias

[![CI](https://github.com/code4history/Teiresias/actions/workflows/test.yml/badge.svg)](https://github.com/code4history/Teiresias/actions/workflows/test.yml)

`@c4h/teiresias` estimates the best CRS and world-file parameters from GCPs and a supplied candidate CRS set.

- Input: GCPs plus candidate CRSs
- Output: selected CRS plus world-file 6 parameters
- Runtime: Node.js と browser（bundler = 検証済 ／ 実ブラウザ = 1 回観測済 ／ 継続的・自動のブラウザ実行は未検証。下記「既知の制限」）
- Scope: 当てはめの統括。カタログ検索は行わない（候補は呼出側が渡す）

English README is [here](./README.md).

## インストール

Node.js >= 22（またはバンドラ経由のブラウザ）が必要です。候補はふつう
[`@c4h/atlas`](https://github.com/code4history/Atlas) から取ります（下の「Atlas と組み合わせる」を参照）。

<!-- release-pinned:start -->
```sh
pnpm add @c4h/teiresias @c4h/atlas
```
<!-- release-pinned:end -->

## 公開 API

`package.json` の `exports` は public root `"."` のみである。公開されるのは `estimateCrs` と
公開型だけで、内部 helper（ranking / status 導出）は公開しない。

```ts
import { estimateCrs } from '@c4h/teiresias';
import type {
  CandidateCrs,
  CandidateFailure,
  CandidateFailureKind,
  CandidatePoints,
  EstimateOptions,
  EstimationFailure,
  EstimationResult,
  LinearUnit,
} from '@c4h/teiresias';

const result: EstimationResult = await estimateCrs(gcps, candidates, {
  transformer,                 // 必須。候補 CRS への変換 adapter
  geoBasis,                    // 省略時 { kind: 'lonlat_deg', axisOrder: 'lon-lat' }
  minCandidates,               // 省略時 1
  topK,                        // 省略時 usable 全件
  normalizeEpsilonMeters,      // 省略時 100（m）
  datumFamilyPrior,            // 省略時 中立（prior なし）
  chirality,                   // 省略時 'normalize'。'direct-only' は反射を吸収しない
  holdout,                     // 省略時 なし。affine の採否の検証だけに使う GCP
  timeoutMs,                   // 省略時 120000（ms）。transformer の呼び出し 1 回の上限。Infinity で無効
  signal,                      // 省略時 なし。推定全体を中止する AbortSignal
});
```

- `holdout`（`readonly GcpPair[]`。`geo` は `geoBasis` の順）は Daedalus の holdout 検証に渡す。
  当てはめには使わない。transformer の呼び出しは候補ごとに 1 回のまま（GCP と holdout の地理座標を
  つないで 1 回で変換する）。空配列は省略と同じ。
- `timeoutMs` は候補 1 件の **transformer の呼び出し 1 回**の上限。その内に答えなければ、推定を
  その場で止め、`status: 'failed'`・`failure.reason: 'timeout'` を返す（残りの候補は呼ばない）。
  正の数でない値は既定に戻す。2147483647（`setTimeout` が受けられる遅延の上限）を越える値は
  `Infinity`（上限なし）として扱う。Promise を返して待たせる transformer の上限であり、同期で処理を
  握り続ける transformer は打ち切れない。
- `signal` が中止されたら、`estimateCrs` は `signal.reason`（無ければ `AbortError` の
  `DOMException`）で reject する（`AbortSignal` を受ける Web の API の慣例）。次の候補は呼ばない。
  `estimateCrs` が reject するのは中止のときだけである。
- 結果の `failure`（`EstimationFailure | null`）は `status` が `failed` の理由を示す。`reason` は
  `'implementation-failure'` か `'timeout'`、`candidates` は失敗した候補（`CandidateFailure`: `id`・
  `kind`・`message`）を候補の入力順に並べる。`CandidateFailureKind` は `'adapter-bug'`（transformer が
  throw／reject した）・`'adapter-contract-failure'`（出力が契約に反する: 長さの不一致・非有限の点・
  空入力に配列を返した など）・`'dependency-contract-failure'`（Daedalus の返却が公開契約に反する）・
  `'adapter-timeout'` の 4 つ。`message` は 500 文字で切る。`failed` 以外では `failure` は `null`。

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
| (3) | 出力は同順同数の projected `[easting, northing]` 点列、または `{ points, unit }`（下の「単位」を参照） |
| (4) | 空入力は `null`（`[]` を返さない） |
| (5) | 一点でも非有限 / 変換不能なら全体 `null`（部分成功を返さない） |
| (6) | 入出力の長さ不一致は adapter contract failure |
| (7) | 業務的に変換不能な事象は `null`。throw は adapter bug のときだけ |
| (8) | 同じ id・点列・basis に対して決定的 |

同期返却と `Promise` 返却の双方が適合する。Teiresias は候補を**入力順に逐次**処理し、
返却を `await` で正規化する（failure / warning の順序と adapter 呼出し順を決定的にするため）。

### 単位

候補 CRS の座標の単位は metre とは限らない（歴史的な格子の yard・US survey foot など）。
transformer はそのような候補を 2 つの形で返せる。

| 形 | 意味 |
|---|---|
| `Array<[number, number]>` | projected `[E, N]` を **metre** で（従来の形） |
| `CandidatePoints` = `{ points, unit }` | projected `[E, N]` を **`unit` の単位**で（`points` は同順同数） |

`LinearUnit` は `{ name, metresPerUnit }` で、単位の名前と 1 単位が何 metre かを持つ
（`metresPerUnit` は正の有限値・`name` は空でない文字列）。metre は
`{ name: 'metre', metresPerUnit: 1 }` であり、plain な点列はこの単位の `CandidatePoints` と同じである。

Teiresias は返った点列を `metresPerUnit` 倍して metre で当てはめる。holdout の点も同じ倍率で換算し、
Daedalus へ渡す `[E, N]` は常に metre である。∴

- `ranked` と `selected` の `rmsMeters` は metre のまま（同じ呼び出しの全候補を同じ尺度で比べられる）。
- `selected.unit` と `ranked[].unit` はその候補の座標の単位を持つ。plain な点列を返す transformer では
  `{ name: 'metre', metresPerUnit: 1 }` になる。
- `selected.worldFile` は pixel → **その単位**の写像である。6 値とも `metresPerUnit` で割る
  （写像は線形なので 6 値は同じ倍率）。metre の候補では従来と同じ値になる。

不正な unit（空の `name`、正の有限値でない `metresPerUnit`）は adapter contract failure である。
他の契約違反と同じくその候補を記録し、推定は `failed` になる（下の「status と診断」を参照）。

### Atlas と組み合わせる

[`@c4h/atlas`](https://github.com/code4history/Atlas) の 3 つの関数で候補と transformer を作る。
Teiresias 自身は Atlas に依存しない（engine は呼出側が注入する）。`createCandidateTransformer` は
`CandidateTransformer` と同じ形の関数を返し、`listProjectedCrsFromProjWasm` の行は
`authority` / `code` を持つので、そのまま候補として渡せる。

```ts
import {
  createCandidateTransformer,
  initializeProjWasmRuntime,
  listProjectedCrsFromProjWasm,
} from '@c4h/atlas';
import { estimateCrs } from '@c4h/teiresias';

await initializeProjWasmRuntime(); // ブラウザでは { projWasmAssetBaseUrl } も渡す

const rows = await listProjectedCrsFromProjWasm({
  extent: { west: 135.6, south: 34.9, east: 135.9, north: 35.1 },
  area: 'Japan',
  onshoreOnly: true,
});

const result = await estimateCrs(gcps, rows, {
  transformer: createCandidateTransformer(rows),
});
```

座標が metre でない行（歴史的な格子の yard など）では、`createCandidateTransformer` は plain な点列では
なく `{ points, unit }` を返す。Teiresias は上の「単位」のとおり換算する。行を自分で変換するときは、
`transformLonLatToCandidate` が点列とその行の単位を返す。`transformLonLatArrayToProjected` は従来の形を
保ち、metre でない行には `null` を返す。

transformer は、`geoBasis` が `{ kind: 'lonlat_deg', axisOrder: 'lon-lat' }` でないときと、行に無い id の
ときに `null` を返す（契約 (7) の「業務的に変換不能」）。Atlas 側の失敗は `null` にならず throw される。
Teiresias は throw／reject を候補ごとに受け止め、その候補を adapter bug として記録して `untransformableIds`
に入れ、残りの候補の評価を続ける ∴ `estimateCrs` 自体は reject しない。こうした失敗が 1 件でもあれば、
他の候補が usable でも status は `failed`・`selected` は `null` になり、`failure` が失敗した候補を示す
（後述「status と診断」）。実 engine の E2E
（`tests/estimate-crs.real-engine.e2e.test.ts`）とデモ（`demo/atlas-engine.js`）はこの形で配線している。

## ranking と score

- 順位は **shear 前の basic（similarity）RMS** で決める。Daedalus が最終的に affine を採用し得るため、
  final RMS を順位に使うと「affine が誤候補を救済して順位を逆転する」ことが起きる。
- `score = basicRmsMeters / L_geo`。`L_geo` は入力 GCP 全体に共通する観測域スケール（m）であり、
  同じ推定呼出し内では basic RMS 昇順と同値である。score は観測域に対する相対誤差であり、
  確率・信頼度ではない。
- 同着（機械精度内）のときだけ `datumFamilyPrior` の指定順が働く。prior は明確な fit 差を逆転しない。
  最後は identity の code-unit 順で決定的に閉じる。

### pixel の y 軸の反射（`chirality`）

走査した画像は pixel の y 軸が下向きで、投影座標の北は上向きであることが多い ∴ pixel から地上への
写像は反射を含む。相似変換（回転・等方スケール・平行移動）は反射を表現できないため、何もしなければ
どの候補も同じくらい当てはまらなくなり、順位が候補を見分ける力を失う。

`chirality: 'normalize'`（既定）では、相似変換のモデル自体は変えずに、候補ごとに pixel の v を反転した
同じ点でも当て、basic の残差二乗和の小さい側を採る（機械精度内の同値なら反転しない側）。反転した側を
採ったら、返す `worldFile` の `xSkew` と `yScale` の符号を反転して元の pixel 座標の写像に戻す。
`rmsMeters`・`qualityGate`・`warnings`・`status` は採った側の値で、採らなかった側の warning は返さない。
transformer の呼び出しは候補ごとに 1 回のまま変わらない。反射を吸収したかは `selected.worldFile` の
行列式の符号（`xScale * yScale - xSkew * ySkew < 0`）で分かる。

`chirality: 'direct-only'` は反転を試さず、正規化しないときの挙動になる。

### `rmsMeters` の意味の違い（重要）

| 値 | 意味 |
|---|---|
| `ranked[].rmsMeters` / `selected.rmsMeters` | **ranking に用いた shear 前 basic RMS**（metre） |
| `selected.worldFile` / `selected.qualityGate` | **同じ候補に対する Daedalus の最終返却**（affine 採用を含み得る） |
| `selected.unit` / `ranked[].unit` | **その候補の座標の単位**。`selected.worldFile` はこの単位で、`rmsMeters` はそうではない |

∴ `selected.worldFile` が affine のとき、`selected.rmsMeters` はその worldFile の残差ではない。
final RMS を別名で公開する API は無い。

## status と診断

上から評価し、最初に当たった行で決まる。

| 条件 | `status` | `selected` | `failure` |
|---|---|---|---|
| transformer の呼び出しが打ち切られた（`adapter-timeout`） | `failed` | `null` | `{ reason: 'timeout', candidates }`（打ち切った候補が最後） |
| adapter bug / adapter contract failure / dependency contract failure が 1 件以上 | `failed` | `null` | `{ reason: 'implementation-failure', candidates }`（全件） |
| usable 件数 >= `minCandidates`、選択候補の warnings 0 件 | `ok` | 先頭候補 | `null` |
| usable 件数 >= `minCandidates`、選択候補の warnings 1 件以上 | `ok_with_warnings` | 先頭候補 | `null` |
| それ以外（usable 件数 < `minCandidates`） | `insufficient` | `null` | `null` |

実装側の失敗は、他の候補が usable でも `failed` にする。失敗した候補が真値だったかを Teiresias は
判断できず、残りから選ぶと黙って誤った候補を選びうるためである。評価は（打ち切りの後を除き）最後の
候補まで続けるので、直すべき候補を `failure.candidates` で一度に知ることができる。

- `status: 'failed'` のとき、`ranked` は評価できた候補だけの不完全な順位であり、診断用である。
  候補の選択に使ってはならない。
- `status: 'ok'` になるのは、`holdout` を渡して Daedalus が affine を採用したときだけである。それ以外の
  成功 fit は warning（`validationSkipped` など）を 1 件以上持つので `ok_with_warnings` になる。

- `warnings` は成功時は **selected 候補の Daedalus `FitWarning` だけ**を同順・同形で返す。
  敗北候補の warning を identity なしで混ぜない。`WarningCode` は Daedalus の凍結 7 値のままで、
  transformer の失敗を既存 code へ流用しない。
- `untransformableIds` は **transformer / candidate 入力層の失敗だけ**を候補入力順・重複なしで収容する。
  Daedalus fitting 層の不足（`insufficient` / `unusable`）とは混ぜない。
  `ranked` / `selected` の identity と交差しない。

## 保存境界

`EstimationResult` は**診断返却**である。Editor が明示的に採用した後に永続化してよいのは
**選択された identity と採用 worldFile だけ**である。

`ranked` / `score` / basic RMS / `qualityGate` / `warnings` / `untransformableIds` / `failure` /
`selected` object 全体は保存しない。`qualityGate: 'preview'` の返却も同様で、保存・採用の判断は
ライブラリではなく Editor の責務である。

## 既知の制限

- **ブラウザ対応の 3 段**（ある段の実績を別の段へ流用しない）:
  - **bundler = 検証済み**: `pnpm run verify:demo-bundle`（`scripts/verify-demo-browser-bundle.mjs`）が
    demo build の出力チャンクを走査し、Node 固有指定子が残っていないことと Daedalus 由来コードが
    実在することを機械検証する。CI（`.github/workflows/{test,deploy}.yml`）から継続的に走る。
  - **browser runtime = 手動で 1 回確認済み**: 2026-08-29 に `demo/crs-estimate-ranking.html`
    を実ブラウザで開き、proj-wasm の初期化・候補順位・y 軸反転による識別力の消滅・GCP ドラッグによる
    順位入替を確かめた。この確認は反射の扱い（`chirality`）より前のもので、今の既定ではデモで正規化を
    外さない限り y 軸を反転しても識別力は潰れない。**1 回の手動確認であって自動テストではない ∴ 回帰は防げない。**
  - **CI 上での継続的・自動のブラウザ実行と canvas ドラッグの自動操作 = 未対応。**
- **実 engine の E2E は接続済み**: `tests/estimate-crs.real-engine.e2e.test.ts` が実 CRS engine
  （Atlas / proj-wasm）を注入した E2E を持つ。mock E2E（`estimate-crs.e2e.test.ts`）は
  契約の決定的な検証として併存する。
- **`timeoutMs` が効くのは非同期の待ちだけ**: JavaScript のスレッドを同期で握り続ける transformer は、
  タイマーが動けないので打ち切れない。Atlas の transformer（`createCandidateTransformer`）は Promise を
  返すので、エンジンの初期化などの非同期の待ちには上限が効くが、その中の同期の変換処理には効かない。
- **同値な候補**: カタログには、識別子は違うが投影の定義（PROJ 文字列）が同じ CRS が含まれうる
  （例: `EPSG:2448`・`EPSG:6674`・`ESRI:112206`）。これらは推定でまったく同じ値になるため、`ranked` の
  中の並びは identity の順で決まる。同値な候補の群を返す API は無い。候補の `proj4` を比べれば
  見分けられる（[#4](https://github.com/code4history/Teiresias/issues/4) で扱う）。
- **未対応**: inverse 変換による geodesic RMS、アンチメリディアン、極域、epoch / grid provenance、
  robust / weight / LOO / bootstrap、進捗 callback、並列候補処理。
  [#5](https://github.com/code4history/Teiresias/issues/5) で扱う。
- **単位だけが違う CRS は GCP の当てはめでは区別できない**: 同じ投影で線形単位だけが違う CRS
  （metre と US survey foot など）は、相似変換の縮尺が単位の差を吸収するため、当てはめでは
  区別できない。どちらが選ばれても world file の数値だけが違う。歴史グリッドと近くの現代の CRS の
  差は、正確な GCP でも数 cm である（実際の地図では GCP の誤差の方が大きい）。
- **CLI は無い**: Teiresias はライブラリだけを提供する。コマンドラインの道具は無い。
- **配布**: 本 package はまだ npm に公開していない（`private: true`）。`@c4h/daedalus` は
  ローカル sibling の `link:../Daedalus` で解決している。

## 開発

[Atlas](https://github.com/code4history/Atlas) と [Daedalus](https://github.com/code4history/Daedalus)
をこのリポジトリと同じ階層に置く（`../Atlas`・`../Daedalus`）。npm に出るまでは、
`ci/pnpm-workspace.ci.yaml` が `@c4h/atlas` と `@c4h/daedalus` をその checkout へ向ける。install の前に、
このリポジトリと兄弟のそれぞれで写しておくこと（写したものは commit しない）。

```bash
(cd ../Daedalus && cp ci/pnpm-workspace.ci.yaml pnpm-workspace.yaml && pnpm install --frozen-lockfile && pnpm run build)
(cd ../Atlas && cp ci/pnpm-workspace.ci.yaml pnpm-workspace.yaml && pnpm install --frozen-lockfile && pnpm run build)
cp ci/pnpm-workspace.ci.yaml pnpm-workspace.yaml && pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:types
pnpm run test
pnpm run build
pnpm run smoke:consumer
pnpm run coverage
```

`@c4h/daedalus` は `dist` を exports 経由で解決するため、先に Daedalus を build しておくこと。
`pnpm run smoke:consumer` は 3 つのパッケージを pack し、空のディレクトリに tarball を入れて、
公開面の import だけで推定を流す。

`pnpm publish` の前に `prepublishOnly`（test・typecheck・test:types・test:types:atlas・build・
verify:demo・verify:demo-bundle）が走る。公開は GitHub Actions（`.github/workflows/publish.yml`）
から行う。変更の記録は [CHANGELOG.md](./CHANGELOG.md) にある。

### デモ

`demo/crs-estimate-ranking.html` は、`Atlas`（投影）→ `Daedalus`（当てはめ）→ `Teiresias`
（順位づけ）の推定パイプラインをブラウザで触れるデモである。`@c4h/atlas` の `dist` を解決する
ため、**先に Atlas も build しておくこと**。

```bash
# 開発サーバ
pnpm run dev

# Pages 成果物のビルドと検証（GITHUB_PAGES=true で base が /Teiresias/ になる）
pnpm run verify:demo
pnpm run verify:demo-bundle

# 手元のブラウザで確認する（base が "/" のビルドと対で使う）
pnpm run build:demo
pnpm run preview
```

画面の上に**プリセットのボタンの帯**がある（対比ごとに A・B の 2 つ）。押すと入力（場面・
候補の集め方・y の向き・正規化）が一度に入り、計算が 1 回走る。押したボタンは強調され、その下の
1 行に「見え方」（この入力ならこう見えるはず）が出る。つまみを手で動かすか GCP をドラッグすると、
強調と 1 行は消える（プリセットは入口であって、操作を縛らない）。

| プリセット | A | B |
|---|---|---|
| `place` | 京都の GCP | 東京の GCP |
| `y-direction` | y 上向き | y 下向き（走査した地図） |
| `normalization` | 正規化あり | 正規化なし |
| `historical-grid` | 現代の地図（VI 系で描いた） | 戦前の市街図（歴史グリッド B 帯で描いた） |

順位の表の上には流れの 1 行（`Atlas` → `Daedalus` → `Teiresias`。候補・変換できた件数・当てはめた
件数・1 位の CRS を実行時の値で出す）、識別力の札の横には「比べた相手」、選択結果には world file の
6 値と `yScale` の符号を言葉にした「y 上向き／y 下向き」を出す。順位の表には候補ごとの単位の
列があり、選択結果では world file の 6 値の隣にその単位の名前を出す（歴史グリッドなら yard）。
1 位と 2 位の `rmsMeters` も並べて出す。world file の当てはめのパネルは Daedalus のデモにあるので、
選択結果からそこへリンクする。

proj-wasm は Worker と WASM を読むため、**`file://` では動かない**（HTTP で配信すること）。

## ライセンス

MIT License です。[LICENSE](./LICENSE) を参照してください。
