// Real Docker: requests sent straight to the socket proxy from the provisioner's address, so only the
// allow-list in socket-proxy.env decides. Destructive calls carry a filter that matches nothing, in case
// the allow-list were ever wrong.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { docker, down, execIn, IMAGE, tryDocker, up } from './fixtures/stack.ts'

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
  ]
  assert.deepEqual(statuses('provisioner', refused), refused.map(() => 403))
  assert.notEqual(tryDocker('volume', 'inspect', 'selfbase-test-keep'), null)
})

test('allowed calls pass, with or without the version prefix', () => {
  assert.deepEqual(statuses('provisioner', [['GET', `/v1.45/containers/${SB}/json`], ['GET', `/containers/${SB}/json`],
    ['GET', '/_ping'], ['GET', `/v1.45/images/${IMAGE}/json`]]), [200, 200, 200, 200])
})

test('any other client address gets 403', () => {
  assert.deepEqual(statuses('control', [['GET', '/_ping'], ['GET', `/containers/${SB}/json`]]), [403, 403])
})
