from pathlib import Path
p=Path('docs/liber-apps/apps/revex/viewer-host-guard-r21.js')
s=p.read_text(encoding='utf-8')
s=s.replace('})(window);\\n','})(window);\n')
p.write_text(s,encoding='utf-8')
