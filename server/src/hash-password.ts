import { hashPassword } from './auth.ts';

const password = process.argv[2];
if (!password) {
  console.error('Cách dùng: npm run hash-password -- "mat-khau-cua-ban"');
  process.exit(1);
}

console.log(hashPassword(password));
