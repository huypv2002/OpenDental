export const DEFAULT_CONFIG=Object.freeze({schemaVersion:4,noteTemplate:'Claim number: {claim}',paymentType:'Insurance Paid'});
export function loadConfig(value){
 // Existing group/check notes must migrate to the agreed claim-only format.
 if(value?.schemaVersion!==4||typeof value.paymentType!=='string'||!value.paymentType||value.paymentType.length>100)return {...DEFAULT_CONFIG};
 return {...DEFAULT_CONFIG,paymentType:value.paymentType};
}
