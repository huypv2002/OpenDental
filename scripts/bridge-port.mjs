import fs from 'node:fs';
import dotenv from 'dotenv';
const env = dotenv.parse(fs.readFileSync(new URL('../.env', import.meta.url)));
console.log(env.PORT || '3008');
