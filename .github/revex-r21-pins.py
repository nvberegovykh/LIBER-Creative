from pathlib import Path
root=Path('docs/liber-apps/apps/revex')
app=root/'app.js';s=app.read_text(encoding='utf-8')
needle='''  $(\'#issue-pins\').innerHTML = state.issues.filter((issue) => issue.anchorUniqueId || issue.anchorElementId).map((issue, index) =>\n    `<button class="issue-pin ${escapeHtml(issue.status || \'open\')}" data-id="${escapeHtml(issue.id)}" type="button" title="${escapeHtml(issue.title)}">${index + 1}</button>`\n  ).join(\'\');'''
# exact source variant
needle2="""  $('#issue-pins').innerHTML = state.issues.filter((issue) => issue.anchorUniqueId || issue.anchorElementId).map((issue, index) =>
    `<button class=\"issue-pin ${escapeHtml(issue.status || 'open')}\" data-id=\"${escapeHtml(issue.id)}\" type=\"button\" title=\"${escapeHtml(issue.title)}\">${index + 1}</button>`
  ).join('');"""
repl="""  $('#issue-pins').innerHTML = state.issues.filter((issue) => issue.anchorUniqueId || issue.anchorElementId).map((issue, index) =>
    `<button class=\"issue-pin ${escapeHtml(issue.status || 'open')}\" data-id=\"${escapeHtml(issue.id)}\" data-element-id=\"${escapeHtml(issue.anchorElementId || '')}\" data-unique-id=\"${escapeHtml(issue.anchorUniqueId || '')}\" type=\"button\" title=\"${escapeHtml(issue.title)}\">${index + 1}</button>`
  ).join('');"""
if needle2 in s:s=s.replace(needle2,repl,1)
if "activeBimViewer()?.requestRender?.();\n}\n\nfunction mergedItem" not in s:
    s=s.replace("  }));\n}\n\nfunction mergedItem", "  }));\n  activeBimViewer()?.requestRender?.();\n}\n\nfunction mergedItem",1)
app.write_text(s,encoding='utf-8')

viewer=root/'viewer-r21.js';t=viewer.read_text(encoding='utf-8')
t=t.replace("requestRender(){if(this.renderFrame||document.hidden)return;this.renderFrame=requestAnimationFrame(()=>{this.renderFrame=0;this.renderer.render(this.scene,this.camera)})}","requestRender(){if(this.renderFrame||document.hidden)return;this.renderFrame=requestAnimationFrame(()=>{this.renderFrame=0;this.renderer.render(this.scene,this.camera);this.updatePins()})}")
if '  updatePins(){' not in t:
    method="""  updatePins(){const host=$('#issue-pins');if(!host)return;const w=this.host.clientWidth,h=this.host.clientHeight;host.querySelectorAll('.issue-pin').forEach(pin=>{if(this.walk){pin.hidden=true;return}const uid=String(pin.dataset.uniqueId||''),id=String(pin.dataset.elementId||'');const row=(uid&&this.byUid.get(uid))||(id&&this.byId.get(id));const b=this.box(row);if(!b){pin.hidden=true;return}const p=b.getCenter(new THREE.Vector3()).project(this.camera),visible=p.z>=-1&&p.z<=1&&Math.abs(p.x)<=1.08&&Math.abs(p.y)<=1.08;pin.hidden=!visible;if(!visible)return;pin.style.left=`${(p.x*.5+.5)*w}px`;pin.style.top=`${(-p.y*.5+.5)*h}px`})}\n"""
    t=t.replace('  sectionApply(){',method+'  sectionApply(){',1)
t=t.replace("this.renderer.render(this.scene,this.camera);this.walkFrame=requestAnimationFrame(tick)","this.renderer.render(this.scene,this.camera);this.updatePins();this.walkFrame=requestAnimationFrame(tick)")
viewer.write_text(t,encoding='utf-8')
