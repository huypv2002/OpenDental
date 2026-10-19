import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {EDITIONS,resolveEdition,assertEditionAction}=require('../lib/edition.cjs');
test('one payments build reuses the payment journal profile',()=>{
 assert.deepEqual(Object.keys(EDITIONS),['payments']);
 assert.equal(resolveEdition().id,'payments');
 assert.equal(resolveEdition().profile,'api-od');
 assert.equal(resolveEdition({argv:['--metlife-edition=api-od']}).id,'payments');
 assert.equal(resolveEdition({packaged:true,metadata:'payments',argv:['--metlife-edition=client']}).id,'payments');
 assert.throws(()=>resolveEdition({argv:['--metlife-edition=client']}));
});
test('payment app rejects desktop automation actions',()=>{
 for(const action of ['fill-preview','save-preview','close-preview','inspect-od'])assert.throws(()=>assertEditionAction(EDITIONS.payments,action));
 assert.doesNotThrow(()=>assertEditionAction(EDITIONS.payments,'save-payment'));
});
