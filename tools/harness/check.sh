#!/bin/sh
# Parse-check every JS and Python file.
#
# Prefers node (present on the Linux box). Falls back to macOS JavaScriptCore,
# since this Mac has no node — the project is worked on from both, so the check
# has to run in either place.
set -e
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
status=0

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
if command -v node >/dev/null 2>&1; then
  ENGINE=node
elif [ -x "$JSC" ]; then
  ENGINE=jsc
else
  echo "Need either node or macOS JavaScriptCore to parse-check JS."; exit 2
fi
echo "js engine: $ENGINE"

if [ "$ENGINE" = node ]; then
  for f in js/app.js js/db.js sw.js; do
    cp "$f" "$tmp/m.mjs"
    if node --check "$tmp/m.mjs" 2>"$tmp/err"; then echo "OK   $f"
    else echo "FAIL $f"; cat "$tmp/err"; status=1; fi
  done
else
  cat > "$tmp/c.js" <<'JS'
var files = ['js/app.js', 'js/db.js', 'sw.js'], bad = 0;
for (var i = 0; i < files.length; i++) {
  var f = files[i], src = readFile(f);
  src = src.replace(/^\s*import\s+[^;]*?from\s*['"][^'"]*['"];?\s*$/gm, '')
           .replace(/^\s*export\s+(?=(async\s+)?function|const|let|var|class)/gm, '')
           .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
  try { new Function(src); print('OK   ' + f); }
  catch (e) { bad++; print('FAIL ' + f + ' :: ' + e); }
}
if (bad) quit(1);
JS
  "$JSC" "$tmp/c.js" || status=1
fi

for f in tools/*.py tools/harness/*.py; do
  python3 -m py_compile "$f" 2>"$tmp/err" && echo "OK   $f" || { echo "FAIL $f"; cat "$tmp/err"; status=1; }
done
rm -rf tools/__pycache__ tools/harness/__pycache__
exit $status
