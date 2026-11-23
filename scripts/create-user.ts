/**
 * Create a login. The password is NEVER taken from argv (it would land in shell history and `ps`).
 *
 *   bun scripts/create-user.ts --email owner@acme.com --role owner --business biz_123
 *   bun scripts/create-user.ts --email root@acme.com --role admin           # global admin, no business
 *
 * Password source, first match wins:
 *   1. CREATE_USER_PASSWORD env var
 *   2. piped stdin:   printf '%s' "$PW" | bun scripts/create-user.ts --email ...
 *   3. interactive prompt (hidden input, asked twice)
 */
import readline from 'node:readline';
import { createUser, disconnect, EmailTakenError, getBusiness } from '../src/lib/db';
import { hashPassword } from '../src/lib/password';
import { validateEmail, validateNewPassword } from '../src/lib/user-policy';
import type { UserRole } from '../src/lib/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = rl as unknown as { _writeToOutput: (s: string) => void };
    process.stdout.write(question);
    w._writeToOutput = () => {}; // do not echo the password
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function getPassword(): Promise<string> {
  if (process.env.CREATE_USER_PASSWORD) return process.env.CREATE_USER_PASSWORD;
  if (!process.stdin.isTTY) return readStdin();
  const a = await promptHidden('Password: ');
  const b = await promptHidden('Repeat password: ');
  if (a !== b) throw new Error('passwords do not match');
  return a;
}

async function main() {
  if (process.argv.includes('--password')) {
    throw new Error('refusing --password: passwords are never passed on the command line (use CREATE_USER_PASSWORD, stdin or the prompt)');
  }
  const email = arg('email');
  const role = arg('role') as UserRole | undefined;
  const businessId = arg('business');
  const emailErr = validateEmail(email);
  if (emailErr) throw new Error(emailErr);
  if (role !== 'owner' && role !== 'staff' && role !== 'admin') throw new Error('--role must be owner, staff or admin');
  if (role === 'admin' && businessId) throw new Error('admin users have no business: omit --business');
  if (role !== 'admin') {
    if (!businessId) throw new Error('--business <id> is required for owner/staff');
    if (!(await getBusiness(businessId))) throw new Error(`business ${businessId} not found`);
  }
  const password = await getPassword();
  const pwErr = validateNewPassword(password);
  if (pwErr) throw new Error(pwErr);

  const user = await createUser({
    email: email as string,
    password_hash: await hashPassword(password),
    role,
    business_id: role === 'admin' ? null : businessId,
    email_verified: true, // created by an operator with shell access: the address is vouched for
  });
  console.log(`created ${user.role} ${user.email} (id ${user.id}${user.business_id ? `, business ${user.business_id}` : ''})`);
}

main()
  .catch((err) => {
    console.error(err instanceof EmailTakenError ? 'email already registered' : `error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
