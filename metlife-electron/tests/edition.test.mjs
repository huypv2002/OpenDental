import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {EDITIONS,resolveEdition,assertEditionAction}=require('../lib/edition.cjs');
test('edition profiles and IDs are independent; packaged builds ignore launch overrides',()=>{
 assert.notEqual(EDITIONS.client.profile,EDITIONS['api-od'].profile);
 assert.notEqual(EDITIONS.client.appId,EDITIONS['api-od'].appId);
 assert.equal(resolveEdition({packaged:true,metadata:'client',argv:['--metlife-edition=api-od']}).id,'client');
 assert.equal(resolveEdition({packaged:true,metadata:'api-od',argv:['--metlife-edition=client']}).id,'api-od');
 assert.equal(resolveEdition({argv:['--metlife-edition=api-od']}).id,'api-od');
 assert.throws(()=>resolveEdition({metadata:'invalid'}));
});
test('client cannot submit a payment and API edition cannot automate OD',()=>{
 assert.throws(()=>assertEditionAction(EDITIONS.client,'save-payment'));
 for(const action of ['fill-preview','close-preview','inspect-od'])assert.throws(()=>assertEditionAction(EDITIONS['api-od'],action));
 assert.doesNotThrow(()=>assertEditionAction(EDITIONS.client,'fill-preview'));
 assert.doesNotThrow(()=>assertEditionAction(EDITIONS['api-od'],'save-payment'));
});
