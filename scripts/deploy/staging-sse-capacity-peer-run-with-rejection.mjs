import {createSseCapacityPeerRun} from './staging-sse-capacity-peer-run.mjs';
import {createSsePeerRejectionCapture} from './staging-sse-peer-rejection-capture.mjs';

/** New entry for future independently authorized windows. Frozen published
 * run/CLI artifacts remain unchanged. No I/O until run(), no new cloud scope. */
export function createSseCapacityPeerRunWithRejection(options) {
  const capture=createSsePeerRejectionCapture({clock:options.session.clock,persist:options.persist,fetchImpl:options.fetchImpl});
  const inner=createSseCapacityPeerRun({...options,fetchImpl:capture.fetch});
  let running,completed;
  const report=()=>({...inner.report(),rejectionCapture:capture.report(),...(completed?{result:completed.result}:{})});
  return Object.freeze({
    run(){return running??=(async()=>{
      let value;
      try{value=await inner.run();}finally{capture.seal();}
      completed={...value,rejectionCapture:capture.report()};
      if(completed.rejectionCapture.journalFailed){completed.result='ATTENTION_REQUIRED';completed.errors.push('rejection-journal');}
      return structuredClone(completed);
    })();},
    report,
  });
}
