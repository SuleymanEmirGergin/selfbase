// The e2e teardown removes only what its run created: an sb-* network or volume someone else makes while the run is
// going is not on its list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { docker, dockerOk, runResources } from './helpers.mjs'

test('a foreign sb-* network and volume made during the run are not removed', () => {
  const decoy = `sb-decoy-${randomBytes(4).toString('hex')}`
  docker('network', 'create', decoy)
  docker('volume', 'create', decoy)
  try {
    const plan = runResources(new Set(['abcdefghijklmnopqrst']))
    assert.ok(!plan.networks.includes(decoy), 'network on the list')
    assert.ok(!plan.volumes.includes(decoy), 'volume on the list')
  } finally {
    dockerOk('network', 'rm', decoy)
    dockerOk('volume', 'rm', decoy)
  }
})
