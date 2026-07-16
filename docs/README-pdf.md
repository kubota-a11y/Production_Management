# ご注文の流れ PDF(A4)の再生成手順

内容を変更したいときは guide-print.html を編集し、このフォルダで以下を実行:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="ご注文の流れ_A4.pdf" "file://$PWD/guide-print.html"
```

QRコード(qr-line.png / qr-form.png)はリンク先が変わらない限り再生成不要。
