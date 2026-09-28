/* Package persistence extends the existing REVEX Store and project/library security boundary. */
(function(root){
  'use strict';
  const Store=root.RevexStore;
  const ref=(projectId,id)=>Store.api.doc(Store.db,'projects',projectId,'library',id);
  const plain=value=>Store.toFirestorePlain(value);
  const requireCloud=projectId=>{if(!projectId||!Store.isCloud()||!Store.user?.uid)throw Error('Sign in and select a project.');};
  Store.getPackageConfig=async function(projectId){requireCloud(projectId);const s=await this.api.getDoc(ref(projectId,'revex_packages_config'));return s.exists()?s.data():{};};
  Store.savePackageConfig=async function(projectId,patch){requireCloud(projectId);await this.api.setDoc(ref(projectId,'revex_packages_config'),plain({...patch,type:'revex',hidden:true,revexKind:'packages-config',updatedAt:new Date().toISOString()}),plain({merge:true}));};
  Store.savePackageAssignment=async function(projectId,key,packageIds){
    requireCloud(projectId);
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
    const id='revex_package_assignment_'+Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
    await this.api.setDoc(ref(projectId,id),plain({type:'revex',hidden:true,revexKind:'packages-assignment',key,packageIds,updatedAt:new Date().toISOString(),updatedBy:this.user.uid}),plain({merge:false}));
  };
  Store.savePackageDriveSources=async function(projectId,files,expectedOwner){
    requireCloud(projectId);
    const previous=await this.getPackageConfig(projectId);
    if(!expectedOwner())throw Error('Project changed; Drive sync stopped.');
    const digestBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([...files].sort((a,b)=>String(a.id).localeCompare(String(b.id))))));
    const digest=Array.from(new Uint8Array(digestBytes),x=>x.toString(16).padStart(2,'0')).join('');
    if(digest===previous.driveSourceDigest){if(!expectedOwner())throw Error('Project changed.');await this.savePackageConfig(projectId,{driveScannedAt:new Date().toISOString()});return;}
    // New complete generation is committed last; interrupted scans never replace the last usable index.
    const generation=crypto.randomUUID(),chunks=[];
    for(let start=0;start<files.length;start+=150){
      if(!expectedOwner())throw Error('Project changed; Drive sync stopped.');
      const id='revex_packages_drive_'+generation+'_'+chunks.length;chunks.push(id);
      await this.api.setDoc(ref(projectId,id),plain({type:'revex',hidden:true,revexKind:'packages-drive-page',generation,files:files.slice(start,start+150)}));
    }
    if(!expectedOwner())throw Error('Project changed; Drive sync stopped.');
    await this.savePackageConfig(projectId,{driveSourcePages:chunks,driveSourceGeneration:generation,driveScannedAt:new Date().toISOString(),driveSourceCount:files.length,driveSourceDigest:digest});
    // Delete only pages replaced by a fully committed generation. Assignments and source documents are separate.
    for(const id of previous.driveSourcePages||[]){if(!expectedOwner())break;if(/^revex_packages_(drive_|seed_)[a-zA-Z0-9_-]+$/.test(id))await this.api.deleteDoc(ref(projectId,id)).catch(()=>{});}
  };
})(window);
