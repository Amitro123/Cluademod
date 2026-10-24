import { test, expect } from 'claude-code/testing'

import { RLM, toRtl, wrapLineIfNeeded } from './rtl'

const HEBREW_LEADING = '## \u05DB\u05D5\u05EA\u05E8\u05EA' // "## <Hebrew word>"
const MIXED = 'Mixed \u05E2\u05D1\u05E8\u05D9\u05EA \u05DE\u05D0\u05D5\u05D3 \u05E9\u05DC\u05D5\u05DD text' // 3 Hebrew words vs 2 English
const PURE_ENGLISH = '* `code span`'
const HEBREW_LEADING_MULTI_ENGLISH =
  '\u05D9\u05E9 \u05DC\u05D4\u05E8\u05D9\u05E5 npm install \u05D5\u05D0\u05D6 \u05DC\u05D1\u05D3\u05D5\u05E7 \u05D1-GitHub Actions'
const ENGLISH_WITH_ONE_HEBREW = 'Use the flag --force, also known as \u05DB\u05E4\u05D9\u05D9\u05D4'
const PUNCTUATION_ONLY = '--- 12:34 --- 99%'
const ARABIC = 'Note: \u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 \u0647\u0630\u0627 \u0646\u0635'
const MIXED_MULTILINE = [HEBREW_LEADING, MIXED, PURE_ENGLISH].join('\n')
const TIE_QUOTE = '> PR חייב לעבור review לפני merge' // 3 RTL words vs 3 Latin
const TASK_ITEM = '- [ ] Review לקוד לפני merge' // 2 vs 2
const LINK_LINE = '[GitHub](https://github.com/Amitro123/RTL-claude-mod) הוא המקום שבו נמצא הקוד של הפרויקט'
const URL_LINE = 'Docs at https://example.com/a/b/c נמצאים כאן בתיקייה' // URL ignored: 3 RTL vs 2 Latin
const AUTOLINK_LINE = 'See <https://example.com/very/long> עברית כאן'
const REF_LINE = 'Read [docs][somelabel] ועוד כאן' // 2 vs 2 once the ref label is ignored
const ENGLISH_DOMINANT_1 = 'Run the full build and then the test suite, ואז deploy'
const ENGLISH_DOMINANT_2 = 'Use the flag --force, also known as כפייה, only when needed.'
const ENGLISH_DOMINANT_3 = 'Go see https://example.com/x עברית' // 2 Latin vs 1 RTL
const TIE_URL_ONE_EACH = 'See https://example.com/x/y/z/w עברית' // 1 vs 1
const GITHUB_ACTIONS = 'GitHub Actions צריך לרוץ על כל commit חדש' // 5 RTL vs 3 Latin
const MIXED_ONE_VS_TWO = 'Mixed עברית text'
const LABEL_OFF = '\u05E2\u05D1\u05E8\u05D9\u05EA: \u05DB\u05D1\u05D5\u05D9'
const LABEL_ON = '\u05E2\u05D1\u05E8\u05D9\u05EA: \u05E4\u05E2\u05D9\u05DC'

// --- pure functions -------------------------------------------------------

test('wrapLineIfNeeded: Hebrew-dominant English-leading line gets a leading RLM', () => {
  expect(wrapLineIfNeeded(MIXED)).toBe(`${RLM}${MIXED}`)
})

test('wrapLineIfNeeded: English-dominant line with one Hebrew word is untouched', () => {
  expect(wrapLineIfNeeded(ENGLISH_WITH_ONE_HEBREW)).toBe(ENGLISH_WITH_ONE_HEBREW)
})

test('wrapLineIfNeeded: word counting, ties go to RTL', () => {
  for (const [prefix, line] of [['> ', TIE_QUOTE], ['- [ ] ', TASK_ITEM], ['', GITHUB_ACTIONS], ['', TIE_URL_ONE_EACH]] as [string, string][]) {
    const body = line.slice(prefix.length)
    expect(wrapLineIfNeeded(line)).toBe(`${prefix}${RLM}${body}`)
  }
})

test('wrapLineIfNeeded: Latin-dominant lines are untouched', () => {
  for (const s of [ENGLISH_DOMINANT_1, ENGLISH_DOMINANT_2, ENGLISH_DOMINANT_3, MIXED_ONE_VS_TWO]) {
    expect(wrapLineIfNeeded(s)).toBe(s)
  }
})

test('wrapLineIfNeeded: link and URL text is ignored when counting, output text is unchanged', () => {
  for (const s of [LINK_LINE, URL_LINE, AUTOLINK_LINE, REF_LINE]) {
    expect(wrapLineIfNeeded(s)).toBe(`${RLM}${s}`)
  }
})

test('wrapLineIfNeeded: Hebrew-leading, pure English and punctuation lines are untouched', () => {
  for (const s of [HEBREW_LEADING, HEBREW_LEADING_MULTI_ENGLISH, PURE_ENGLISH, PUNCTUATION_ONLY, '', '   ']) {
    expect(wrapLineIfNeeded(s)).toBe(s)
  }
})

test('wrapLineIfNeeded: Arabic line is wrapped', () => {
  expect(wrapLineIfNeeded(ARABIC)).toBe(`${RLM}${ARABIC}`)
})

test('wrapLineIfNeeded: Arabic presentation forms count as RTL', () => {
  const s = 'Note: \uFE8D\uFE8E\uFE8D\uFE8E\uFE8D\uFE8E'
  expect(wrapLineIfNeeded(s)).toBe(`${RLM}${s}`)
})

test('wrapLineIfNeeded: already-marked line (RLM or legacy RLI/RLE) is not marked twice', () => {
  const once = wrapLineIfNeeded(MIXED)
  expect(wrapLineIfNeeded(once)).toBe(once)
  for (const legacy of [`\u202B${MIXED}\u202C`, `\u2067${MIXED}\u2069`]) {
    expect(wrapLineIfNeeded(legacy)).toBe(legacy)
  }
  expect(wrapLineIfNeeded(`- ${once}`)).toBe(`- ${once}`)
})

test('wrapLineIfNeeded: markdown prefixes stay at column 0', () => {
  for (const prefix of ['- ', '* ', '+ ', '1. ', '12) ', '# ', '### ', '> ', '> > ', '  - ', '- [x] ', '1. ']) {
    expect(wrapLineIfNeeded(prefix + MIXED)).toBe(`${prefix}${RLM}${MIXED}`)
  }
})

test('wrapLineIfNeeded: table rows and indented code are left untouched', () => {
  for (const s of [`| ${MIXED} | b |`, `  | ${MIXED} |`, `    ${MIXED}`, `\t${MIXED}`]) {
    expect(wrapLineIfNeeded(s)).toBe(s)
  }
})

test('wrapLineIfNeeded: nested (4-space) list item is still wrapped after its prefix', () => {
  expect(wrapLineIfNeeded(`    - ${MIXED}`)).toBe(`    - ${RLM}${MIXED}`)
})

test('toRtl: fenced code blocks and fence lines are untouched', () => {
  for (const f of ['```', '~~~', '````']) {
    const text = [MIXED, `${f}ts`, MIXED, f, MIXED].join('\n')
    const lines = toRtl(text).split('\n')
    expect(lines[0]).toBe(`${RLM}${MIXED}`)
    expect(lines.slice(1, 4)).toEqual([`${f}ts`, MIXED, f])
    expect(lines[4]).toBe(`${RLM}${MIXED}`)
  }
})

test('toRtl: a shorter or different fence does not close a block', () => {
  const text = ['````', '```', MIXED, '~~~~', MIXED, '````', MIXED].join('\n')
  const lines = toRtl(text).split('\n')
  expect(lines.slice(0, 6)).toEqual(['````', '```', MIXED, '~~~~', MIXED, '````'])
  expect(lines[6]).toBe(`${RLM}${MIXED}`)
})

test('toRtl: CRLF endings are preserved', () => {
  expect(toRtl(`${MIXED}\r\nplain\r\n`)).toBe(`${RLM}${MIXED}\r\nplain\r\n`)
})

test('wrapLineIfNeeded: the mark is the first strong char of the content (RTL) for each block kind', () => {
  const isRtlStrong = (ch: string) => { const c = ch.codePointAt(0)!; return ch === RLM || (c >= 0x590 && c <= 0x8ff) || (c >= 0xfb1d && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff) }
  const firstStrong = (s: string) => [...s].find(ch => /[A-Za-z]/.test(ch) || isRtlStrong(ch))
  for (const prefix of ['## ', '- ', '> ', '']) {
    const out = wrapLineIfNeeded(prefix + MIXED)
    const content = out.slice(prefix.length)
    expect(out.startsWith(prefix)).toBe(true)
    expect(content.startsWith(RLM)).toBe(true)
    expect(isRtlStrong(content.charAt(0))).toBe(true)
    expect(firstStrong(content)).toBe(RLM)
    expect(content.endsWith(String.fromCodePoint(0x2069))).toBe(false)
  }
})

// --- live-verified regression cases (desktop app) -------------------------

const RLM_C = String.fromCodePoint(0x200f)
const mark = (prefix: string, body: string) => `${prefix}${RLM_C}${body}`
const L_NUM1 = '1. Docker צריך להיות מותקן'
const L_NUM2 = '2. Node בגרסה 20 לפחות'
const L_NEST = ['- Setup ראשוני של הסביבה', '  - Docker צריך להיות מותקן', '  - Node בגרסה 20'].join('\n')
const L_CODE = '`npm install` צריך לרוץ לפני כל בדיקה חדשה'
const L_BOLD = '**Docker** צריך להיות מותקן ומוגדר מראש לפני שמתחילים'
const L_NUM_HE = '3 קבצים השתנו ב-PR הזה'
const L_QUOTE_HE = '> **הערה:** PR חייב לעבור review לפני merge'
const L_QUOTE_2 = ['> שורה ראשונה בעברית', '> Docker צריך להיות מותקן לפני ההרצה'].join('\n')
const L_PARA = ['This paragraph starts in English', 'GitHub Actions צריך לרוץ על כל commit חדש'].join('\n')
const L_TABLE = ['| Step | תיאור |', '|---|---|', '| Build | בניית הפרויקט |'].join('\n')
const L_ARABIC = 'Deploy يجب أن يتم بعد اختبار كل التغييرات'
const L_PLAIN = 'Plain English line with `code` and **bold**.'
const L_FENCE = (f: string) => [`${f}bash`, '# Run שלב ההתקנה הראשוני', 'npm install', f].join('\n')
const L_HE_LIST = ['- פריט ראשון בעברית', '- Pure English bullet, untouched', '- פריט שלישי בעברית'].join('\n')

test('live: numbered list items are marked after "N. "', () => {
  expect(toRtl([L_NUM1, L_NUM2].join('\n'))).toBe([mark('1. ', L_NUM1.slice(3)), mark('2. ', L_NUM2.slice(3))].join('\n'))
})

test('live: nested bullets keep indent and are marked after their prefix', () => {
  const [a, b, c] = L_NEST.split('\n') as [string, string, string]
  expect(toRtl(L_NEST)).toBe([mark('- ', a.slice(2)), mark('  - ', b.slice(4)), mark('  - ', c.slice(4))].join('\n'))
})

test('live: leading code span is marked at index 0 and stays intact', () => {
  expect(toRtl(L_CODE)).toBe(mark('', L_CODE))
  expect(toRtl(L_CODE).includes('`npm install`')).toBe(true)
})

test('live: leading bold is marked at index 0', () => {
  expect(toRtl(L_BOLD)).toBe(mark('', L_BOLD))
})

test('live: Hebrew-leading lines are untouched (digit first, bold Hebrew in quote)', () => {
  expect(toRtl(L_NUM_HE)).toBe(L_NUM_HE)
  expect(toRtl(L_QUOTE_HE)).toBe(L_QUOTE_HE)
})

test('live: blockquote with Hebrew first line and Latin-leading second line', () => {
  const [a, b] = L_QUOTE_2.split('\n') as [string, string]
  expect(toRtl(L_QUOTE_2)).toBe([a, mark('> ', b.slice(2))].join('\n'))
})

test('live: English paragraph line stays, following mixed line is marked', () => {
  const [a, b] = L_PARA.split('\n') as [string, string]
  expect(toRtl(L_PARA)).toBe([a, mark('', b)].join('\n'))
})

test('live: whole table is untouched', () => {
  expect(toRtl(L_TABLE)).toBe(L_TABLE)
})

test('live: Latin-leading Arabic line is marked', () => {
  expect(toRtl(L_ARABIC)).toBe(mark('', L_ARABIC))
})

test('live: plain English line with code and bold is untouched', () => {
  expect(toRtl(L_PLAIN)).toBe(L_PLAIN)
})

test('live: Hebrew comment inside ``` and ~~~ fences is untouched', () => {
  for (const f of ['```', '~~~']) expect(toRtl(L_FENCE(f))).toBe(L_FENCE(f))
})

test('live: pure English bullet inside a Hebrew list is untouched', () => {
  expect(toRtl(L_HE_LIST)).toBe(L_HE_LIST)
})

test('idempotence: toRtl(toRtl(x)) === toRtl(x) for a mixed multi-line sample', () => {
  const sample = [L_NUM1, L_NUM2, L_NEST, L_CODE, L_QUOTE_2, L_PARA, L_TABLE, L_ARABIC, L_FENCE('```'), L_PLAIN, L_HE_LIST].join('\n')
  const once = toRtl(sample)
  expect(once).not.toBe(sample)
  expect(toRtl(once)).toBe(once)
})

// --- known limitations: pin CURRENT behaviour; changing these must be deliberate ---

test('known limitation: apostrophe and digits split words ("don\'t" = 2 words, "v2" = "v")', () => {
  // Latin words are runs of letters only, so "don't" counts as "don"+"t" and "v2" as "v".
  // "don't v2 ואז בדיקה": intended 2 Latin vs 2 RTL (tie -> marked), actual 3 vs 2 -> untouched.
  const s = "don't v2 ואז בדיקה"
  expect(toRtl(s)).toBe(s)
  // Where the split does not change the outcome the line is still marked.
  const t = "Run don't v2 ואז בדיקה של המערכת כולה"
  expect(toRtl(t)).toBe(mark('', t))
})

test('link target with one level of parentheses is ignored whole', () => {
  const a = '[docs](https://x.com/a_(b)) הוא המקום'
  expect(toRtl(a)).toBe(mark('', a))
  // "cc" after the inner ")" is still part of the target: docs vs הוא = 1 vs 1 -> marked.
  const b = '[docs](https://x.com/a_(bb)cc) הוא'
  expect(toRtl(b)).toBe(mark('', b))
})

// --- other LTR scripts ----------------------------------------------------

test('Cyrillic words count as LTR, not as nothing', () => {
  // Was: Latin-leading, Russian ignored -> 1 vs 1 -> wrongly marked.
  const ruDominant = 'Deploy это нужно сделать сегодня כן'
  expect(wrapLineIfNeeded(ruDominant)).toBe(ruDominant)
  // Was: first strong char searched among Latin/RTL only -> Hebrew -> wrongly untouched.
  const ruLeading = 'Запусти את כל הבדיקות לפני merge'
  expect(wrapLineIfNeeded(ruLeading)).toBe(`${RLM}${ruLeading}`)
  const ruOnly = 'Привет, мир'
  expect(wrapLineIfNeeded(ruOnly)).toBe(ruOnly)
})

test('Greek and accented Latin are LTR; combining marks do not split a word', () => {
  const greek = 'Γεια σου κόσμε שלום'
  expect(wrapLineIfNeeded(greek)).toBe(greek)
  const nfd = 'Cafe\u0301 עם חלב' // "Café" decomposed: still one word -> 2 RTL vs 1 LTR
  expect(wrapLineIfNeeded(nfd)).toBe(`${RLM}${nfd}`)
})

test('other RTL scripts (Syriac, Thaana, NKo, Adlam) count as RTL', () => {
  for (const w of ['\u0710\u0712\u0713', '\u0780\u0781\u0782', '\u07CA\u07CB\u07CC', '\u{1E900}\u{1E901}']) {
    const s = `Note ${w} ${w}`
    expect(wrapLineIfNeeded(s)).toBe(`${RLM}${s}`)
  }
})

test('real model output: Russian/English lines with a Hebrew word stay LTR, Hebrew-dominant ones are marked', () => {
  // Lines from real Claude answers; the previous version marked all of the first four.
  for (const s of [
    'Deploy это нужно сделать сегодня כן',
    'Fix ошибку в коде לפני ה-release, בבקשה',
    'Thanks, תודה за вопрос!',
    '- Откройте `http://localhost:8080` в браузере. Если открылась страница nginx, значит всё работает. Это ваша בדיקה.',
  ]) expect(toRtl(s)).toBe(s)
  const meeting = 'Meeting в три часа, נדבר על התקציב החדש' // 4 vs 4: tie goes to RTL
  expect(toRtl(meeting)).toBe(`${RLM}${meeting}`)
  const quoted = ['> ```go', '>     fmt.Println("שלום, עולם")', '> ```'].join('\n')
  expect(toRtl(quoted)).toBe(quoted)
})

// --- tables ---------------------------------------------------------------

const cells = { tableCells: true }

test('tables: only qualifying cells are marked, after their leading whitespace', () => {
  // From a real answer: Hebrew-dominant cell that starts with an English word.
  const row = '| קונקרנטיות | threads ו-asyncio; ה-GIL מגביל הרצה מקבילית של קוד Python | goroutines וערוצים (channels) מובנים |'
  expect(wrapLineIfNeeded(row, cells)).toBe(
    `| קונקרנטיות | ${RLM}threads ו-asyncio; ה-GIL מגביל הרצה מקבילית של קוד Python | ${RLM}goroutines וערוצים (channels) מובנים |`,
  )
  const plain = '| Garbage collection | Garbage collection | ניהול זיכרון |'
  expect(wrapLineIfNeeded(plain, cells)).toBe(plain)
})

test('tables: rows without outer pipes, escaped pipes and code spans', () => {
  expect(wrapLineIfNeeded(`| x | ${MIXED}`, cells)).toBe(`| x | ${RLM}${MIXED}`)
  // `\|` is a literal pipe inside the cell, so the cell is one cell (2 RTL vs 1 LTR).
  const esc = '| a\\|b עם עוד | y |'
  expect(wrapLineIfNeeded(esc, cells)).toBe('| a\\|b עם עוד | y |'.replace('| a', `| ${RLM}a`))
  // A code span does not count as LTR words inside a cell either.
  const code = '| `npm ci --save` מתקין תלויות | z |'
  expect(wrapLineIfNeeded(code, cells)).toBe(code.replace('| `', `| ${RLM}\``))
})

test('tables: idempotent, untouched by default and inside fences; header/delimiter rows keep structure', () => {
  const table = ['| Step | תיאור |', '|:---|---:|', `| ${MIXED} | ${MIXED} |`].join('\n')
  const once = toRtl(table, cells)
  expect(once.split('\n')).toEqual(['| Step | תיאור |', '|:---|---:|', `| ${RLM}${MIXED} | ${RLM}${MIXED} |`])
  expect(toRtl(once, cells)).toBe(once)
  expect(toRtl(table)).toBe(table)
  const fenced = ['```', `| ${MIXED} |`, '```'].join('\n')
  expect(toRtl(fenced, cells)).toBe(fenced)
})

// --- code -----------------------------------------------------------------

test('inline code spans are not counted as LTR words', () => {
  // Without the span: 3 LTR vs 2 RTL. With it ignored: 1 vs 2 -> marked.
  const s = 'Run `npm install --save` ואז בדוק'
  expect(wrapLineIfNeeded(s)).toBe(`${RLM}${s}`)
  const dbl = 'Run ``a ` b c d`` ואז בדוק'
  expect(wrapLineIfNeeded(dbl)).toBe(`${RLM}${dbl}`)
  // An unclosed backtick is literal text, so its words still count.
  const open = 'Run `npm install --save ואז בדוק'
  expect(wrapLineIfNeeded(open)).toBe(open)
})

test('fenced code inside blockquotes and list items is untouched', () => {
  for (const [o, c] of [['> ```', '> ```'], ['- ```ts', '  ```'], ['> > ~~~', '> > ~~~']]) {
    const text = [o, `> ${MIXED}`, c, MIXED].join('\n')
    expect(toRtl(text)).toBe([o, `> ${MIXED}`, c, `${RLM}${MIXED}`].join('\n'))
  }
})

// --- performance ----------------------------------------------------------

test('pathological lines are linear, not quadratic', () => {
  const lines = ['a א ' + '](x'.repeat(30000), ' '.repeat(30000) + 'x א', 'a א ' + '<a://'.repeat(20000), 'a א ' + '`'.repeat(1) + ' x`` '.repeat(10000)]
  for (const line of lines) {
    const t = Date.now()
    wrapLineIfNeeded(line)
    expect(Date.now() - t).toBeLessThan(200)
  }
})

test('streaming: converting chunk by chunk equals converting each prefix from scratch', () => {
  const full = [L_NUM1, '```', MIXED, '```', L_QUOTE_2, '> ```', MIXED, '> ```', L_PARA, MIXED].join('\n')
  const reset = (i: number) => toRtl(`reset ${i} א\n`) // unrelated text: the next call cannot reuse a prefix
  // A trailing "\n" does not change any line's result but gives a distinct cache key.
  const fresh = Array.from({ length: full.length }, (_, i) => (reset(i), toRtl(full.slice(0, i + 1) + '\n').slice(0, -1)))
  reset(-1)
  for (let i = 0; i < full.length; i++) expect(toRtl(full.slice(0, i + 1))).toBe(fresh[i])
  expect(fresh[full.length - 1]).toContain(`${RLM}${MIXED}`)
})

test('streaming a large message stays fast per chunk', () => {
  const full = ('Mixed עברית מאוד שלום text with `code` ועוד\n').repeat(20000)
  toRtl(full.slice(0, full.length - 100))
  const t = Date.now()
  for (let i = 99; i > 0; i -= 9) toRtl(full.slice(0, full.length - i))
  expect(Date.now() - t).toBeLessThan(100)
})

// --- through the engine ---------------------------------------------------

for (const surface of ['terminal', 'desktop'] as const) {
  // Hooks beneath the plugin: the test stands in for the engine's own drawing. Call before using `$`.
  function setup(on: any) {
    for (const c of ['UserMessage', 'AssistantMessage'] as const) {
      on('ui.render', { component: c }, async ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.text }))
    }
    on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any) =>
      $.ui.resolve(e).Text({ children: 'engine band' }),
    )
  }

  // Press the band's toggle button once.
  async function enable($: any) {
    const band = await $.ui.mount({ plugin: 'rtl-toggle', surface, component: 'AbovePrompt', props: {} } as never)
    await band.press({ key: 'rtl-toggle' })
    await band.unmount()
  }

  // Mount `component` with `text` and return the drawn text.
  async function render($: any, component: 'UserMessage' | 'AssistantMessage', text: string) {
    const mounted = await $.ui.mount({
      plugin: 'rtl-toggle',
      surface,
      component,
      props: { text, origin: { kind: 'prompt' }, isExpanded: true },
    })
    return (await mounted.find({ type: 'Text' }))?.text
  }

  // Enabled toggle, then render.
  async function renderEnabled(on: any, $: any, component: 'UserMessage' | 'AssistantMessage', text: string) {
    setup(on)
    await enable($)
    return render($, component, text)
  }

  test(`UserMessage: Hebrew-dominant English-leading line gets wrapped (${surface})`, async ($, on) => {
    expect(await renderEnabled(on, $, 'UserMessage', MIXED)).toBe(`${RLM}${MIXED}`)
  })

  test(`AssistantMessage wraps when enabled (${surface})`, async ($, on) => {
    expect(await renderEnabled(on, $, 'AssistantMessage', MIXED)).toBe(`${RLM}${MIXED}`)
  })

  test(`Mixed multi-line message only wraps the lines that need it (${surface})`, async ($, on) => {
    const lines = (await renderEnabled(on, $, 'UserMessage', MIXED_MULTILINE))?.split('\n')
    expect(lines).toEqual([HEBREW_LEADING, `${RLM}${MIXED}`, PURE_ENGLISH])
  })

  test(`List item, heading and blockquote prefixes stay at column 0 (${surface})`, async ($, on) => {
    const text = [`- ${MIXED}`, `# ${MIXED}`, `> ${MIXED}`].join('\n')
    const lines = (await renderEnabled(on, $, 'AssistantMessage', text))?.split('\n')
    expect(lines).toEqual([`- ${RLM}${MIXED}`, `# ${RLM}${MIXED}`, `> ${RLM}${MIXED}`])
  })

  test(`Fenced code block content is untouched (${surface})`, async ($, on) => {
    const text = ['```', MIXED, '```'].join('\n')
    expect(await renderEnabled(on, $, 'AssistantMessage', text)).toBe(text)
  })

  test(`English-dominant sentence with one Hebrew word is untouched (${surface})`, async ($, on) => {
    expect(await renderEnabled(on, $, 'AssistantMessage', ENGLISH_WITH_ONE_HEBREW)).toBe(ENGLISH_WITH_ONE_HEBREW)
  })

  test(`Word-count cases are marked or left alone through the engine (${surface})`, async ($, on) => {
    setup(on)
    await enable($)
    for (const [prefix, line] of [['> ', TIE_QUOTE], ['- [ ] ', TASK_ITEM], ['', LINK_LINE], ['', URL_LINE]] as [string, string][]) {
      expect(await render($, 'AssistantMessage', line)).toBe(`${prefix}${RLM}${line.slice(prefix.length)}`)
    }
    for (const s of [ENGLISH_DOMINANT_1, ENGLISH_DOMINANT_2, MIXED_ONE_VS_TWO]) {
      expect(await render($, 'AssistantMessage', s)).toBe(s)
    }
  })

  test(`Arabic line is wrapped (${surface})`, async ($, on) => {
    expect(await renderEnabled(on, $, 'AssistantMessage', ARABIC)).toBe(`${RLM}${ARABIC}`)
  })

  test(`Already-wrapped line is not double-wrapped (${surface})`, async ($, on) => {
    const wrapped = `${RLM}${MIXED}`
    expect(await renderEnabled(on, $, 'AssistantMessage', wrapped)).toBe(wrapped)
  })

  test(`CRLF line keeps its carriage return (${surface})`, async ($, on) => {
    expect(await renderEnabled(on, $, 'AssistantMessage', `${MIXED}\r\nx`)).toBe(`${RLM}${MIXED}\r\nx`)
  })

  test(`Table cells are marked except in the terminal (${surface})`, async ($, on) => {
    const row = `| ${MIXED} | x |`
    const want = surface === 'terminal' ? row : `| ${RLM}${MIXED} | x |`
    expect(await renderEnabled(on, $, 'AssistantMessage', row)).toBe(want)
  })

  test(`Hebrew-leading, pure-English, punctuation, empty and blank lines are untouched (${surface})`, async ($, on) => {
    setup(on)
    await enable($)
    for (const s of [HEBREW_LEADING, HEBREW_LEADING_MULTI_ENGLISH, PURE_ENGLISH, PUNCTUATION_ONLY, '', '   ']) {
      expect(await render($, 'UserMessage', s)).toBe(s)
    }
  })

  test(`Text is unchanged while disabled (${surface})`, async ($, on) => {
    setup(on)
    for (const component of ['UserMessage', 'AssistantMessage'] as const) {
      expect(await render($, component, MIXED_MULTILINE)).toBe(MIXED_MULTILINE)
    }
  })

  test(`AbovePrompt composes with the band beneath and its label reflects state (${surface})`, async ($, on) => {
    setup(on)
    const band = await $.ui.mount({ plugin: 'rtl-toggle', surface, component: 'AbovePrompt', props: {} } as never)
    expect((await band.find({ type: 'Text' }))?.text).toBe('engine band')
    expect((await band.find({ key: 'rtl-toggle' }))?.text).toBe(LABEL_OFF)
    await band.press({ key: 'rtl-toggle' })
    expect((await band.find({ key: 'rtl-toggle' }))?.text).toBe(LABEL_ON)
    await band.unmount()
  })

  test(`Toggling ON then OFF restores the original AssistantMessage text (${surface})`, async ($, on) => {
    setup(on)
    const original = [L_NUM1, L_QUOTE_2, L_CODE, L_TABLE].join('\n')
    expect(await render($, 'AssistantMessage', original)).toBe(original)
    await enable($)
    const marked = await render($, 'AssistantMessage', original)
    expect(marked).toBe(toRtl(original))
    expect(marked).not.toBe(original)
    await enable($) // second press turns it off
    expect(await render($, 'AssistantMessage', original)).toBe(original)
  })

  test(`/rtl toggles, sets and reports the same state as the button (${surface})`, async ($, on) => {
    setup(on)
    const run = async (args: string) => (await ($ as any).command.run({ command: 'rtl', args })).text
    expect(await run('status')).toContain('off')
    expect(await run('')).toContain('on')
    expect(await render($, 'AssistantMessage', MIXED)).toBe(`${RLM}${MIXED}`)
    expect(await run('on')).toContain('on')
    expect(await run('off')).toContain('off')
    expect(await render($, 'AssistantMessage', MIXED)).toBe(MIXED)
    expect(await run('bogus')).toContain('Usage')
    const band = await $.ui.mount({ plugin: 'rtl-toggle', surface, component: 'AbovePrompt', props: {} as any })
    await run('on')
    expect((await band.find({ key: 'rtl-toggle' }))?.text).toBe(LABEL_ON)
    await band.unmount()
  })

  test(`Live-verified list, quote, code-span and table cases through the engine (${surface})`, async ($, on) => {
    setup(on)
    await enable($)
    const [a, b] = L_QUOTE_2.split('\n') as [string, string]
    expect(await render($, 'AssistantMessage', [L_NUM1, L_NUM2].join('\n'))).toBe([mark('1. ', L_NUM1.slice(3)), mark('2. ', L_NUM2.slice(3))].join('\n'))
    expect(await render($, 'AssistantMessage', L_QUOTE_2)).toBe([a, mark('> ', b.slice(2))].join('\n'))
    expect(await render($, 'AssistantMessage', L_CODE)).toBe(mark('', L_CODE))
    expect(await render($, 'AssistantMessage', L_TABLE)).toBe(L_TABLE)
    expect(await render($, 'AssistantMessage', L_FENCE('~~~'))).toBe(L_FENCE('~~~'))
  })
}
