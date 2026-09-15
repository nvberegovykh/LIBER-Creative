/* Run inside an authorized REVEX browser session after r143 Observer and r147 coffee recipe are loaded.
 * Read-only: creates focus, snapshots, previews, journals evidence. No project mutation.
 */
(async function(){
  const out={ok:false,at:new Date().toISOString()};
  try{
    if(!window.RevexObserver) throw new Error('window.RevexObserver unavailable');
    if(!window.RevexCoffeeAreaObserver) throw new Error('window.RevexCoffeeAreaObserver unavailable');
    const result=window.RevexCoffeeAreaObserver.start();
    out.ok=!!result?.preview?.canProceed;
    out.focusId=result?.focus?.focusId||null;
    out.projectId=result?.before?.projectId||null;
    out.revision=result?.before?.revision||null;
    out.preview=result?.preview||null;
    out.step=result?.step||null;
    out.snapshot=result?.before||null;
  }catch(error){out.error=String(error?.stack||error?.message||error);}
  console.log('RAVE_289_COFFEE_OBSERVER_RESULT',out);
  return out;
})();
