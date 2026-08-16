import * as THREE from 'three';

const BUILD='20260816r68-viewer-polish1';
const $=(selector,root=document)=>root.querySelector(selector);

if(!window.__revexViewerPolishR68){
  window.__revexViewerPolishR68={build:BUILD};

  const diagnostic=(level,stage,message,detail={})=>{
    try{window.__revexBrowserDiagnostics?.emit?.(level,stage,message,{initiator:'viewer polish r68',...detail});}catch(_){}
  };
  const hasKey=(set,code,key)=>Boolean(set?.has?.(code)||set?.has?.(key));

  function applyPresentation(v){
    if(!v?.scene||!v?.renderer)return;
    v.scene.background=new THREE.Color(0x181a1d);
    v.renderer.outputColorSpace=THREE.SRGBColorSpace;
    v.renderer.toneMapping=THREE.NoToneMapping;
    v.renderer.toneMappingExposure=1;
    v.renderer.localClippingEnabled=true;
    const warm=new THREE.Color(0xded8cc);
    v.scene.traverse(node=>{
      if(!node.isMesh)return;
      const materials=(Array.isArray(node.material)?node.material:[node.material]).filter(Boolean);
      for(const material of materials){
        material.userData=material.userData||{};
        if(material.color&&!material.userData.revexR68BaseColor)material.userData.revexR68BaseColor=material.color.clone();
        if(material.userData.revexR68BaseColor&&material.color){
          material.color.copy(material.userData.revexR68BaseColor).lerp(warm,0.14);
        }
        if('roughness' in material)material.roughness=Math.max(.78,Number(material.roughness??.78));
        if('metalness' in material)material.metalness=Math.min(.12,Number(material.metalness??0));
        material.polygonOffset=true;
        material.polygonOffsetFactor=1;
        material.polygonOffsetUnits=1;
        material.needsUpdate=true;
      }
    });
    if(v.__revexObjectOutlineLayer){
      v.scene.remove(v.__revexObjectOutlineLayer);
      v.__revexObjectOutlineLayer.geometry?.dispose?.();
      v.__revexObjectOutlineLayer.material?.dispose?.();
      v.__revexObjectOutlineLayer=null;
    }
    const root=v.model||v.scene;
    if(typeof v.buildOutlineOverlay==='function'){
      Promise.resolve(v.buildOutlineOverlay(root)).catch(error=>diagnostic('WARN','VIEWER_OUTLINES',error?.message||String(error)));
    }
    v.renderer.domElement?.classList.add('revex-illustration-canvas');
    v.requestRender?.();
  }

  function patchSection(v){
    if(v.__revexR68Section)return;
    v.__revexR68Section=true;
    const priorApply=typeof v.sectionApply==='function'?v.sectionApply.bind(v):null;
    if(priorApply){
      v.sectionApply=function revexR68SectionApply(){
        this.renderer.localClippingEnabled=true;
        const result=priorApply();
        this.requestRender?.();
        return result;
      };
    }
    const priorDetailed=typeof v.loadDetailed==='function'?v.loadDetailed.bind(v):null;
    if(priorDetailed){
      v.loadDetailed=async function revexR68Detailed(...args){
        const result=await priorDetailed(...args);
        applyPresentation(this);
        if(this.__reviewSection?.enabled)this.sectionApply?.();
        return result;
      };
    }
    const priorMaterials=typeof v.applyMaterials==='function'?v.applyMaterials.bind(v):null;
    if(priorMaterials){
      v.applyMaterials=function revexR68Materials(...args){
        const result=priorMaterials(...args);
        applyPresentation(this);
        if(this.__reviewSection?.enabled)this.sectionApply?.();
        return result;
      };
    }
    const priorSetEnabled=typeof v.setSectionEnabled==='function'?v.setSectionEnabled.bind(v):null;
    if(priorSetEnabled){
      v.setSectionEnabled=function revexR68SetSection(enabled){
        const result=priorSetEnabled(enabled);
        this.renderer.localClippingEnabled=true;
        requestAnimationFrame(()=>this.sectionApply?.());
        diagnostic('INFO','SECTION_BOX',enabled?'Six-face section box enabled.':'Six-face section box disabled.');
        return result;
      };
    }
  }

  function patchWalk(v){
    if(v.__revexR68Walk)return;
    v.__revexR68Walk=true;
    const canvas=v.renderer?.domElement;
    const finish=()=>{
      v.walk=false;
      v.keys?.clear?.();
      if(v.walkFrame){cancelAnimationFrame(v.walkFrame);v.walkFrame=0;}
      if(v.controls){
        v.controls.enabled=true;
        const forward=new THREE.Vector3(-Math.sin(v.yaw||0),0,-Math.cos(v.yaw||0));
        v.controls.target.copy(v.camera.position.clone().add(forward.multiplyScalar(12)));
        v.controls.update?.();
      }
      if(document.pointerLockElement===canvas)document.exitPointerLock?.();
      v.requestRender?.();
    };

    v.walkOn=function revexR68Walk(on){
      if(!this.bounds)return;
      if(!on){finish();return;}
      this.walk=true;
      this.keys?.clear?.();
      if(this.controls)this.controls.enabled=false;
      const direction=new THREE.Vector3();
      this.camera.getWorldDirection(direction);
      if(direction.lengthSq()<1e-8)direction.set(0,0,-1);
      this.yaw=Math.atan2(-direction.x,-direction.z);
      this.pitch=Math.asin(Math.max(-.98,Math.min(.98,direction.y)));
      const target=this.controls?.target?.clone?.()||this.bounds.getCenter(new THREE.Vector3());
      const horizontal=new THREE.Vector3(direction.x,0,direction.z);
      if(horizontal.lengthSq()<1e-8)horizontal.set(0,0,-1);else horizontal.normalize();
      const span=Math.max(4,Math.min(12,(this.bounds.getSize(new THREE.Vector3()).length()||80)/14));
      this.camera.position.set(target.x-horizontal.x*span,Number(this.floor||0)+Number(this.eye||5.5),target.z-horizontal.z*span);
      this.look?.();
      this.requestRender?.();
      if(!this.embedded){try{canvas?.requestPointerLock?.();}catch(_){}}
      diagnostic('INFO','WALK_START',this.embedded?'Walk started in WebView drag-look mode; WASD moves, Q/E changes eye height.':'Walk started; WASD moves, Shift accelerates, Esc exits.');
    };

    v.step=function revexR68Step(dt){
      if(!this.walk)return;
      const diagonal=this.bounds?.getSize(new THREE.Vector3()).length()||100;
      const base=Math.max(3.4,Math.min(11,diagonal/90));
      const fast=hasKey(this.keys,'ShiftLeft','shift')||hasKey(this.keys,'ShiftRight','shift');
      const speed=base*(fast?2.4:1);
      const forward=new THREE.Vector3(-Math.sin(this.yaw),0,-Math.cos(this.yaw));
      const right=new THREE.Vector3(Math.cos(this.yaw),0,-Math.sin(this.yaw));
      const delta=new THREE.Vector3();
      if(hasKey(this.keys,'KeyW','w'))delta.add(forward);
      if(hasKey(this.keys,'KeyS','s'))delta.sub(forward);
      if(hasKey(this.keys,'KeyD','d'))delta.add(right);
      if(hasKey(this.keys,'KeyA','a'))delta.sub(right);
      if(delta.lengthSq()>0)this.camera.position.add(delta.normalize().multiplyScalar(speed*dt));
      const up=(hasKey(this.keys,'KeyE','e')?1:0)-(hasKey(this.keys,'KeyQ','q')?1:0);
      if(up)this.eye=Math.max(2.5,Math.min(9,Number(this.eye||5.5)+up*speed*.55*dt));
      this.camera.position.y=Number(this.floor||0)+Number(this.eye||5.5);
      this.look?.();
    };

    v.startWalkFrames=function revexR68WalkFrames(){
      if(this.walkFrame||!this.walk)return;
      this.lastStep=performance.now();
      const tick=now=>{
        this.walkFrame=0;
        if(!this.walk)return;
        const dt=Math.min((now-this.lastStep)/1000,.05);this.lastStep=now;
        if(this.keys?.size)this.step(dt);
        this.renderer.render(this.scene,this.camera);this.updatePins?.();
        if(this.keys?.size)this.walkFrame=requestAnimationFrame(tick);else this.requestRender?.();
      };
      this.walkFrame=requestAnimationFrame(tick);
    };

    document.addEventListener('keydown',event=>{
      if(!v.walk)return;
      if(event.key==='Escape'){finish();$('#walk-toggle')?.classList.remove('active');const controls=$('#walk-controls');if(controls)controls.hidden=true;return;}
      if(/^(KeyW|KeyA|KeyS|KeyD|KeyQ|KeyE|ShiftLeft|ShiftRight)$/.test(event.code)){
        v.keys?.add?.(event.code);v.keys?.add?.(String(event.key||'').toLowerCase());v.startWalkFrames();event.preventDefault();
      }
    },true);
    document.addEventListener('keyup',event=>{
      if(!v.walk)return;
      v.keys?.delete?.(event.code);v.keys?.delete?.(String(event.key||'').toLowerCase());
    },true);
    if(v.embedded&&canvas){
      canvas.addEventListener('click',event=>{if(v.walk){event.stopImmediatePropagation();}},true);
    }
  }

  function patch(v){
    if(!v||v.__revexR68Polished)return Boolean(v);
    if(!v.__revexWorkspaceR51Patched||!v.__reviewIntegrityR50)return false;
    v.__revexR68Polished=true;
    patchSection(v);patchWalk(v);applyPresentation(v);
    const priorLoad=typeof v.load==='function'?v.load.bind(v):null;
    if(priorLoad){
      v.load=async function revexR68Load(...args){
        const result=await priorLoad(...args);applyPresentation(this);if(this.__reviewSection?.enabled)this.sectionApply?.();return result;
      };
    }
    window.addEventListener('revex:source-revision-loaded',()=>setTimeout(()=>{applyPresentation(v);if(v.__reviewSection?.enabled)v.sectionApply?.();},40));
    diagnostic('INFO','VIEWER_R68','Illustrated physical BIM presentation plus WebView-safe Walk and persistent six-face clipping installed.',{build:BUILD});
    return true;
  }

  let attempts=0;
  const timer=setInterval(()=>{
    attempts+=1;
    if(patch(window.__revexViewerR26Instance)||attempts>300)clearInterval(timer);
  },50);
}
