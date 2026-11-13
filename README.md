# Spendly｜家計簿

GitHub Pagesで公開する静的な家計簿アプリです。

## データの持ち方

- **自分の入力**：ブラウザの localStorage にのみ保存されます（サーバには送信されません）。編集・削除はアプリ内で行えます。機種変更などに備えて、アプリ内の「自分のデータを書き出す」でバックアップできます。
- **ヴェーダ記録**：`data.json` に記録され、アプリが読み込んで一緒に表示します（アプリ内では表示専用）。カード明細・レシート・本人の確認から特定できた支出を、ヴェーダがこのファイルへ追記していきます。

## 公開方法（GitHub Pages）

1. リポジトリの **Settings → Pages** を開く
2. Build and deployment の Source で **Deploy from a branch** を選ぶ
3. Branch で **main / (root)** を選んで Save
4. 数分後に `https://lostboy777-112.github.io/Spendly-app/` で公開されます

## ファイル

- `index.html` — アプリ本体（HTML/CSS/JSを1ファイルに収録、外部依存なし）
- `data.json` — ヴェーダ記録のデータ
