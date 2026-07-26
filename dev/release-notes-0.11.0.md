## 0.11.0

### 新機能

- **Windows でもノイズゲート（無音カット）が使えるようになりました**。会議録音画面の「マイクゲート」「システムゲート」と設定画面のノイズゲート項目が Windows でも表示され、実際に効きます。挙動は macOS（sysrec の NoiseGate）と同一: 閾値未満の無音・環境ノイズ区間は録音レベルをほぼ 0 まで下げ、有音で素早く開き（8ms）、0.2 秒の保持のあと緩やかに閉じます（語頭・語尾を切らないため）。
  - Windows 実機の自動 E2E で検証済み: ゲート有効時、-50dBFS のノイズ区間が **-113.7dB〜-inf**（実質デジタル無音）まで沈黙。ゲート無効の対照と比べ約 95dB の差。
  - 注意: Windows はゲート判定の粒度が最大 0.1 秒のため、長い無音直後の発話の頭がわずかに欠ける可能性があります（macOS は約 10ms 粒度）。気になる場合は閾値を弱めるかオフに。

### 変更

- **ノイズゲートが Auto gain・手動ミキサーから独立しました**（macOS / Windows 共通）。従来は「Auto gain オン時のみ」でしたが、Auto gain オフでも手動ミキサーモードでも、ゲート設定（オフ / 弱〜最強）だけで効き方が決まります。切りたいときはゲートを「オフ」にしてください。
  - 手動ミキサー時のゲート判定はフェーダー適用後の信号で行います（両OS同じ）。フェーダーを大きく下げると小声が閾値を割りやすくなるので、その場合は閾値を弱めに。
- 設定画面の Auto gain の説明を現状に合わせて修正（仕上げ正規化の目標 -14 dBFS・macOS は保存時 / Windows は録音中）。
- ⚠️ **これは `sysrec` バイナリ側の変更を含みます。** macOS では doctor の「sysrec を取得」または `npm run build-sysrec` で更新してください。更新後は `--version` が `0.11.0` を返します。

### 内部

- DSP 契約テストにノイズゲート定数（floor / hold / 開閉時定数）を追加。sysrec `dsp-spec` と TypeScript 実装の乖離を機械的に検出します。
- ゲート中核の数値テスト 9 件を追加（fake-binary E2E 計 77 件）。
- 手動 E2E チェックリストに WIN-10（ノイズゲート）を追加。自動駆動の落とし穴（PowerShell の BOM 付き data.json 書き込み・テスト音源再生は SoundPlayer.PlaySync）を README に記録。

### 検証

- fake-binary E2E 77 件 pass、build / eslint 0 error。
- Windows 実機（CLI/CDP 自動駆動）: システムゲートの開閉が数値で確認済み（上記）。AGC オフ・手動ミキサーでのゲート動作もリリース前 smoke で確認。
- macOS: sysrec 再ビルド後に MAC-07（ノイズゲート）の耳確認を推奨（特に Auto gain オフ時）。

**Full Changelog**: https://github.com/ryukyuhub/obsidian-remote-meeting-recorder/compare/0.10.1...0.11.0
