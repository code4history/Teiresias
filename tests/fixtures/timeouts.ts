/**
 * 実 engine（Atlas・proj-wasm）を使うテストファイルの timeout（ms）。
 *
 * 使い方: 各ファイルの先頭で `vi.setConfig({ testTimeout: REAL_ENGINE_TEST_TIMEOUT_MS })` を 1 回だけ
 * 呼ぶ（テスト単位・describe 単位の timeout は置かない）。
 *
 * 決め方: Atlas・Daedalus・Teiresias の `pnpm run test` を同時に走らせた負荷ありで、テストごとの
 * 所要時間の最大値を 3 回測り、その 2 倍を秒へ切り上げる。2 倍が 30 秒以下なら 30 秒にする。
 * 2026-10 の測定: 負荷ありの最大 6,139 ms（初回のカタログ読み込みを払うテスト）・負荷なしの最大
 * 5,724 ms ∴ 2 倍は 13 秒で、下限の 30 秒を採る。
 */
export const REAL_ENGINE_TEST_TIMEOUT_MS = 30_000;
