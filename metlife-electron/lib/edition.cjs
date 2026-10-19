const EDITIONS=Object.freeze({
 client:Object.freeze({id:'client',productName:'LUK MetLife Client',displayName:'Tự điền trên OD',profile:'client',appId:'us.lukdental.metlife.client'}),
 'api-od':Object.freeze({id:'api-od',productName:'LUK MetLife Payments',displayName:'Lưu thanh toán',profile:'api-od',appId:'us.lukdental.metlife.payments'})
});
function resolveEdition({packaged=false,metadata='client',argv=[]}={}){
 const arg=packaged?undefined:argv.find(v=>v.startsWith('--metlife-edition='));
 const id=arg?arg.slice('--metlife-edition='.length):metadata;
 if(!Object.hasOwn(EDITIONS,id))throw new Error('Unknown MetLife edition');
 return EDITIONS[id];
}
function assertEditionAction(edition,action){
 if((edition.id==='client'&&action==='save-payment')||(edition.id==='api-od'&&['fill-preview','close-preview','inspect-od'].includes(action)))throw new Error('Thao tác này không có trong bản đang dùng.');
}
module.exports={EDITIONS,resolveEdition,assertEditionAction};
