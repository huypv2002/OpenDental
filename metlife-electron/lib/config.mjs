export const DEFAULT_CONFIG=Object.freeze({schemaVersion:3,noteTemplate:'group number : {group}',paymentType:'Insurance Paid'});
export function loadConfig(value){
  // Version 0.1.0 used a provisional note and had no agreed payment type.
  if(value?.schemaVersion!==3)return {...DEFAULT_CONFIG};
  if(typeof value.noteTemplate!=='string'||value.noteTemplate.length>2000||typeof value.paymentType!=='string'||value.paymentType.length>100)return {...DEFAULT_CONFIG};
  return {schemaVersion:3,noteTemplate:value.noteTemplate,paymentType:value.paymentType};
}
