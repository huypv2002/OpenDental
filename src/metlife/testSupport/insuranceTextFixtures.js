// Synthetic documents only. No clinic patient source files.
export const row=parts=>{let s='';for(const [x,value] of parts)s=s.padEnd(Math.max(x,s.length+1),' ')+value;return s;};
const mHeader=[['(Code)',45],['Tooth',75],['Charged',90],['Negotiated',110],['Expense',130],['Applied',150],['Plan',170]];
const cHeader=[['Tooth',40],['Charged',60],['Allowed',80],['Applied',100],['Balance',120],['Contracted',140],['Coinsurance',160]];
const makeHeader=p=>row(p.map(([label,x])=>[x,label]));
const mMoney=['$100.00','$0.00','$100.00','$0.00','$80.00'];
export const metlifeText=[
 'Claim Summary','Claim Number: 1234567890 99','Patient Name: TEST PERSON','Relationship to Subscriber: Self','Subscriber Name: TEST PERSON','Group Number: 12345','PROCESSED on 09/29/2026','Date Received: 09/22/2026','Claim Detail',makeHeader(mHeader),
 row([[10,'09/20/2026'],[28,'Approved'],[45,'( D4341 )'],[75,'UR'],...mMoney.map((s,i)=>[90+20*i,s])]),
 row([[10,'Total'],...mMoney.map((s,i)=>[90+20*i,s])]),
 '\f','Payment Detail',row([[10,'Status'],[30,'Date'],[50,'Paid'],[130,'Method'],[155,'ID']]),
 row([[10,'Paid /'],[30,'09/24/2026'],[50,'$80.00'],[130,'EFT'],[155,'123456789']]),'          Settled','Notes to Claimant','D4341 appears here only in a note.'
].join('\n');
export const libertyText=`LIBERTY Dental Plan
PAYMENT DETAILS
VENDOR NAME: EXAMPLE
VENDOR NUMBER: 12345
Check Number: 109119
Check Date: 10/02/2026
Patient: PERSON, TEST - MEMBER01
Plan: EXAMPLE Group: GROUP01
CLAIM: 77361505 (Original)
1 09/17/26 D5110 Q01 Complete denture, maxillary 950.00 743.00 0.00 0.00 0.00 0.00 743.00
CLAIM TOTALS: 950.00 743.00 0.00 0.00 0.00 0.00 743.00
NET PAYMENT FOR PATIENT: 743.00
NET PAYMENT: 743.00`;
export const cignaText=[
 'Claim/Reference Number: E262868007800','Patient Name: TEST PERSON | View Coverage','Date Processed: 10/15/2026','Claim Amount Paid: $56.80','Claim Status: PROCESSED',makeHeader(cHeader),
 row([[3,'10/11/2026-'],[25,'D2392 -'],[40,'03'],[60,'$150.00'],[80,'$79.00'],[100,'$0.00'],[120,'$71.00'],[140,'$0.00'],[160,'80%=']]),
 row([[3,'10/11/2026'],[25,'Filling, 2'],[160,'$56.80']]),
 row([[3,'Totals'],[60,'$150.00'],[80,'$79.00'],[100,'$0.00'],[120,'$71.00'],[140,'$0.00'],[160,'$56.80']])
].join('\n');

export const delta=`DELTA DENTAL Provider Tools | Fee for service
Claim 20262965110923
TEST PERSON
Patient date of birth Relationship to policy holder/subscriber
06/06/1981 Dependent
Policy holder/subscriber name Subscriber ID Employer or group name
OTHER PERSON 115084523301 GROUP
Payment status
Outstanding Paid to
Amount Payment status updated Payee address
$542.40 10/28/2026
Date payment sent
10/28/2026
10/22/2026 D2393 04 D.M.O $170.00 $170.00 $170.00 $50.00 80% $96.00 $74.00
10/22/2026 D2393 19 L.M.O $170.00 $170.00 $170.00 $0.00 80% $136.00 $34.00
Claim total
$340.00 $340.00 $340.00 $50.00 - $232.00 $108.00`;
