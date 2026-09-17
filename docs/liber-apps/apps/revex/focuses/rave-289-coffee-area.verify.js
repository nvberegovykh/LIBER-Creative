/* Post-output read-only verifier for Rave 289 coffee area.
 * Pass a focusId returned by rave-289-coffee-area.run.js and optional evidence metadata.
 */
(function(root){
'use strict';
root.verifyRave289CoffeeArea=function(focusId,evidence={}){
  if(!root.RevexCoffeeAreaObserver) throw new Error('window.RevexCoffeeAreaObserver unavailable');
  const result=root.RevexCoffeeAreaObserver.verify(focusId,evidence);
  const ok=!!result?.preview?.canProceed;
  const out={ok,focusId:result?.focus?.focusId||focusId,after:result?.after||null,preview:result?.preview||null,event:result?.event||null};
  console.log('RAVE_289_COFFEE_OBSERVER_VERIFY_RESULT',out);
  return out;
};
})(window);
