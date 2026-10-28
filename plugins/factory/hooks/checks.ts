// Which check commands a repository has. Every ecosystem is its own detector, and nothing here
// throws: a detector that fails, or reads a malformed file, gives no checks and a warning. Files
// that are only CI config (azure-pipelines.yml, .github/workflows, Jenkinsfile) are never read.
// Commands are argv lists run without a shell, from the worktree root; a command for a
// subdirectory says so in its own flags (npm --prefix, make -C, go -C, ...).

export type ChecksIO = {
  // The entries of a directory (absolute path); [] when it can't be listed.
  list(dir: string): Promise<{ name: string; isDir: boolean }[]>
  // A file's text; null when it can't be read.
  read(path: string): Promise<string | null>
}

export type DetectedChecks = {
  checks: string[][]
  // Detectors that failed, files that were malformed, caps that were hit: for the run's record.
  warnings: string[]
  // Why nothing ran ('' when something did): shown to the reviewers and the approver.
  reason: string
  // Where each command came from, by its text: option, file, detected or spec.
  sources: Record<string, string>
}

export const MAX_DEPTH = 3
export const MAX_DIRS = 60
export const MAX_ENTRIES = 300
export const MAX_READS = 60
export const MAX_SPEC_CHECKS = 8
export const MAX_CHECKS = 30

// Directories never scanned: dependencies, build output, the factory's own worktrees and records.
export const IGNORED_DIRS = new Set(['node_modules', '.git', '.factory', 'venv', '.venv', 'env', '__pycache__', 'dist', 'build', 'target', 'vendor', '.tox', '.mypy_cache', '.pytest_cache', '.next', 'coverage', '.idea', '.vscode'])

const PY_TEST_FILE = /^(test_.+|.+_test)\.py$/
const MAKEFILES = ['Makefile', 'makefile', 'GNUmakefile']
const READ_NAMES = ['package.json', 'pyproject.toml', 'setup.cfg', 'tox.ini', ...MAKEFILES]

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120)

// Commands from the `checks` option or a checks file: ";" or new lines between commands, no shell.
function splitCommands(option: string): string[][] {
  return option.split(/[;\n]/).map(c => c.trim()).filter(Boolean).map(c => c.split(/\s+/))
}

// ---------- one directory ----------

type DirInfo = { dir: string; names: string[]; texts: Record<string, string | null>; isRoot: boolean; pyTests: boolean }
type Detector = { name: string; run: (d: DirInfo) => string[][] }

const has = (d: DirInfo, n: string) => d.names.includes(n)

// A package.json "test" script that npm writes itself isn't a test.
const isPlaceholder = (s: string) => /no test specified/i.test(s)

function nodeChecks(d: DirInfo): string[][] {
  if (!has(d, 'package.json')) return []
  const text = d.texts['package.json']
  if (text === undefined) return []
  let scripts: Record<string, unknown> = {}
  if (text !== null) {
    const parsed = JSON.parse(text) as { scripts?: unknown }
    if (parsed && typeof parsed === 'object' && parsed.scripts && typeof parsed.scripts === 'object') scripts = parsed.scripts as Record<string, unknown>
  }
  // A subdirectory's dependencies aren't installed by the factory's setup: running it would only fail.
  if (!d.isRoot && !has(d, 'node_modules')) return []
  const npm = d.isRoot ? ['npm'] : ['npm', '--prefix', d.dir]
  const out: string[][] = []
  if (scripts.test && !(typeof scripts.test === 'string' && isPlaceholder(scripts.test))) out.push(d.isRoot ? ['npm', 'test'] : [...npm, 'test'])
  for (const s of ['lint', 'typecheck', 'build']) if (scripts[s]) out.push([...npm, 'run', s])
  return out
}

function pythonChecks(d: DirInfo): string[][] {
  const definite = has(d, 'pytest.ini') || has(d, 'conftest.py') || d.pyTests
  const configured = ['pyproject.toml', 'setup.cfg', 'tox.ini'].some(f => has(d, f) && (d.texts[f] == null || /pytest/i.test(d.texts[f]!)))
  if (!definite && !configured) return []
  return [d.isRoot ? ['python', '-m', 'pytest', '-q'] : ['python', '-m', 'pytest', '-q', d.dir]]
}

const goChecks = (d: DirInfo): string[][] => (has(d, 'go.mod') ? [d.isRoot ? ['go', 'test', './...'] : ['go', '-C', d.dir, 'test', './...']] : [])

const cargoChecks = (d: DirInfo): string[][] => (has(d, 'Cargo.toml') ? [d.isRoot ? ['cargo', 'test'] : ['cargo', 'test', '--manifest-path', `${d.dir}/Cargo.toml`]] : [])

function makeChecks(d: DirInfo): string[][] {
  for (const f of MAKEFILES) {
    if (!has(d, f)) continue
    const text = d.texts[f]
    if (!text) return []
    for (const target of ['test', 'check']) {
      if (new RegExp(`^${target}\\s*:(?!=)`, 'm').test(text)) return [d.isRoot ? ['make', target] : ['make', '-C', d.dir, target]]
    }
    return []
  }
  return []
}

function jvmChecks(d: DirInfo): string[][] {
  if (has(d, 'pom.xml')) return [d.isRoot ? ['mvn', '-q', 'test'] : ['mvn', '-q', '-f', `${d.dir}/pom.xml`, 'test']]
  if (has(d, 'build.gradle') || has(d, 'build.gradle.kts')) return [d.isRoot ? ['gradle', 'test'] : ['gradle', '-p', d.dir, 'test']]
  return []
}

function dotnetChecks(d: DirInfo): string[][] {
  if (!d.names.some(n => /\.(sln|csproj|fsproj)$/i.test(n))) return []
  return [d.isRoot ? ['dotnet', 'test'] : ['dotnet', 'test', d.dir]]
}

const DETECTORS: Detector[] = [
  { name: 'node', run: nodeChecks },
  { name: 'python', run: pythonChecks },
  { name: 'go', run: goChecks },
  { name: 'cargo', run: cargoChecks },
  { name: 'make', run: makeChecks },
  { name: 'jvm', run: jvmChecks },
  { name: 'dotnet', run: dotnetChecks },
]

// Every detector on one directory, each on its own: a failing one is a warning, not an exception.
function detectIn(d: DirInfo, warnings: string[]): { checks: string[][]; python: boolean } {
  const checks: string[][] = []
  let python = false
  for (const det of DETECTORS) {
    try {
      const got = det.run(d)
      if (det.name === 'python' && got.length) python = true
      checks.push(...got)
    } catch (e) {
      warnings.push(`${det.name} detector failed in ${d.dir || '.'}: ${msg(e)}`)
    }
  }
  return { checks, python }
}

// The old entry point, kept as it was: the root's file names and its package.json text. Never throws.
export function detectChecks(files: string[], packageJson: string | null): string[][] {
  try {
    const names = Array.isArray(files) ? files.filter(f => typeof f === 'string') : []
    const texts: Record<string, string | null> = {}
    if (packageJson !== null) texts['package.json'] = packageJson
    const d: DirInfo = { dir: '', names, texts, isRoot: true, pyTests: names.some(n => PY_TEST_FILE.test(n)) || names.includes('tests') }
    const warnings: string[] = []
    return detectIn(d, warnings).checks
  } catch {
    return []
  }
}

// ---------- the project's own checks file ----------

// .factory/checks.json: ["npm test", ["make","lint"], ...] or {"checks": [...]}. Anything else: no checks, a warning.
export function parseChecksFile(text: string, warnings: string[]): string[][] {
  try {
    const parsed = JSON.parse(text) as unknown
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as { checks?: unknown }).checks : undefined
    if (!Array.isArray(list)) {
      warnings.push('.factory/checks.json has no list of commands')
      return []
    }
    const out: string[][] = []
    for (const item of list.slice(0, 20)) {
      if (typeof item === 'string') out.push(...splitCommands(item))
      else if (Array.isArray(item) && item.length && item.every(x => typeof x === 'string' && x)) out.push(item as string[])
      else warnings.push('.factory/checks.json: an entry is neither a string nor a list of strings')
    }
    return out
  } catch (e) {
    warnings.push(`.factory/checks.json is not valid JSON: ${msg(e)}`)
    return []
  }
}

// ---------- commands in the spec's acceptance criteria ----------

const SAFE_TOKEN = /^[A-Za-z0-9_.\/:=@,+-]+$/
const SCRIPT = /^(test|lint|typecheck|check|validate|verify|build)[\w:-]*$/
const MAKE_TARGET = /^(test|tests|check|lint|validate|verify|ci|typecheck|build)$/

// Only runners that check something, with plain arguments: no shell syntax, no paths that leave the repo.
export function allowedCommand(argv: string[]): boolean {
  if (!argv.length || argv.length > 12) return false
  if (!argv.every(t => SAFE_TOKEN.test(t) && !/(^|\/)\.\.(\/|$)/.test(t) && !t.startsWith('/') && !/^[A-Za-z]:/.test(t))) return false
  const [a, b, c] = argv as [string, string?, string?]
  if (a === 'pytest') return true
  if ((a === 'python' || a === 'python3') && b === '-m' && c === 'pytest') return true
  if ((a === 'python' || a === 'python3') && b && /^tools\/[\w./-]+\.py$/.test(b) && argv.includes('--check')) return true
  if (['npm', 'pnpm', 'yarn'].includes(a)) return b === 'test' || (b === 'run' && !!c && SCRIPT.test(c))
  if (a === 'go' || a === 'cargo') return b === 'test'
  if (a === 'make') return !!b && MAKE_TARGET.test(b) && argv.length === 2
  if (a === 'claude') return b === 'plugin' && (c === 'test' || c === 'validate')
  return false
}

// The text of the acceptance criteria section, else the whole spec.
function criteriaOf(spec: string): string {
  const lines = spec.split('\n')
  const start = lines.findIndex(l => /^#{1,6}\s.*acceptance criteria/i.test(l))
  if (start < 0) return spec
  const level = /^#+/.exec(lines[start]!)![0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]!)
    if (m && m[1]!.length <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

// Fenced blocks (a command per line) and `inline code` in the criteria, kept when they pass the allowlist.
export function specChecks(spec: string): string[][] {
  const text = criteriaOf(spec)
  const candidates: string[] = []
  const unfenced = text.replace(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[^\n]*$/gm, (_all, _f, body: string) => {
    for (const line of body.split('\n')) candidates.push(line)
    return '\n'
  })
  for (const m of unfenced.matchAll(/`([^`\n]+)`/g)) candidates.push(m[1]!)
  const seen = new Set<string>()
  const out: string[][] = []
  for (const raw of candidates) {
    const cmd = raw.trim().replace(/^[$>]\s+/, '').trim()
    if (!cmd || /[;&|<>$`()\\"'*?!{}#]/.test(cmd)) continue
    const argv = cmd.split(/\s+/)
    if (!allowedCommand(argv) || seen.has(argv.join(' '))) continue
    seen.add(argv.join(' '))
    out.push(argv)
    if (out.length >= MAX_SPEC_CHECKS) break
  }
  return out
}

// ---------- the repository ----------

export type DetectOptions = {
  // The `checks` option: wins over everything else.
  explicit?: string
  // Files the change touched (git diff base..HEAD --name-only): their directories are scanned too.
  touched?: string[]
  // The spec's text, for the commands in its acceptance criteria.
  spec?: string | null
}

export const NOTHING_RAN = 'No checks were run: no test, lint or build command was found in the repository and the spec names no command that checks the change. Nothing was verified by running it.'

export async function detectProjectChecks(io: ChecksIO, root: string, opts: DetectOptions = {}): Promise<DetectedChecks> {
  const warnings: string[] = []
  const sources: Record<string, string> = {}
  const checks: string[][] = []
  const add = (list: string[][], source: string) => {
    for (const argv of list) {
      const key = argv.join(' ')
      if (checks.length >= MAX_CHECKS || key in sources) continue
      sources[key] = source
      checks.push(argv)
    }
  }
  const finish = (): DetectedChecks => ({ checks, warnings, sources, reason: checks.length ? '' : [NOTHING_RAN, ...warnings.map(w => `Warning: ${w}`)].join(' ') })
  try {
    const explicit = (opts.explicit ?? '').trim()
    if (explicit) {
      add(splitCommands(explicit), 'option')
      return finish()
    }
    const rootDir = norm(root)
    const abs = (dir: string) => (dir ? `${rootDir}/${dir}` : rootDir)
    let reads = 0
    const read = async (path: string) => {
      if (reads >= MAX_READS) return null
      reads++
      try {
        return await io.read(path)
      } catch {
        return null
      }
    }

    const detected: string[][] = []
    let rootHasFactory = false
    {
      // Which directories: the root, one level down, the touched ones; python tests are found deeper.
      const touchedDirs = new Set<string>()
      for (const f of opts.touched ?? []) {
        const parts = norm(f).split('/').slice(0, -1)
        for (let i = parts.length; i >= 1; i--) {
          const dir = parts.slice(0, i).join('/')
          if (parts.slice(0, i).some(p => IGNORED_DIRS.has(p) || p.startsWith('.'))) break
          touchedDirs.add(dir)
        }
      }
      const listings = new Map<string, { name: string; isDir: boolean }[]>()
      const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }]
      let capped = false
      while (queue.length) {
        const { dir, depth } = queue.shift()!
        if (listings.size >= MAX_DIRS) {
          capped = true
          break
        }
        let entries: { name: string; isDir: boolean }[] = []
        try {
          entries = (await io.list(abs(dir))).filter(e => e && typeof e.name === 'string')
        } catch (e) {
          warnings.push(`could not list ${dir || '.'}: ${msg(e)}`)
        }
        if (entries.length > MAX_ENTRIES) {
          capped = true
          entries = entries.slice(0, MAX_ENTRIES)
        }
        listings.set(dir, entries)
        if (depth >= MAX_DEPTH) continue
        for (const e of entries) {
          if (e.isDir && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push({ dir: join(dir, e.name), depth: depth + 1 })
        }
      }
      if (capped) warnings.push(`the scan stopped at its limits (${MAX_DIRS} directories, ${MAX_ENTRIES} entries each)`)
      // A touched directory deeper than the scan still gets looked at.
      for (const dir of touchedDirs) {
        if (listings.size >= MAX_DIRS || listings.has(dir)) continue
        try {
          listings.set(dir, (await io.list(abs(dir))).filter(e => e && typeof e.name === 'string').slice(0, MAX_ENTRIES))
        } catch {
          /* a touched directory that is gone */
        }
      }

      rootHasFactory = (listings.get('') ?? []).some(e => e.name === '.factory')
      const pythonTop = new Set<string>()
      let rootPython = false
      for (const [dir, entries] of listings) {
        const names = entries.map(e => e.name)
        const isRoot = dir === ''
        const depth = isRoot ? 0 : dir.split('/').length
        const pyTests = names.some(n => PY_TEST_FILE.test(n))
        const near = isRoot || depth === 1 || touchedDirs.has(dir)
        if (!near) {
          // Deeper than one level: only where python tests live, and then as their top directory.
          if (pyTests || names.includes('conftest.py')) pythonTop.add(dir.split('/')[0]!)
          continue
        }
        const texts: Record<string, string | null> = {}
        for (const n of READ_NAMES) if (names.includes(n)) texts[n] = await read(`${abs(dir)}/${n}`)
        // An unreadable package.json is a warning, and no checks from it.
        const info: DirInfo = { dir, names, texts, isRoot, pyTests: pyTests || (names.includes('tests') && entries.some(e => e.name === 'tests' && e.isDir)) }
        let got: { checks: string[][]; python: boolean }
        try {
          got = detectIn(info, warnings)
        } catch (e) {
          warnings.push(`detection failed in ${dir || '.'}: ${msg(e)}`)
          continue
        }
        if (isRoot && got.python) rootPython = true
        // The root's pytest already collects every subdirectory.
        detected.push(...got.checks.filter(c => !(c[0] === 'python' && !isRoot && rootPython)))
        if (got.python && !isRoot) pythonTop.add(dir.split('/')[0]!)
      }
      if (!rootPython) {
        for (const top of [...pythonTop].slice(0, 8)) {
          if (top) detected.push(['python', '-m', 'pytest', '-q', top])
        }
      }
    }

    // The project's own list wins over detection; it is read only when the root has a .factory folder.
    let listed: string[][] = []
    if (rootHasFactory) {
      const fileText = await read(`${abs('.factory')}/checks.json`)
      if (fileText !== null) listed = parseChecksFile(fileText, warnings)
    }
    if (listed.length) add(listed, 'file')
    else add(detected, 'detected')

    const spec = opts.spec
    if (typeof spec === 'string' && spec) {
      try {
        add(specChecks(spec).slice(0, MAX_SPEC_CHECKS), 'spec')
      } catch (e) {
        warnings.push(`the spec's commands could not be read: ${msg(e)}`)
      }
    }
  } catch (e) {
    warnings.push(`check detection failed: ${msg(e)}`)
  }
  return finish()
}
