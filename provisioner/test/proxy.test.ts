// Real Docker: requests sent straight to the socket proxy from the provisioner's address, so only the
// allow-list in socket-proxy.env decides. Destructive calls carry a filter that matches nothing, in case
// the allow-list were ever wrong.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKUP_DIR, docker, down, execIn, IMAGE, PROXY_NET, tryDocker, up } from './fixtures/stack.ts'

const SB = 'sb-proxytest-probe'
const NOTHING = encodeURIComponent(JSON.stringify({ label: ['selfbase.test.never=1'] }))

const statuses = (service: string, reqs: [string, string][]): number[] => JSON.parse(execIn(service,
  `const H='http://selfbase-socket-proxy:2375';Promise.all(${JSON.stringify(reqs)}.map(([m,p])=>fetch(H+p,{method:m}).then(r=>r.status,()=>-1))).then(s=>console.log(JSON.stringify(s)))`))

before(async () => {
  tryDocker('rm', '-f', SB)
  await up()
  docker('create', '--name', SB, IMAGE)
  docker('volume', 'create', 'selfbase-test-keep')
})
after(() => {
  tryDocker('rm', '-f', SB)
  tryDocker('volume', 'rm', 'selfbase-test-keep')
  down()
})

test('the proxy refuses everything outside the allow-list with 403', () => {
  const refused: [string, string][] = [
    ['POST', `/v1.45/containers/${SB}/exec`],
    ['POST', '/v1.45/build'],
    ['POST', '/v1.45/commit'],
    ['GET', '/v1.45/swarm'],
    ['POST', `/v1.45/containers/prune?filters=${NOTHING}`],
    ['POST', `/v1.45/system/prune?filters=${NOTHING}`],
    ['GET', '/v1.45/containers/selfbase-test-control/json'],
    ['DELETE', '/v1.45/volumes/selfbase-test-keep'],
    ['POST', '/v1.45/networks/selfbase-test-control/connect'],
    ['GET', `/v1.45/containers/${SB}%2F..%2Fselfbase-test-control/json`],
    ['GET', '/v1.45/images/a/../../containers/selfbase-test-control/json'],
    // security review: the shared network is connect-only; image inspect is our registry path only
    ['POST', `/v1.45/networks/${PROXY_NET}/disconnect`],
    ['GET', '/v1.45/images/node:24.22.2-slim/json'],
    ['GET', '/v1.45/images/selfbase-test.invalid/other/selfbase-core:test/json'],
    // every pattern is anchored: an allowed path inside a longer one does not pass
    ['GET', `/v1.45/x/containers/${SB}/json`],
    ['GET', `/v1.45/containers/${SB}/json/x`],
    ['GET', `/v1.45/containers/${SB}/jsonx`],
    ['GET', `/xx/v1.45/containers/${SB}/json`],
    ['POST', `/v1.45/networks/sb-x/connect/../../${PROXY_NET}/disconnect`],
  ]
  assert.deepEqual(statuses('provisioner', refused), refused.map(() => 403))
  assert.notEqual(tryDocker('volume', 'inspect', 'selfbase-test-keep'), null)
})

test('allowed calls pass, with or without the version prefix', () => {
  assert.deepEqual(statuses('provisioner', [['GET', `/v1.45/containers/${SB}/json`], ['GET', `/containers/${SB}/json`],
    ['GET', '/_ping'], ['GET', `/v1.45/images/${IMAGE}/json`]]), [200, 200, 200, 200])
})

test('a bind mount from anywhere but the backup dir is 403; the backup dir passes', () => {
  const name = 'sb-proxytest-bind'
  const create = (hc: object) => JSON.parse(execIn('provisioner', `fetch('http://selfbase-socket-proxy:2375/v1.45/containers/create?name=${name}',`
    + `{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({Image:'${IMAGE}',HostConfig:${JSON.stringify(hc)}})})`
    + '.then(r=>console.log(r.status),()=>console.log(-1))'))
  try {
    assert.equal(create({ Binds: ['/:/host'] }), 403)
    assert.equal(create({ Mounts: [{ Type: 'bind', Source: '/var/run', Target: '/x' }] }), 403)
    assert.equal(create({ Mounts: [{ Type: 'bind', Source: `${BACKUP_DIR}/../../../var/run`, Target: '/x' }] }), 403)
    // a sibling that only shares the prefix is another directory
    assert.equal(create({ Mounts: [{ Type: 'bind', Source: `${BACKUP_DIR}x`, Target: '/x' }] }), 403)
    assert.equal(create({ Mounts: [{ Type: 'bind', Source: `${BACKUP_DIR}-evil`, Target: '/x' }] }), 403)
    assert.equal(create({ Binds: [`${BACKUP_DIR}-evil:/x`] }), 403)
    assert.equal(tryDocker('inspect', name), null)
    assert.equal(create({ Mounts: [{ Type: 'bind', Source: BACKUP_DIR, Target: '/backups' }] }), 201)
  } finally {
    tryDocker('rm', '-f', name)
  }
})

test('any other client address gets 403', () => {
  assert.deepEqual(statuses('control', [['GET', '/_ping'], ['GET', `/containers/${SB}/json`]]), [403, 403])
})
