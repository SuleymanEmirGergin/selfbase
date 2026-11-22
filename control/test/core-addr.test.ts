// Control reaches a project's core by the address the provisioner read from Docker on sb-<ref>, never by a DNS name
// (another network's address, or a name anything on a shared network could answer).
import { expect, it } from 'vitest'
import { coreIp, forgetCoreIp } from '../src/core-addr.ts'
import { FakeProvisioner } from './fake-provisioner.ts'

const REF = 'coreaddrtestaaaaaaaa'

it('comes from the provisioner, is cached per ref, and is read again once forgotten', async () => {
  const fake = new FakeProvisioner()
  fake.set(REF, 'core', { exists: true, state: 'running', projectIp: '10.207.0.3' })
  expect(await coreIp(fake, REF)).toBe('10.207.0.3')
  fake.set(REF, 'core', { projectIp: '10.207.0.9' })
  expect(await coreIp(fake, REF)).toBe('10.207.0.3')
  expect(fake.callsOf('inspect')).toHaveLength(1)
  forgetCoreIp(REF)
  expect(await coreIp(fake, REF)).toBe('10.207.0.9')
})

it('a core without an address on its network is unreachable', async () => {
  const fake = new FakeProvisioner()
  forgetCoreIp(REF)
  await expect(coreIp(fake, REF)).rejects.toMatchObject({ status: 502, code: 'project_unreachable' })
})
