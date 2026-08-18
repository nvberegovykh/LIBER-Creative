#!/usr/bin/env python3
from pathlib import Path
p=Path('FINALIZE_REVEX.ps1')
t=p.read_text(encoding='utf-8')
old='DEPLOY_ENERGY_CURRENT_ARGV_FIX.ps1'
new='DEPLOY_ENERGY_R127.ps1'
count=t.count(old)
if count != 2:
    raise SystemExit(f'expected exactly two old Energy deployer references, found {count}')
t=t.replace(old,new)
p.write_text(t,encoding='utf-8')
print('REVEX_R127_FINALIZER_DEPLOYER_SWITCH=PASSED')
