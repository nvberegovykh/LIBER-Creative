'use strict';
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {onInit}=require('firebase-functions/v2/core');
const {createAssistant,ENDPOINT}=require('./assistant');
let assistant;
onInit(()=>{
 const {getApps,initializeApp}=require('firebase-admin/app');if(!getApps().length)initializeApp();
 const {getFirestore}=require('firebase-admin/firestore');const {GoogleAuth}=require('google-auth-library');
 const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
 assistant=createAssistant({db:getFirestore(),requestModel:async (body,{timeoutMs=65000}={})=>{
  const headers=new Headers(await auth.getRequestHeaders(ENDPOINT));headers.set('content-type','application/json');
  const response=await fetch(ENDPOINT,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw new Error('VERTEX_HTTP_'+response.status);
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>256000)throw new Error('VERTEX_RESPONSE_LIMIT');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }});
});
exports.askRevexProject=onCall({region:'us-central1',memory:'256MiB',timeoutSeconds:90,maxInstances:2,concurrency:2,invoker:'public'},async request=>{
 try{return await assistant(request);}catch(error){throw new HttpsError(error.code||'internal',error.message||'WALLT is temporarily unavailable.');}
});
