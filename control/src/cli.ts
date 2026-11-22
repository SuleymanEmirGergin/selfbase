// Operator commands, run inside the control container:
//   node src/cli.ts create-owner <email>     (password on stdin)
// create-owner makes the first dashboard account, the organization `default` and its owner membership. It refuses
// once any account exists: later accounts come through invitations.
import { closeDb, migrate } from './db.ts'
import { MIN_PASSWORD } from './core-env.ts'
import { createConfirmedUser, tx } from './routes/platform-auth.ts'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function createOwner(email: string, password: string): Promise<string> {
  if (!EMAIL_RE.test(email)) throw new Error('create-owner: not an email address')
  if (password.length < MIN_PASSWORD) throw new Error(`create-owner: the password must be at least ${MIN_PASSWORD} characters`)
  await migrate()
  // one transaction: all three rows or none; the lock serialises two create-owner runs so only one sees no users
  return tx(async (client) => {
    await client.query(`lock table auth.users in share row exclusive mode`)
    if ((await client.query(`select 1 from auth.users limit 1`)).rowCount) throw new Error('create-owner: an account already exists; invite users from Studio')
    const user = await createConfirmedUser(email, password, client)
    const org = (await client.query(`insert into control.organizations (slug, name) values ('default', 'Default') returning id`)).rows[0]
    await client.query(`insert into control.memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [org.id, user.id])
    return user.email
  })
}

async function readStdin(): Promise<string> {
  let s = ''
  for await (const chunk of process.stdin) s += chunk
  return s.replace(/\r?\n$/, '')
}

if (import.meta.main) {
  const [cmd, email] = process.argv.slice(2)
  try {
    if (cmd !== 'create-owner' || !email) throw new Error('usage: cli.ts create-owner <email>   (password on stdin)')
    console.log(await createOwner(email.toLowerCase(), await readStdin()))
    await closeDb()
  } catch (e) {
    // the message never contains the password
    console.error((e as Error).message)
    await closeDb().catch(() => {})
    process.exitCode = 1
  }
}
