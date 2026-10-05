import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { readZip, writeZip, crc32, ZipError } from '../src/scratch/zip.mjs'
import {
  readSb3,
  writeSb3,
  assetMd5ext,
  listAssetRefs,
  blankProject,
  summarizeContainer,
  Sb3Error,
  PROJECT_ENTRY
} from '../src/scratch/sb3.mjs'

const bytes = (text) => Buffer.from(text, 'utf8')

test('round-trips stored and deflated entries', () => {
  const archive = writeZip([
    { name: 'small.txt', data: bytes('hello') },
    { name: 'repetitive.txt', data: bytes('ab'.repeat(5000)) }
  ])
  const entries = readZip(archive)
  assert.deepEqual([...entries.keys()], ['small.txt', 'repetitive.txt'])
  assert.equal(entries.get('small.txt').toString('utf8'), 'hello')
  assert.equal(entries.get('repetitive.txt').toString('utf8'), 'ab'.repeat(5000))
  // Highly repetitive data must actually be compressed, or the deflate path is dead code.
  assert.ok(archive.length < 2000, `expected compression, archive was ${archive.length} bytes`)
})

test('stores incompressible entries without inflating them', () => {
  const random = Buffer.alloc(4096)
  for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) % 251
  const archive = writeZip([{ name: 'blob.bin', data: random }])
  assert.deepEqual(readZip(archive).get('blob.bin'), random)
})

test('is deterministic: identical input yields identical bytes', () => {
  const entries = [{ name: 'a.txt', data: bytes('one') }, { name: 'b.txt', data: bytes('two') }]
  assert.deepEqual(writeZip(entries), writeZip(entries))
})

test('preserves UTF-8 entry names', () => {
  const archive = writeZip([{ name: '角色/造型.svg', data: bytes('<svg/>') }])
  assert.deepEqual([...readZip(archive).keys()], ['角色/造型.svg'])
})

test('reads an empty archive', () => {
  assert.equal(readZip(writeZip([])).size, 0)
})

test('detects corruption with the CRC check', () => {
  const archive = writeZip([{ name: 'a.txt', data: bytes('payload') }])
  const corrupted = Buffer.from(archive)
  // Derive the payload offset from the local header rather than guessing, so the
  // test keeps testing the CRC and not, say, a timestamp field.
  const localNameLength = corrupted.readUInt16LE(26)
  const dataOffset = 30 + localNameLength
  assert.equal(corrupted.subarray(dataOffset, dataOffset + 7).toString('utf8'), 'payload')
  corrupted[dataOffset] ^= 0xff
  assert.throws(() => readZip(corrupted), ZipError)
})

test('rejects things that are not archives', () => {
  assert.throws(() => readZip(bytes('not a zip at all, just some text')), ZipError)
  assert.throws(() => readZip(Buffer.alloc(4)), ZipError)
})

test('computes the documented CRC-32 of a known string', () => {
  // The canonical check value for "123456789" is 0xCBF43926.
  assert.equal(crc32(bytes('123456789')), 0xcbf43926)
})

test('computes real MD5 asset names', () => {
  const data = bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')
  const expected = `${createHash('md5').update(data).digest('hex')}.svg`
  assert.equal(assetMd5ext(data, 'svg'), expected)
})

test('round-trips a project with assets', () => {
  const project = blankProject()
  const costume = bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
  const md5ext = assetMd5ext(costume, 'svg')
  project.targets[0].costumes.push({
    name: 'backdrop1',
    dataFormat: 'svg',
    assetId: md5ext.split('.')[0],
    md5ext,
    rotationCenterX: 5,
    rotationCenterY: 5
  })

  const archive = writeSb3(project, new Map([[md5ext, costume]]))
  const parsed = readSb3(archive)

  assert.deepEqual(parsed.warnings, [])
  assert.deepEqual(parsed.project, project)
  assert.equal(parsed.assets.size, 1)
  assert.deepEqual(parsed.assets.get(md5ext), costume)
})

test('accepts a plain object of assets', () => {
  const project = blankProject()
  const archive = writeSb3(project, { 'abc.svg': bytes('<svg/>') })
  assert.equal(readSb3(archive).assets.size, 1)
})

test('warns about missing and unreferenced assets instead of failing', () => {
  const project = blankProject()
  project.targets[0].costumes.push({ name: 'lost', dataFormat: 'png', assetId: 'deadbeef', md5ext: 'deadbeef.png' })
  const archive = writeSb3(project, new Map([['orphan.svg', bytes('<svg/>')]]))
  const parsed = readSb3(archive)
  assert.equal(parsed.warnings.length, 2)
  assert.ok(parsed.warnings.some((w) => /deadbeef\.png is referenced .* but missing/.test(w)))
  assert.ok(parsed.warnings.some((w) => /orphan\.svg is in the archive but not referenced/.test(w)))
})

test('rejects an archive without project.json', () => {
  const archive = writeZip([{ name: 'something.txt', data: bytes('x') }])
  assert.throws(() => readSb3(archive), (error) => {
    assert.ok(error instanceof Sb3Error)
    assert.match(error.message, /no project\.json/)
    return true
  })
})

test('rejects a project.json that is not JSON or has no targets', () => {
  assert.throws(() => readSb3(writeZip([{ name: PROJECT_ENTRY, data: bytes('{oops') }])), Sb3Error)
  assert.throws(() => readSb3(writeZip([{ name: PROJECT_ENTRY, data: bytes('{"a":1}') }])), (error) => {
    assert.match(error.message, /no targets array/)
    return true
  })
})

test('refuses to write something that is not a project', () => {
  assert.throws(() => writeSb3({}), Sb3Error)
  assert.throws(() => writeSb3(blankProject(), { [PROJECT_ENTRY]: bytes('x') }), Sb3Error)
})

test('lists asset references once each', () => {
  const project = blankProject()
  project.targets.push({
    isStage: false,
    name: 'Sprite1',
    costumes: [{ md5ext: 'a.png' }, { md5ext: 'a.png' }, { md5ext: 'b.svg' }],
    sounds: [{ md5ext: 'c.wav' }]
  })
  assert.deepEqual(listAssetRefs(project), ['a.png', 'b.svg', 'c.wav'])
})

test('summarizes a container', () => {
  const project = blankProject()
  project.targets[0].blocks = { a: { opcode: 'event_whenflagclicked' } }
  const summary = summarizeContainer(project, new Map([['x.svg', Buffer.alloc(10)]]))
  assert.deepEqual(summary, {
    targets: [{ name: 'Stage', isStage: true, blocks: 1, costumes: 0, sounds: 0 }],
    assetCount: 1,
    assetBytes: 10
  })
})

test('blank projects are valid without any assets', () => {
  const archive = writeSb3(blankProject())
  const parsed = readSb3(archive)
  assert.deepEqual(parsed.warnings, [])
  assert.equal(parsed.project.targets.length, 1)
  assert.equal(parsed.project.targets[0].isStage, true)
})
