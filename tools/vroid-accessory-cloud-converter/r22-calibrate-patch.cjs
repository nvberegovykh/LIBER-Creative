'use strict';

// Bounded patch for the pinned R2.1 clean-room converter. It corrects the
// cross-space ambiguity between Assimp bind matrices and Unity prefab bone
// transforms by calibrating each reconstructed skinned renderer to Unity's
// serialized SkinnedMeshRenderer local AABB. Split Assimp material meshes are
// associated back to their Unity renderer by exact/prefix match and, for the
// two earring skin chains, unambiguous left/right renderer ownership.

const fs=require('fs');
const target=process.argv[2];
if(!target) throw new Error('Usage: node r22-calibrate-patch.cjs cleanroom-xwear.js');
let s=fs.readFileSync(target,'utf8');

function once(oldText,newText,label){
  const n=s.split(oldText).length-1;
  if(n!==1) throw new Error(`Patch ${label}: expected one match, found ${n}`);
  s=s.replace(oldText,newText);
}

once(
"        const rootBone=typ===137?(+(d.match(/m_RootBone: \\{fileID: (-?\\d+)\\}/)||[])[1]||0):0;\n        rendererByGo.set(go,{kind:typ===137?'skinned':'mesh',meshFileId:+mm[1],rootBone});",
"        const rootBone=typ===137?(+(d.match(/m_RootBone: \\{fileID: (-?\\d+)\\}/)||[])[1]||0):0;\n        const aabbCenter=typ===137?parseVec(d,'m_Center'):null,aabbExtent=typ===137?parseVec(d,'m_Extent'):null;\n        rendererByGo.set(go,{kind:typ===137?'skinned':'mesh',meshFileId:+mm[1],rootBone,aabb:aabbCenter&&aabbExtent?{center:aabbCenter,extent:aabbExtent}:null});",
'capture Unity skinned bounds');

once(
"function vec(m,v){const x=m[0]*v[0]+m[1]*v[1]+m[2]*v[2],y=m[4]*v[0]+m[5]*v[1]+m[6]*v[2],z=m[8]*v[0]+m[9]*v[1]+m[10]*v[2],q=Math.hypot(x,y,z)||1;return[x/q,y/q,z/q]}",
"function vec(m,v){const x=m[0]*v[0]+m[1]*v[1]+m[2]*v[2],y=m[4]*v[0]+m[5]*v[1]+m[6]*v[2],z=m[8]*v[0]+m[9]*v[1]+m[10]*v[2],q=Math.hypot(x,y,z)||1;return[x/q,y/q,z/q]}\nfunction invAffine(m){const a=m[0],b=m[1],c=m[2],d=m[4],e=m[5],f=m[6],g=m[8],h=m[9],i=m[10],det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);if(Math.abs(det)<1e-12)return I4;const q=1/det,A=(e*i-f*h)*q,B=(c*h-b*i)*q,C=(b*f-c*e)*q,D=(f*g-d*i)*q,E=(a*i-c*g)*q,F=(c*d-a*f)*q,G=(d*h-e*g)*q,H=(b*g-a*h)*q,I=(a*e-b*d)*q,tx=m[3],ty=m[7],tz=m[11];return[A,B,C,-(A*tx+B*ty+C*tz),D,E,F,-(D*tx+E*ty+F*tz),G,H,I,-(G*tx+H*ty+I*tz),0,0,0,1]}\nfunction normalsFromTriangles(vertices,indices){const n=Array.from({length:vertices.length},()=>[0,0,0]);for(let k=0;k+2<(indices||[]).length;k+=3){const ia=indices[k],ib=indices[k+1],ic=indices[k+2],a=vertices[ia],b=vertices[ib],c=vertices[ic];if(!a||!b||!c)continue;const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],nn=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];for(const j of[ia,ib,ic]){n[j][0]+=nn[0];n[j][1]+=nn[1];n[j][2]+=nn[2]}}return n.map(v=>{const q=Math.hypot(...v)||1;return[v[0]/q,v[1]/q,v[2]/q]})}",
'add affine inverse and normal rebuild');

const start=s.indexOf('function reconstructMeshes(scene,prefab){');
const end=s.indexOf('\n\nfunction writer()',start);
if(start<0||end<0) throw new Error('Patch reconstructMeshes: anchors missing');
const replacement=`function prefabTransformFor(name,prefab,parts){
  if(!prefab?.transforms)return null;
  const entries=Object.entries(prefab.transforms),needle=String(name||'').toLowerCase(),hasSkin=!!parts?.some(p=>p.bones?.length),sd=sideOf(name);
  if(hasSkin){
    const skinned=entries.filter(([k,v])=>v?.kind==='skinned');
    const exact=skinned.find(([k])=>k===name);if(exact)return exact[1];
    const related=skinned.filter(([k])=>{const x=k.toLowerCase();return needle===x||needle.startsWith(x+'_')||needle.startsWith(x+'.')||x.startsWith(needle+'_')||x.startsWith(needle+'.')});
    if(related.length===1)return related[0][1];
    const sided=skinned.filter(([k])=>!sd||sideOf(k)===sd);
    if(sided.length===1){log('[+] Bound skinned mesh '+name+' -> '+sided[0][0]);return sided[0][1]}
    log('[!] No unambiguous prefab skinned renderer for '+name+' side='+sd+' candidates='+skinned.map(x=>x[0]).join(','));return null;
  }
  if(prefab.transforms[name])return prefab.transforms[name];
  const related=entries.filter(([k,v])=>v?.kind!=='skinned'&&(()=>{const x=k.toLowerCase();return needle===x||needle.startsWith(x+'_')||needle.startsWith(x+'.')||x.startsWith(needle+'_')||x.startsWith(needle+'.')})());
  return related.length===1?related[0][1]:null;
}
function reconstructMeshes(scene,prefab){
  const raw=extractRawMeshes(scene);if(!raw.length)die('FBX import produced no mesh objects');const groups=new Map();for(const m of raw){if(!groups.has(m.name))groups.set(m.name,[]);groups.get(m.name).push(m)}const havePrefab=!!prefab,unit=havePrefab?.01:1,out=[];let skinnedParts=0,fallbackParts=0,calibratedSkinGroups=0;
  for(const[name,parts]of groups){const tr=prefabTransformFor(name,prefab,parts);let sharedCenter=[0,0,0],recenter=false;const nonSkin=parts.filter(p=>!(p.bones?.length));if(tr&&nonSkin.length){const all=nonSkin.flatMap(p=>p.rawVertices).map(v=>v.map(x=>x*unit)),b=boundsOf([{vertices:all}]);sharedCenter=b.center;const cm=Math.hypot(...sharedCenter),sp=Math.max(...b.span,.001);recenter=cm>.15&&cm>sp*3}
    const staged=[];
    for(const p of parts){let verts,normals,skinInfo=null;
      if(p.bones?.length){skinInfo=weightedSkin(p,prefab,unit);if(skinInfo){verts=skinInfo.verts;normals=skinInfo.normals;skinnedParts++}}
      if(!verts&&tr){verts=p.rawVertices.map(v=>{let u=v.map(x=>x*unit);if(recenter)u=u.map((x,i)=>x-sharedCenter[i]);return point(tr.matrix,u)});normals=p.rawNormals.map(v=>vec(tr.matrix,v))}
      if(!verts){fallbackParts++;verts=p.rawVertices.map(v=>point(p.world,v).map(x=>x*unit));normals=p.rawNormals.map(v=>vec(p.world,v))}
      staged.push({p,verts,normals,skinInfo});
    }
    const skinStages=staged.filter(x=>x.skinInfo);
    if(skinStages.length){log('[+] Skin group '+name+' renderer='+(tr?.kind||'none')+' aabb='+(tr?.aabb?'yes':'no')+' root='+(tr?.rootBone||0))}
    if(skinStages.length&&tr?.aabb&&tr.rootBone){
      const rootWorld=prefab.worldByTransform?.[String(tr.rootBone)]||prefab.worldByTransform?.[tr.rootBone];
      if(rootWorld){const invRoot=invAffine(rootWorld),localMeshes=skinStages.map(x=>({x,local:x.verts.map(v=>point(invRoot,v))})),allLocal=localMeshes.flatMap(x=>x.local),cb=boundsOf([{vertices:allLocal}]),tc=tr.aabb.center,te=tr.aabb.extent,ts=te.map(x=>2*x),sf=ts.map((x,i)=>cb.span[i]>1e-8?x/cb.span[i]:1);for(const q of localMeshes){q.x.verts=q.local.map(v=>point(rootWorld,v.map((x,i)=>(x-cb.center[i])*sf[i]+tc[i])));q.x.normals=normalsFromTriangles(q.x.verts,q.x.p.indices)}calibratedSkinGroups++;log('[+] Calibrated skinned bounds '+name+': source span='+cb.span.map(x=>x.toFixed(5)).join(',')+' target span='+ts.map(x=>x.toFixed(5)).join(','))}else {log('[!] Missing root transform for skin group '+name)}
    }
    for(const x of staged){const p=x.p;out.push({name:p.name,side:p.side,materialIndex:p.materialIndex,vertices:x.verts,normals:x.normals,tangents:[],colors:p.colors,uvs:p.uvs,indices:p.indices,prefabTransform:tr?{kind:tr.kind,pos:tr.pos}:null,recentered:!!(tr&&recenter),skinned:!!x.skinInfo,boneCount:x.skinInfo?.boneCount||0})}
  }
  return{meshes:out,sourceUnitScale:unit,prefabUsed:prefab?.pathname||null,skinnedParts,fallbackParts,calibratedSkinGroups};
}`;
s=s.slice(0,start)+replacement+s.slice(end);

s=s.replace(
"log(`[+] Reconstruction: skinned=${rec.skinnedParts} fallback=${rec.fallbackParts}`);",
"log(`[+] Reconstruction: skinned=${rec.skinnedParts} calibratedSkinGroups=${rec.calibratedSkinGroups} fallback=${rec.fallbackParts}`);");

fs.writeFileSync(target,s);
console.log('[+] R2.3.2 skinned renderer binding + bounds calibration patch applied');
