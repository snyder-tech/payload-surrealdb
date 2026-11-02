// Judges one Vitest JSON report from Payload's int suites against the conformance lists.
// Usage: node evaluate.mjs <results.json> <payload-checkout-dir> [expected-failures.json] [skip-list.json]
// Exits 1 on:
//   - a failed test that is not in expected-failures.json,
//   - an expected failure that did not fail (it passes now, or is gone: the list only shrinks),
//   - a skip-listed test that ran,
//   - a test file that crashed before running any test,
//   - a report with no passing test (the run did not really happen).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = path.join(HERE, '../../tests/conformance')

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const key = (file, test) => `${file} :: ${test}`
const firstLine = (messages) => (messages[0] ?? '').split('\n')[0].slice(0, 300)

export function evaluate({ results, root, expected, skipped }) {
  const expectedByKey = new Map(expected.map((e) => [key(e.file, e.test), e]))
  const statusByKey = new Map()
  const filesWithTests = new Set()
  const problems = []
  let passed = 0
  let failed = 0

  for (const file of results.testResults) {
    const rel = path.relative(root, file.name).split(path.sep).join('/')

    if (file.status === 'failed' && file.assertionResults.length === 0) {
      problems.push(`FILE ERROR ${rel}: ${(file.message ?? '').split('\n')[0]}`)
    }
    if (file.assertionResults.length > 0) {
      filesWithTests.add(rel)
    }

    for (const assertion of file.assertionResults) {
      const k = key(rel, assertion.fullName)
      statusByKey.set(k, assertion.status)

      if (assertion.status === 'passed') {
        passed++
      } else if (assertion.status === 'failed') {
        failed++
        if (!expectedByKey.has(k)) {
          problems.push(`UNEXPECTED FAIL ${k}\n    ${firstLine(assertion.failureMessages ?? [])}`)
        }
      }

      if (assertion.status === 'passed' || assertion.status === 'failed') {
        const entry = skipped.find((s) => assertion.fullName.includes(s.test))
        if (entry) {
          problems.push(`SKIP-LISTED TEST RAN (${entry.test}) ${k}`)
        }
      }
    }
  }

  // Only entries whose file is in this report count: each CI group runs a slice of the suites.
  for (const entry of expected) {
    if (!filesWithTests.has(entry.file)) continue
    const k = key(entry.file, entry.test)
    const status = statusByKey.get(k)
    if (status === 'passed') {
      problems.push(`UNEXPECTED PASS (remove from expected-failures.json) ${k}`)
    } else if (status !== 'failed') {
      problems.push(
        `STALE EXPECTED FAILURE (${status ?? 'not found'}; remove or rename in expected-failures.json) ${k}`,
      )
    }
  }

  if (passed === 0) {
    problems.push('NO PASSING TESTS: the report is empty or every test failed')
  }

  return { failed, passed, problems }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const [resultsPath, rootArg, expectedPath, skipPath] = process.argv.slice(2)
  if (!resultsPath || !rootArg) {
    console.error(
      'Usage: node evaluate.mjs <results.json> <payload-checkout-dir> [expected-failures.json] [skip-list.json]',
    )
    process.exit(2)
  }
  const expected = readJson(expectedPath ?? path.join(TESTS_DIR, 'expected-failures.json'))
  const { failed, passed, problems } = evaluate({
    results: readJson(resultsPath),
    root: path.resolve(rootArg),
    expected,
    skipped: readJson(skipPath ?? path.join(TESTS_DIR, 'skip-list.json')),
  })

  console.log(`passed=${passed} failed=${failed} expected-failures=${expected.length}`)
  for (const problem of problems) console.log(problem)
  process.exit(problems.length > 0 ? 1 : 0)
}
