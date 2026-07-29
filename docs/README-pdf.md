# このフォルダのPDF再生成手順

いずれも **HTMLを編集 → このフォルダでコマンド実行** で作り直せます。

## 1. ご注文の流れ(A4・お客様配布用)

`guide-print.html` を編集してから:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="ご注文の流れ_A4.pdf" "file://$PWD/guide-print.html"
```

QRコード(qr-line.png / qr-form.png)はリンク先が変わらない限り再生成不要。

## 2. HiBoard紹介資料(16:9スライド・ブログ/WEB掲載用)

`紹介資料_slides.html` を編集してから:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="HiBoard紹介資料_スライド.pdf" "file://$PWD/紹介資料_slides.html"
```

- 1スライド = 960pt × 540pt(16:9、PowerPointのワイド画面と同じ比率)
- 文章版のもとネタは `紹介資料_ClaudeCode開発まとめ.md`
- スライドを追加・加筆したら、はみ出しが無いかブラウザで開いて確認する
  (各 `.slide` の高さ540ptを超えると次ページに食い込む。情報量が多い面には `compact` クラスを付けて詰める)
