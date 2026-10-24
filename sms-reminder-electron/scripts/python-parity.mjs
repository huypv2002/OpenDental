import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {renderMessage,logPayload,phoneFor,digits} from '../shared/model.mjs';
for (const source of ['../sms-reminder-tool/sms_reminder_app.py','../sms-reminder-tool-uiautomation/sms_reminder_app.py']) {
const {config,today,fixtures,contracts,phones}=JSON.parse(execFileSync('python3',['scripts/python-parity.py',source],{maxBuffer:10*1024*1024}));
console.log(`Source: ${source}`);
let failures=0;
for(const fixture of fixtures){const actual=renderMessage(config,fixture.row,fixture.template,today);if(actual!==fixture.expected){if(failures++<3)console.error(JSON.stringify({age:fixture.row.Birthdate,gender:fixture.row.Gender,country:fixture.row._TemplateCountry,apt:fixture.row.AptDateTime,actual,expected:fixture.expected}));}}
assert.equal(failures,0,`${failures} Python/Electron render mismatches`);
console.log(`Python source parity: ${fixtures.length} rendered messages match exactly.`);

for (const item of contracts) assert.deepEqual(logPayload(item.row,"Demo message",item.status,today,item.error),item.expected);
for (const item of phones) {assert.equal(phoneFor(item.row),item.expected);assert.equal(digits(item.row.WirelessPhone),item.digits);}
console.log(`Python source parity: ${contracts.length} log payloads and ${phones.length} phone cases match exactly.`);

}
