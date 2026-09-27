import {createSseCapacityPeerRunV3} from './staging-sse-capacity-peer-run-v3.mjs';
import {createSsePeerRejectionCaptureV3} from './staging-sse-peer-rejection-capture-v3.mjs';

/** New entry for future independently authorized windows. Frozen published
 * run/CLI artifacts remain unchanged. No I/O until run(), no new cloud scope. */
export function createSseCapacityPeerRunWithRejectionV3(options) {
  const capture=createSsePeerRejectionCaptureV3({clock:options.session.clock,persist:options.persist,fetchImpl:options.fetchImpl});
  const inner=createSseCapacityPeerRunV3({...options,fetchImpl:capture.fetch});
  let running,completed;
  const report=()=>structuredClone(completed??{...inner.report(),rejectionCapture:capture.report()});
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
