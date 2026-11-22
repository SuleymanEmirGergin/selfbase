import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { render, validateTemplate, TemplateError } from '../src/template.ts'

const fixturePath = new URL('./fixtures/template.yml', import.meta.url)
const fixture = () => parse(readFileSync(fixturePath, 'utf8')) as any

test('the fixture validates', () => {
  const tpl = validateTemplate(fixture())
  assert.deepEqual(Object.keys(tpl.services), ['db', 'rest', 'core', 'fn', 'pooler'])
  assert.deepEqual(tpl.volumes, ['pgdata', 'storage', 'functions', 'denocache'])
  assert.deepEqual(tpl.services.fn.volumes[0], { name: 'functions', path: '/supabase', readOnly: true })
})

const refusedServiceKeys: [string, unknown][] = [
  ['privileged', true], ['cap_add', ['SYS_ADMIN']], ['ports', ['8080:8080']], ['network_mode', 'host'],
  ['pid', 'host'], ['devices', ['/dev/sda']], ['build', '.'], ['labels', { a: 'b' }], ['x-foo', 1],
]
for (const [key, value] of refusedServiceKeys) {
  test(`service key ${key} is refused naming it`, () => {
    const t = fixture()
    t.services.core[key] = value
    assert.throws(() => validateTemplate(t), (e: Error) => e instanceof TemplateError && e.message.includes(key))
  })
}

test('top-level networks and x-* are refused naming the key', () => {
  for (const key of ['networks', 'x-foo']) {
    const t = fixture()
    t[key] = {}
    assert.throws(() => validateTemplate(t), (e: Error) => e instanceof TemplateError && e.message.includes(key))
  }
})

for (const bind of ['/:/host', './rel:/x', 'C:\\x:/y', 'undeclared:/x', 'pgdata:/x:rw']) {
  test(`volume ${bind} is refused naming volumes`, () => {
    const t = fixture()
    t.services.db.volumes.push(bind)
    assert.throws(() => validateTemplate(t), (e: Error) => e instanceof TemplateError && e.message.includes('volumes'))
  })
}

test('depends_on must name a service and must not cycle', () => {
  const t = fixture()
  t.services.db.depends_on = ['nope']
  assert.throws(() => validateTemplate(t), /depends_on/)
  const c = fixture()
  c.services.db.depends_on = ['core']
  assert.throws(() => validateTemplate(c), /cycle/)
})

test('interpolation into a CMD-SHELL healthcheck is refused', () => {
  const t = fixture()
  t.services.db.healthcheck.test = ['CMD-SHELL', 'pg_isready -U ${USER}']
  assert.throws(() => validateTemplate(t), /healthcheck/)
})

test('render: the three ${} forms', () => {
  assert.equal(render('${A:-b}', {}), 'b')
  assert.equal(render('${A:-b}', { A: '' }), 'b')
  assert.equal(render('x${A}y', { A: '1' }), 'x1y')
  assert.equal(render('$$HOME', {}), '$HOME')
  assert.throws(() => render('${A:?need A}', {}), (e: Error) => e instanceof TemplateError && e.message.includes('need A'))
  assert.throws(() => render('${A}', {}), TemplateError)
  assert.throws(() => render('$(cmd)', { cmd: 'x' }), TemplateError)
  assert.throws(() => render('${A/b/c}', { A: 'abc' }), TemplateError)
  assert.throws(() => render('$A', { A: 'x' }), TemplateError)
  assert.throws(() => render('${A:-$B}', { B: 'x' }), TemplateError)
})

