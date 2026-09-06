#!/bin/sh
# Renders STATUS.html to SIH26171-Status-Report.pdf via headless Chrome.
# Waits for webfonts, prints backgrounds (the print stylesheet forces the
# light palette and A4 page box).
set -e
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
REPO="C:/Users/yashd/Downloads/SIH"
OUT="$REPO/SIH26171-Status-Report.pdf"
PROFILE="$(mktemp -d)"
rm -f "$OUT"
"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --user-data-dir="$PROFILE" \
  --virtual-time-budget=12000 \
  --no-pdf-header-footer \
  --print-to-pdf="$OUT" \
  "file:///$REPO/STATUS.html" 2>&1 | grep -viE "devtools|bluetooth|voice|registration|gpu|tensorflow" || true
ls -l "$OUT"
