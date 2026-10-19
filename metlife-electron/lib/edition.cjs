// Reuse the previous payment profile so pending receipts remain recoverable.
const EDITIONS=Object.freeze({payments:Object.freeze({id:'payments',productName:'LUK MetLife Payments',displayName:'Thanh toán MetLife',profile:'api-od',appId:'us.lukdental.metlife.payments'})});
function resolveEdition({packaged=false,metadata='payments',argv=[]}={}){
 const arg=packaged?undefined:argv.find(v=>v.startsWith('--metlife-edition='));
 const requested=arg?arg.slice('--metlife-edition='.length):metadata;
 const id=requested==='api-od'?'payments':requested;
 if(!Object.hasOwn(EDITIONS,id))throw new Error('Unknown MetLife edition');
 return EDITIONS[id];
}
function assertEditionAction(edition,action){
 if(['fill-preview','save-preview','close-preview','inspect-od'].includes(action))throw new Error('Thao tác này không có trong bản đang dùng.');
}
module.exports={EDITIONS,resolveEdition,assertEditionAction};
