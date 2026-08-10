from pathlib import Path
p=Path('docs/liber-apps/apps/revex/viewer-host-guard-r21.js')
s=p.read_text(encoding='utf-8')
s=s.replace('})(window);\\n','})(window);\n')
p.write_text(s,encoding='utf-8')

shell=Path('docs/liber-apps/apps/revex/shell-integrity.js')
t=shell.read_text(encoding='utf-8')
t=t.replace("const BUILD='20260810r20';","const BUILD='20260810r21';")
shell.write_text(t,encoding='utf-8')
