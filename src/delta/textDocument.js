import {readInsuranceTextDocument} from '../metlife/textDocument.js';
export {decodeClaimText} from '../metlife/textDocument.js';

// Compatibility entrypoint: the scanner now uses the shared four-carrier reader.
export function readDeltaTextDocument(bytes){
 const result=readInsuranceTextDocument(bytes);
 if(result.extracted.textCarrier!=='DELTA DENTAL')throw new Error('TXT không phải mẫu Delta Dental Provider Tools.');
 return result;
}
