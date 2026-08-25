# このフォルダのPDF再生成手順

いずれも **HTMLを編集 → このフォルダでコマンド実行** で作り直せます。

## 1. ご注文の流れ(A4・お客様配布用)

`guide-print.html` を編集してから:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="ご注文の流れ_A4.pdf" "file://$PWD/guide-print.html"
```

QRコード(qr-line.png / qr-form.png)はリンク先が変わらない限り再生成不要。

## 2. 担当者別の操作説明資料(A4・社内配布用)

`操作説明資料/` のHTMLを編集してから、**そのフォルダで**:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="鈴木さん_マイスケジュール操作ガイド.pdf" "file://$PWD/鈴木さん_マイスケジュール操作ガイド.html"
```

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="山本さん_デザイン案件全般ボード操作ガイド.pdf" "file://$PWD/山本さん_デザイン案件全般ボード操作ガイド.html"
```

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="三浦さん・山本さん_HiBoard改善点ガイド_2026-08.pdf" "file://$PWD/三浦さん・山本さん_HiBoard改善点ガイド_2026-08.html"
```

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="三浦さん_HiBoard運用手順書.pdf" "file://$PWD/三浦さん_HiBoard運用手順書.html"
```

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="山本さん_制作実績の登録ガイド.pdf" "file://$PWD/山本さん_制作実績の登録ガイド.html"
```

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="検品チェックシート_2026-08.pdf" "file://$PWD/検品チェックシート_2026-08.html"
```

- 制作実績の登録ガイドは、画面のスクリーンショット `画面_制作実績の登録.png` を同じフォルダから
  相対パスで読んでいる。画面を変えたら撮り直すこと(横1000px・2倍解像度で撮り、上から2530pxで切る)

- 各 `.page` は A4(210mm × 297mm)ちょうど。**内容がはみ出すと空白ページが1枚増える**ので、
  出力後に `mdls -name kMDItemNumberOfPages <ファイル>.pdf` でページ数を確認する
  (鈴木さん用=3ページ / 山本さん用=3ページ / 改善点ガイド=3ページ / 三浦さん運用手順書=8ページ /
  制作実績の登録ガイド=2ページ / 検品チェックシート=2ページ)。
  **mdls は Spotlight の索引待ちで `(null)` を返すことがある**ので、確実に数えるなら:
  `python3 -c "import re,sys;d=open(sys.argv[1],'rb').read();print(max(int(x) for x in re.findall(rb'/Type\s*/Pages[^>]*?/Count\s+(\d+)',d)))" <ファイル>.pdf`
- **`writing-mode: vertical-rl`(縦書き)は使わない**。画面上は収まって見えるのに
  印刷時だけページ高が狂い、空白ページが増える。縦書きにしたいときは
  細い幅 + `word-break: break-all` で1文字ずつ折り返させる(改善点ガイドの `.pcol` が実例)
- ブラウザで確認するときは、各ページの中身が上端から **1081px 以内**に収まっていればOK
- 画面表示用のページ間の隙間は `@media print` で消してある(残すと最終ページが余白だけになる)

## 2-b. AI利用ルール(A4・1枚・社内配布用)

`onboarding/AI利用ルール_社内共通.html` を編集してから、**`onboarding/` フォルダで**:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="AI利用ルール_社内共通.pdf" "file://$PWD/AI利用ルール_社内共通.html"
```

- **1ページちょうど**で組んである(内容が1081pxを超えると2ページ目ができる)。
  文言を足したら、ブラウザで開いて最後の要素の下端が1081px以内か確認する
- 元原稿は同じフォルダの `AI利用ルール.md`。**両方を揃えて直すこと**

## 3. HiBoard紹介資料(16:9スライド・ブログ/WEB掲載用)

`紹介資料_slides.html` を編集してから:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="HiBoard紹介資料_スライド.pdf" "file://$PWD/紹介資料_slides.html"
```

- 1スライド = 960pt × 540pt(16:9、PowerPointのワイド画面と同じ比率)
- 文章版のもとネタは `紹介資料_ClaudeCode開発まとめ.md`
- スライドを追加・加筆したら、はみ出しが無いかブラウザで開いて確認する
  (各 `.slide` の高さ540ptを超えると次ページに食い込む。情報量が多い面には `compact` クラスを付けて詰める)
