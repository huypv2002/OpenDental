import cases from "../tests/core.test.mjs";
let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} tests passed.`);
process.exitCode = failed ? 1 : 0;
