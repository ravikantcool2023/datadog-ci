import {exec} from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import process from 'process'
import {promisify} from 'util'

import chalk from 'chalk'
import deepExtend from 'deep-extend'
import glob from 'glob'

import {getCommonAppBaseURL} from '../../../helpers/app'
import {getCIMetadata} from '../../../helpers/ci'
import {GIT_COMMIT_MESSAGE} from '../../../helpers/tags'
import {pick} from '../../../helpers/utils'

import {APIHelper, EndpointError, formatBackendErrors, getApiHelper, isNotFoundError} from '../api'
import {CiError, CriticalError} from '../errors'
import {
  APIHelperConfig,
  Batch,
  BrowserServerResult,
  ExecutionRule,
  LocationsMapping,
  MainReporter,
  Operator,
  Payload,
  PollResultMap,
  Reporter,
  Result,
  ResultDisplayInfo,
  ResultInBatch,
  ResultSkippedBySelectiveRerun,
  RunTestsCommandConfig,
  ServerResult,
  Suite,
  Summary,
  SyntheticsCIConfig,
  SyntheticsOrgSettings,
  Test,
  TestPayload,
  Trigger,
  TriggerConfig,
  UserConfigOverride,
} from '../interfaces'
import {uploadApplicationAndOverrideConfig} from '../mobile'
import {MAX_TESTS_TO_TRIGGER} from '../run-tests-command'
import {Tunnel} from '../tunnel'

import {
  getOverriddenExecutionRule,
  getResultIdOrLinkedResultId,
  hasResult,
  isResultInBatchSkippedBySelectiveRerun,
} from './internal'

const POLLING_INTERVAL = 5000 // In ms
const PUBLIC_ID_REGEX = /^[\d\w]{3}-[\d\w]{3}-[\d\w]{3}$/
const TEMPLATE_REGEX = /{{\s*([^{}]*?)\s*}}/g

export const readableOperation: {[key in Operator]: string} = {
  [Operator.contains]: 'should contain',
  [Operator.doesNotContain]: 'should not contain',
  [Operator.is]: 'should be',
  [Operator.isNot]: 'should not be',
  [Operator.lessThan]: 'should be less than',
  [Operator.matches]: 'should match',
  [Operator.doesNotMatch]: 'should not match',
  [Operator.isInLessThan]: 'will expire in less than',
  [Operator.isInMoreThan]: 'will expire in more than',
  [Operator.lessThanOrEqual]: 'should be less than or equal to',
  [Operator.moreThan]: 'should be more than',
  [Operator.moreThanOrEqual]: 'should be less than or equal to',
  [Operator.validatesJSONPath]: 'assert on JSONPath extracted value',
  [Operator.validatesXPath]: 'assert on XPath extracted value',
}

const template = (st: string, context: any): string =>
  st.replace(TEMPLATE_REGEX, (match: string, p1: string) => (p1 in context ? context[p1] : match))

export let ciTriggerApp = process.env.DATADOG_SYNTHETICS_CI_TRIGGER_APP || 'npm_package'

export const getOverriddenConfig = (
  test: Test,
  publicId: string,
  reporter: MainReporter,
  config?: UserConfigOverride
): TestPayload => {
  let overriddenConfig: TestPayload = {
    public_id: publicId,
  }

  if (!config || !Object.keys(config).length) {
    return overriddenConfig
  }

  const executionRule = getOverriddenExecutionRule(test, config)
  if (executionRule) {
    overriddenConfig.executionRule = executionRule
  }

  overriddenConfig = {
    ...overriddenConfig,
    ...pick(config, [
      'allowInsecureCertificates',
      'basicAuth',
      'body',
      'bodyType',
      'cookies',
      'defaultStepTimeout',
      'deviceIds',
      'followRedirects',
      'headers',
      'locations',
      'pollingTimeout',
      'resourceUrlSubstitutionRegexes',
      'retry',
      'startUrlSubstitutionRegex',
      'testTimeout',
      'tunnel',
      'variables',
    ]),
  }

  if ((test.type === 'browser' || test.subtype === 'http') && config.startUrl) {
    overriddenConfig.startUrl = template(config.startUrl, {...process.env})
  }

  return overriddenConfig
}

export const setCiTriggerApp = (source: string): void => {
  ciTriggerApp = source
}

export const getExecutionRule = (test?: Test, configOverride?: UserConfigOverride): ExecutionRule => {
  if (configOverride && configOverride.executionRule) {
    return getStrictestExecutionRule(configOverride.executionRule, test?.options?.ci?.executionRule)
  }

  return test?.options?.ci?.executionRule || ExecutionRule.BLOCKING
}

export const getStrictestExecutionRule = (configRule: ExecutionRule, testRule?: ExecutionRule): ExecutionRule => {
  if (configRule === ExecutionRule.SKIPPED || testRule === ExecutionRule.SKIPPED) {
    return ExecutionRule.SKIPPED
  }

  if (configRule === ExecutionRule.NON_BLOCKING || testRule === ExecutionRule.NON_BLOCKING) {
    return ExecutionRule.NON_BLOCKING
  }

  if (configRule === ExecutionRule.BLOCKING || testRule === ExecutionRule.BLOCKING) {
    return ExecutionRule.BLOCKING
  }

  return ExecutionRule.BLOCKING
}

export const isTestSupportedByTunnel = (test: Test) => {
  return (
    test.type === 'browser' ||
    test.subtype === 'http' ||
    (test.subtype === 'multi' && test.config.steps?.every((step) => step.subtype === 'http'))
  )
}

export const hasResultPassed = (
  serverResult: ServerResult,
  hasTimedOut: boolean,
  failOnCriticalErrors: boolean,
  failOnTimeout: boolean
): boolean => {
  if (serverResult.unhealthy && !failOnCriticalErrors) {
    return true
  }

  if (hasTimedOut && !failOnTimeout) {
    return true
  }

  if (typeof serverResult.passed !== 'undefined') {
    return serverResult.passed
  }

  if (typeof serverResult.failure !== 'undefined') {
    return false
  }

  return true
}

export const enum ResultOutcome {
  Passed = 'passed',
  PreviouslyPassed = 'previously-passed',
  PassedNonBlocking = 'passed-non-blocking',
  Failed = 'failed',
  FailedNonBlocking = 'failed-non-blocking',
}

export const PASSED_RESULT_OUTCOMES = [
  ResultOutcome.Passed,
  ResultOutcome.PassedNonBlocking,
  ResultOutcome.PreviouslyPassed,
]

export const getResultOutcome = (result: Result): ResultOutcome => {
  if (isResultSkippedBySelectiveRerun(result)) {
    return ResultOutcome.PreviouslyPassed
  }

  const executionRule = result.executionRule

  if (result.passed) {
    if (executionRule === ExecutionRule.NON_BLOCKING) {
      return ResultOutcome.PassedNonBlocking
    }

    return ResultOutcome.Passed
  }

  if (executionRule === ExecutionRule.NON_BLOCKING) {
    return ResultOutcome.FailedNonBlocking
  }

  return ResultOutcome.Failed
}

export const getSuites = async (GLOB: string, reporter: MainReporter): Promise<Suite[]> => {
  reporter.log(`Finding files matching ${path.resolve(process.cwd(), GLOB)}\n`)

  const files: string[] = await promisify(glob)(GLOB)
  if (files.length) {
    reporter.log(`\nGot test files:\n${files.map((file) => `  - ${file}\n`).join('')}\n`)
  } else {
    reporter.log('\nNo test files found.\n\n')
  }

  return Promise.all(
    files.map(async (file) => {
      try {
        const content = await promisify(fs.readFile)(file, 'utf8')
        const suiteName = await getFilePathRelativeToRepo(file)

        return {name: suiteName, content: JSON.parse(content)}
      } catch (e) {
        throw new Error(`Unable to read and parse the test file ${file}`)
      }
    })
  )
}

export const getFilePathRelativeToRepo = async (filePath: string) => {
  const parentDirectory = path.dirname(filePath)
  const filename = path.basename(filePath)

  let relativeDirectory: string

  try {
    const {stdout} = await promisify(exec)('git rev-parse --show-toplevel')
    const repoTopLevel = stdout.trim()
    relativeDirectory = path.relative(repoTopLevel, parentDirectory)
  } catch {
    // We aren't in a git repository: fall back to the given path, relative to the process working directory.
    relativeDirectory = path.relative(process.cwd(), parentDirectory)
  }

  return path.join(relativeDirectory, filename)
}

export const wait = async (duration: number) => new Promise((resolve) => setTimeout(resolve, duration))

const getBatch = async (api: APIHelper, trigger: Trigger): Promise<Batch> => {
  try {
    const batch = await api.getBatch(trigger.batch_id)

    return batch
  } catch (e) {
    throw new EndpointError(`Failed to get batch: ${formatBackendErrors(e)}\n`, e.response?.status)
  }
}

const getTestByPublicId = (id: string, tests: Test[]): Test => tests.find((t) => t.public_id === id)!

const getPollResultMap = async (api: APIHelper, resultIds: string[]) => {
  try {
    const pollResults = await api.pollResults(resultIds)
    const pollResultMap: PollResultMap = {}
    pollResults.forEach((r) => (pollResultMap[r.resultID] = r))

    return pollResultMap
  } catch (e) {
    throw new EndpointError(`Failed to poll results: ${formatBackendErrors(e)}\n`, e.response?.status)
  }
}

export const getOrgSettings = async (
  reporter: MainReporter,
  config: SyntheticsCIConfig
): Promise<SyntheticsOrgSettings | undefined> => {
  const apiHelper = getApiHelper(config)

  try {
    return await apiHelper.getSyntheticsOrgSettings()
  } catch (e) {
    reporter.error(`Failed to get settings: ${formatBackendErrors(e)}`)
  }
}

const waitForBatchToFinish = async (
  api: APIHelper,
  maxPollingTimeout: number,
  trigger: Trigger,
  resultDisplayInfo: ResultDisplayInfo,
  reporter: MainReporter
): Promise<Result[]> => {
  const maxPollingDate = Date.now() + maxPollingTimeout
  const emittedResultIndexes = new Set<number>()

  while (true) {
    const batch = await getBatch(api, trigger)
    const hasBatchExceededMaxPollingDate = Date.now() >= maxPollingDate

    // The backend is expected to handle the time out of the batch by eventually changing its status to `failed`.
    // But `hasBatchExceededMaxPollingDate` is a safety in case it fails to do that.
    const shouldContinuePolling = batch.status === 'in_progress' && !hasBatchExceededMaxPollingDate

    const receivedResults = reportReceivedResults(batch, emittedResultIndexes, reporter)
    const residualResults = batch.results.filter((_, index) => !emittedResultIndexes.has(index))

    // For the last iteration, the full up-to-date data has to be fetched to compute this function's return value,
    // while only the [received + residual] results have to be reported.
    const resultIdsToFetch = (shouldContinuePolling ? receivedResults : batch.results).flatMap((r) =>
      isResultInBatchSkippedBySelectiveRerun(r) ? [] : [r.result_id]
    )
    const resultsToReport = receivedResults.concat(shouldContinuePolling ? [] : residualResults)

    const pollResultMap = await getPollResultMap(api, resultIdsToFetch)

    reportResults(resultsToReport, pollResultMap, resultDisplayInfo, hasBatchExceededMaxPollingDate, reporter)

    if (!shouldContinuePolling) {
      return batch.results.map((r) =>
        getResultFromBatch(r, pollResultMap, resultDisplayInfo, hasBatchExceededMaxPollingDate)
      )
    }

    reportWaitingTests(trigger, batch, resultDisplayInfo, reporter)

    await wait(POLLING_INTERVAL)
  }
}

export const isResultSkippedBySelectiveRerun = (result: Result): result is ResultSkippedBySelectiveRerun => {
  return result.selectiveRerun?.decision === 'skip'
}

const reportReceivedResults = (batch: Batch, emittedResultIndexes: Set<number>, reporter: MainReporter) => {
  const receivedResults: ResultInBatch[] = []

  for (const [index, result] of batch.results.entries()) {
    if (result.status !== 'in_progress' && !emittedResultIndexes.has(index)) {
      emittedResultIndexes.add(index)
      reporter.resultReceived(result)
      receivedResults.push(result)
    }
  }

  return receivedResults
}

const reportResults = (
  results: ResultInBatch[],
  pollResultMap: PollResultMap,
  resultDisplayInfo: ResultDisplayInfo,
  hasBatchExceededMaxPollingDate: boolean,
  reporter: MainReporter
) => {
  const baseUrl = getAppBaseURL(resultDisplayInfo.options)

  for (const result of results) {
    reporter.resultEnd(
      getResultFromBatch(result, pollResultMap, resultDisplayInfo, hasBatchExceededMaxPollingDate),
      baseUrl
    )
  }
}

const reportWaitingTests = (
  trigger: Trigger,
  batch: Batch,
  resultDisplayInfo: ResultDisplayInfo,
  reporter: MainReporter
) => {
  const baseUrl = getAppBaseURL(resultDisplayInfo.options)
  const {tests} = resultDisplayInfo

  const inProgressPublicIds = new Set()
  const skippedBySelectiveRerunPublicIds = new Set()

  for (const result of batch.results) {
    if (result.status === 'in_progress') {
      inProgressPublicIds.add(result.test_public_id)
    }
    if (isResultInBatchSkippedBySelectiveRerun(result)) {
      skippedBySelectiveRerunPublicIds.add(result.test_public_id)
    }
  }

  const remainingTests = []
  let skippedCount = 0

  for (const test of tests) {
    if (inProgressPublicIds.has(test.public_id)) {
      remainingTests.push(test)
    }
    if (skippedBySelectiveRerunPublicIds.has(test.public_id)) {
      skippedCount++
    }
  }

  reporter.testsWait(remainingTests, baseUrl, trigger.batch_id, skippedCount)
}

const getResultFromBatch = (
  resultInBatch: ResultInBatch,
  pollResultMap: PollResultMap,
  resultDisplayInfo: ResultDisplayInfo,
  hasBatchExceededMaxPollingDate: boolean
): Result => {
  const {getLocation, options, tests} = resultDisplayInfo

  const hasTimedOut = resultInBatch.timed_out ?? hasBatchExceededMaxPollingDate

  const test = getTestByPublicId(resultInBatch.test_public_id, tests)

  if (isResultInBatchSkippedBySelectiveRerun(resultInBatch)) {
    return {
      executionRule: resultInBatch.execution_rule,
      passed: true,
      resultId: getResultIdOrLinkedResultId(resultInBatch),
      selectiveRerun: resultInBatch.selective_rerun,
      test,
      timedOut: hasTimedOut,
    }
  }

  const pollResult = pollResultMap[resultInBatch.result_id]

  if (hasTimedOut) {
    pollResult.result.failure = {code: 'TIMEOUT', message: 'Result timed out'}
    pollResult.result.passed = false
  }

  return {
    executionRule: resultInBatch.execution_rule,
    location: getLocation(resultInBatch.location, test),
    passed: hasResultPassed(
      pollResult.result,
      hasTimedOut,
      options.failOnCriticalErrors ?? false,
      options.failOnTimeout ?? false
    ),
    result: pollResult.result,
    resultId: getResultIdOrLinkedResultId(resultInBatch),
    selectiveRerun: resultInBatch.selective_rerun,
    test: deepExtend({}, test, pollResult.check),
    timedOut: hasTimedOut,
    timestamp: pollResult.timestamp,
  }
}

// XXX: We shouldn't export functions that take an `APIHelper` because the `utils` module is exported while `api` is not.
export const waitForResults = async (
  api: APIHelper,
  trigger: Trigger,
  tests: Test[],
  options: ResultDisplayInfo['options'],
  reporter: MainReporter,
  tunnel?: Tunnel
): Promise<Result[]> => {
  let isTunnelConnected = true
  if (tunnel) {
    tunnel
      .keepAlive()
      .then(() => (isTunnelConnected = false))
      .catch(() => (isTunnelConnected = false))
  }

  reporter.testsWait(tests, getAppBaseURL(options), trigger.batch_id)

  const locationNames = trigger.locations.reduce<LocationsMapping>((mapping, location) => {
    mapping[location.name] = location.display_name

    return mapping
  }, {})

  const getLocation = (dcId: string, test: Test) => {
    const hasTunnel = !!tunnel && isTestSupportedByTunnel(test)

    return hasTunnel ? 'Tunneled' : locationNames[dcId] || dcId
  }

  const resultDisplayInfo = {
    getLocation,
    options,
    tests,
  }

  const results = await waitForBatchToFinish(api, options.maxPollingTimeout, trigger, resultDisplayInfo, reporter)

  if (tunnel && !isTunnelConnected) {
    reporter.error('The tunnel has stopped working, this may have affected the results.')
  }

  return results
}

export type InitialSummary = Omit<Summary, 'batchId'>

export const createInitialSummary = (): InitialSummary => ({
  criticalErrors: 0,
  expected: 0,
  failed: 0,
  failedNonBlocking: 0,
  passed: 0,
  previouslyPassed: 0,
  skipped: 0,
  testsNotFound: new Set(),
  timedOut: 0,
})

export const getResultDuration = (result: ServerResult): number => {
  if ('duration' in result) {
    return Math.round(result.duration)
  }
  if ('timings' in result) {
    return Math.round(result.timings.total)
  }

  return 0
}

export const getReporter = (reporters: Reporter[]): MainReporter => ({
  error: (error) => {
    for (const reporter of reporters) {
      if (typeof reporter.error === 'function') {
        reporter.error(error)
      }
    }
  },
  initErrors: (errors) => {
    for (const reporter of reporters) {
      if (typeof reporter.initErrors === 'function') {
        reporter.initErrors(errors)
      }
    }
  },
  log: (log) => {
    for (const reporter of reporters) {
      if (typeof reporter.log === 'function') {
        reporter.log(log)
      }
    }
  },
  reportStart: (timings) => {
    for (const reporter of reporters) {
      if (typeof reporter.reportStart === 'function') {
        reporter.reportStart(timings)
      }
    }
  },
  resultEnd: (result, baseUrl) => {
    for (const reporter of reporters) {
      if (typeof reporter.resultEnd === 'function') {
        reporter.resultEnd(result, baseUrl)
      }
    }
  },
  resultReceived: (result) => {
    for (const reporter of reporters) {
      if (typeof reporter.resultReceived === 'function') {
        reporter.resultReceived(result)
      }
    }
  },
  runEnd: (summary, baseUrl, orgSettings) => {
    for (const reporter of reporters) {
      if (typeof reporter.runEnd === 'function') {
        reporter.runEnd(summary, baseUrl, orgSettings)
      }
    }
  },
  testTrigger: (test, testId, executionRule, config) => {
    for (const reporter of reporters) {
      if (typeof reporter.testTrigger === 'function') {
        reporter.testTrigger(test, testId, executionRule, config)
      }
    }
  },
  testWait: (test) => {
    for (const reporter of reporters) {
      if (typeof reporter.testWait === 'function') {
        reporter.testWait(test)
      }
    }
  },
  testsWait: (tests, baseUrl, batchId, skippedCount) => {
    for (const reporter of reporters) {
      if (typeof reporter.testsWait === 'function') {
        reporter.testsWait(tests, baseUrl, batchId, skippedCount)
      }
    }
  },
})

const getTest = async (api: APIHelper, {id, suite}: TriggerConfig): Promise<{test: Test} | {errorMessage: string}> => {
  try {
    const test = {
      ...(await api.getTest(id)),
      suite,
    }

    return {test}
  } catch (error) {
    if (isNotFoundError(error)) {
      const errorMessage = formatBackendErrors(error)

      return {errorMessage: `[${chalk.bold.dim(id)}] ${chalk.yellow.bold('Test not found')}: ${errorMessage}`}
    }

    throw new EndpointError(`Failed to get test: ${formatBackendErrors(error)}\n`, error.response?.status)
  }
}

type NotFound = {errorMessage: string}
type Skipped = {overriddenConfig: TestPayload}
type TestWithOverride = {test: Test; overriddenConfig: TestPayload}

// XXX: We shouldn't export functions that take an `APIHelper` because the `utils` module is exported while `api` is not.
export const getTestAndOverrideConfig = async (
  api: APIHelper,
  {config, id, suite}: TriggerConfig,
  reporter: MainReporter,
  summary: InitialSummary,
  isTunnelEnabled?: boolean
): Promise<NotFound | Skipped | TestWithOverride> => {
  const normalizedId = PUBLIC_ID_REGEX.test(id) ? id : id.substring(id.lastIndexOf('/') + 1)

  const testResult = await getTest(api, {config, id: normalizedId, suite})
  if ('errorMessage' in testResult) {
    summary.testsNotFound.add(normalizedId)

    return {errorMessage: testResult.errorMessage}
  }

  const {test} = testResult
  const overriddenConfig = getOverriddenConfig(test, normalizedId, reporter, config)
  const testExecutionRule = test?.options?.ci?.executionRule
  const executionRule = overriddenConfig.executionRule || testExecutionRule || ExecutionRule.BLOCKING

  reporter.testTrigger(test, normalizedId, executionRule, config)
  if (executionRule === ExecutionRule.SKIPPED) {
    summary.skipped++

    return {overriddenConfig}
  }
  reporter.testWait(test)

  if (isTunnelEnabled && !isTestSupportedByTunnel(test)) {
    const details = [`public ID: ${test.public_id}`, `type: ${test.type}`]

    if (test.subtype) {
      details.push(`sub-type: ${test.subtype}`)
    }

    if (test.subtype === 'multi') {
      const unsupportedStepSubTypes = (test.config.steps || [])
        .filter((step) => step.subtype !== 'http')
        .map(({subtype}) => subtype)

      details.push(`step sub-types: [${unsupportedStepSubTypes.join(', ')}]`)
    }

    throw new CriticalError(
      'TUNNEL_NOT_SUPPORTED',
      `The tunnel is only supported with HTTP API tests and Browser tests (${details.join(', ')}).`
    )
  }

  return {overriddenConfig, test}
}

export const isDeviceIdSet = (result: ServerResult): result is Required<BrowserServerResult> =>
  'device' in result && result.device !== undefined

// XXX: We shouldn't export functions that take an `APIHelper` because the `utils` module is exported while `api` is not.
export const getTestsToTrigger = async (
  api: APIHelper,
  triggerConfigs: TriggerConfig[],
  reporter: MainReporter,
  triggerFromSearch?: boolean,
  failOnMissingTests?: boolean,
  isTunnelEnabled?: boolean
) => {
  const errorMessages: string[] = []
  // When too many tests are triggered, if fetched from a search query: simply trim them and show a warning,
  // otherwise: retrieve them and fail later if still exceeding without skipped/missing tests.
  if (triggerConfigs.length > MAX_TESTS_TO_TRIGGER && triggerFromSearch) {
    triggerConfigs.splice(MAX_TESTS_TO_TRIGGER)
    const maxTests = chalk.bold(MAX_TESTS_TO_TRIGGER)
    errorMessages.push(
      chalk.yellow(`More than ${maxTests} tests returned by search query, only the first ${maxTests} were fetched.\n`)
    )
  }

  const initialSummary = createInitialSummary()
  const testsAndConfigsOverride = await Promise.all(
    triggerConfigs.map((triggerConfig) =>
      getTestAndOverrideConfig(api, triggerConfig, reporter, initialSummary, isTunnelEnabled)
    )
  )

  // Keep track of uploaded applications to avoid uploading them twice.
  const uploadedApplicationByPath: {[applicationFilePath: string]: {applicationId: string; fileName: string}[]} = {}

  for (const item of testsAndConfigsOverride) {
    // Ignore not found and skipped tests.
    if ('errorMessage' in item || !('test' in item)) {
      continue
    }

    const {test, overriddenConfig} = item

    if (test.type === 'mobile') {
      const {config: userConfigOverride} = triggerConfigs.find(({id}) => id === test.public_id)!
      try {
        await uploadApplicationAndOverrideConfig(
          api,
          test,
          userConfigOverride,
          overriddenConfig,
          uploadedApplicationByPath
        )
      } catch (e) {
        throw new CriticalError('UPLOAD_MOBILE_APPLICATION_TESTS_FAILED', e.message)
      }
    }
  }

  const overriddenTestsToTrigger: TestPayload[] = []
  const waitedTests: Test[] = []
  testsAndConfigsOverride.forEach((item) => {
    if ('errorMessage' in item) {
      errorMessages.push(item.errorMessage)
    }

    if ('overriddenConfig' in item) {
      overriddenTestsToTrigger.push(item.overriddenConfig)
    }

    if ('test' in item) {
      waitedTests.push(item.test)
    }
  })

  // Display errors at the end of all tests for better visibility.
  reporter.initErrors(errorMessages)

  if (failOnMissingTests && initialSummary.testsNotFound.size > 0) {
    const testsNotFoundListStr = [...initialSummary.testsNotFound].join(', ')
    throw new CiError('MISSING_TESTS', testsNotFoundListStr)
  }

  if (!overriddenTestsToTrigger.length) {
    throw new CiError('NO_TESTS_TO_RUN')
  } else if (overriddenTestsToTrigger.length > MAX_TESTS_TO_TRIGGER) {
    throw new CriticalError(
      'TOO_MANY_TESTS_TO_TRIGGER',
      `Cannot trigger more than ${MAX_TESTS_TO_TRIGGER} tests (received ${triggerConfigs.length})`
    )
  }

  return {tests: waitedTests, overriddenTestsToTrigger, initialSummary}
}

// XXX: We shouldn't export functions that take an `APIHelper` because the `utils` module is exported while `api` is not.
export const runTests = async (
  api: APIHelper,
  testsToTrigger: TestPayload[],
  selectiveRerun = false
): Promise<Trigger> => {
  const payload: Payload = {
    tests: testsToTrigger,
    options: {
      selective_rerun: selectiveRerun,
    },
  }
  const tagsToLimit = {
    [GIT_COMMIT_MESSAGE]: 500,
  }
  const ciMetadata = getCIMetadata(tagsToLimit)

  if (ciMetadata) {
    payload.metadata = ciMetadata
  }

  try {
    return await api.triggerTests(payload)
  } catch (e) {
    const errorMessage = formatBackendErrors(e)
    const testIds = testsToTrigger.map((t) => t.public_id).join(',')
    // Rewrite error message
    throw new EndpointError(`[${testIds}] Failed to trigger tests: ${errorMessage}\n`, e.response?.status)
  }
}

export const fetchTest = async (publicId: string, config: SyntheticsCIConfig): Promise<Test> => {
  const apiHelper = getApiHelper(config)

  return apiHelper.getTest(publicId)
}

export const retry = async <T, E extends Error>(
  func: () => Promise<T>,
  shouldRetryAfterWait: (retries: number, error: E) => number | undefined
): Promise<T> => {
  const trier = async (retries = 0): Promise<T> => {
    try {
      return await func()
    } catch (e) {
      const waiter = shouldRetryAfterWait(retries, e)
      if (waiter) {
        await wait(waiter)

        return trier(retries + 1)
      }
      throw e
    }
  }

  return trier()
}

export const parseVariablesFromCli = (
  variableArguments: string[] = [],
  logFunction: (log: string) => void
): {[key: string]: string} | undefined => {
  const variables: {[key: string]: string} = {}

  for (const variableArgument of variableArguments) {
    const separatorIndex = variableArgument.indexOf('=')

    if (separatorIndex === -1) {
      logFunction(`Ignoring variable "${variableArgument}" as separator "=" was not found`)
      continue
    }

    if (separatorIndex === 0) {
      logFunction(`Ignoring variable "${variableArgument}" as variable name is empty`)
      continue
    }

    const key = variableArgument.substring(0, separatorIndex)
    const value = variableArgument.substring(separatorIndex + 1)

    variables[key] = value
  }

  return Object.keys(variables).length > 0 ? variables : undefined
}

// XXX: `CommandConfig` should be replaced by `SyntheticsCIConfig` here because it's the smallest
//      interface that we need, and it's better semantically.
export const getAppBaseURL = ({datadogSite, subdomain}: Pick<RunTestsCommandConfig, 'datadogSite' | 'subdomain'>) => {
  return getCommonAppBaseURL(datadogSite, subdomain)
}

export const getBatchUrl = (baseUrl: string, batchId: string) =>
  `${baseUrl}synthetics/explorer/ci?batchResultId=${batchId}`

export const getResultUrl = (baseUrl: string, test: Test, resultId: string) => {
  const ciQueryParam = 'from_ci=true'
  const testDetailUrl = `${baseUrl}synthetics/details/${test.public_id}`
  if (test.type === 'browser') {
    return `${testDetailUrl}/result/${resultId}?${ciQueryParam}`
  }

  return `${testDetailUrl}?resultId=${resultId}&${ciQueryParam}`
}

/**
 * Sort results with the following rules:
 * - Passed results come first
 * - Then non-blocking failed results
 * - And finally failed results
 */
export const sortResultsByOutcome = () => {
  const outcomeWeight = {
    [ResultOutcome.PreviouslyPassed]: 1,
    [ResultOutcome.PassedNonBlocking]: 2,
    [ResultOutcome.Passed]: 3,
    [ResultOutcome.FailedNonBlocking]: 4,
    [ResultOutcome.Failed]: 5,
  }

  return (r1: Result, r2: Result) => outcomeWeight[getResultOutcome(r1)] - outcomeWeight[getResultOutcome(r2)]
}

export const renderResults = ({
  config,
  orgSettings,
  reporter,
  results,
  startTime,
  summary,
}: {
  config: RunTestsCommandConfig
  orgSettings: SyntheticsOrgSettings | undefined
  reporter: MainReporter
  results: Result[]
  startTime: number
  summary: Summary
}) => {
  reporter.reportStart({startTime})

  if (!config.failOnTimeout) {
    if (!summary.timedOut) {
      summary.timedOut = 0
    }
  }

  if (!config.failOnCriticalErrors) {
    if (!summary.criticalErrors) {
      summary.criticalErrors = 0
    }
  }

  for (const result of results) {
    if (!config.failOnTimeout && result.timedOut) {
      summary.timedOut++
    }

    if (hasResult(result) && result.result.unhealthy && !config.failOnCriticalErrors) {
      summary.criticalErrors++
    }

    const resultOutcome = getResultOutcome(result)

    if (result.executionRule !== ExecutionRule.SKIPPED || resultOutcome === ResultOutcome.PreviouslyPassed) {
      summary.expected++
    }

    if ([ResultOutcome.Passed, ResultOutcome.PassedNonBlocking].includes(resultOutcome)) {
      summary.passed++
    } else if (resultOutcome === ResultOutcome.PreviouslyPassed) {
      summary.passed++
      summary.previouslyPassed++
    } else if (resultOutcome === ResultOutcome.FailedNonBlocking) {
      summary.failedNonBlocking++
    } else {
      summary.failed++
    }
  }

  reporter.runEnd(summary, getAppBaseURL(config), orgSettings)
}

export const reportExitLogs = (
  reporter: MainReporter,
  config: Pick<RunTestsCommandConfig, 'failOnTimeout' | 'failOnCriticalErrors'>,
  {results, error}: {results?: Result[]; error?: unknown}
) => {
  if (!config.failOnTimeout && results?.some((result) => result.timedOut)) {
    reporter.error(
      chalk.yellow(
        'Because `failOnTimeout` is disabled, the command will succeed. ' +
          'Use `failOnTimeout: true` to make it fail instead.\n'
      )
    )
  }

  if (!config.failOnCriticalErrors && error instanceof CriticalError) {
    reporter.error(
      chalk.yellow(
        'Because `failOnCriticalErrors` is not set or disabled, the command will succeed. ' +
          'Use `failOnCriticalErrors: true` to make it fail instead.\n'
      )
    )
  }

  if (error instanceof CiError) {
    reportCiError(error, reporter)
  }
}

export const getExitReason = (
  config: Pick<RunTestsCommandConfig, 'failOnCriticalErrors' | 'failOnMissingTests'>,
  {results, error}: {results?: Result[]; error?: unknown}
) => {
  if (results?.some((result) => getResultOutcome(result) === ResultOutcome.Failed)) {
    return 'failing-tests'
  }

  if (error instanceof CiError) {
    // Ensure the command fails if search query starts returning no results
    if (config.failOnMissingTests && ['MISSING_TESTS', 'NO_TESTS_TO_RUN'].includes(error.code)) {
      return 'missing-tests'
    }

    if (error instanceof CriticalError) {
      if (config.failOnCriticalErrors) {
        return 'critical-error'
      }
    }
  }

  return 'passed'
}

export type ExitReason = ReturnType<typeof getExitReason>

export const toExitCode = (reason: ExitReason) => {
  return reason === 'passed' ? 0 : 1
}

export const getDatadogHost = (hostConfig: {
  apiVersion: 'v1' | 'unstable'
  config: APIHelperConfig
  useIntake: boolean
}) => {
  const {useIntake, apiVersion, config} = hostConfig

  const apiPath = apiVersion === 'v1' ? 'api/v1' : 'api/unstable'
  let host = `https://api.${config.datadogSite}`
  const hostOverride = process.env.DD_API_HOST_OVERRIDE

  if (hostOverride) {
    host = hostOverride
  } else if (useIntake && (config.datadogSite === 'datadoghq.com' || config.datadogSite === 'datad0g.com')) {
    host = `https://intake.synthetics.${config.datadogSite}`
  }

  return `${host}/${apiPath}`
}

export const pluralize = (word: string, count: number): string => (count === 1 ? word : `${word}s`)

export const reportCiError = (error: CiError, reporter: MainReporter) => {
  switch (error.code) {
    case 'NO_TESTS_TO_RUN':
      reporter.error(`\n${chalk.bgRed.bold(' ERROR: No tests to run ')}\n${error.message}\n\n`)
      break
    case 'MISSING_TESTS':
      reporter.error(`\n${chalk.bgRed.bold(' ERROR: some tests are missing ')}\n${error.message}\n\n`)
      break

    // Critical command errors
    case 'AUTHORIZATION_ERROR':
      reporter.error(`\n${chalk.bgRed.bold(' ERROR: authorization error ')}\n${error.message}\n\n`)
      reporter.log('Credentials refused, make sure `apiKey`, `appKey` and `datadogSite` are correct.\n')
      break
    case 'INVALID_CONFIG':
      reporter.error(`\n${chalk.bgRed.bold(' ERROR: invalid config ')}\n${error.message}\n\n`)
      break
    case 'MISSING_APP_KEY':
      reporter.error(`Missing ${chalk.red.bold('DATADOG_APP_KEY')} in your environment.\n`)
      break
    case 'MISSING_API_KEY':
      reporter.error(`Missing ${chalk.red.bold('DATADOG_API_KEY')} in your environment.\n`)
      break
    case 'POLL_RESULTS_FAILED':
      reporter.error(`\n${chalk.bgRed.bold(' ERROR: unable to poll test results ')}\n${error.message}\n\n`)
      break
    case 'TUNNEL_START_FAILED':
      reporter.error(`\n${chalk.bgRed.bold(' ERROR: unable to start tunnel ')}\n${error.message}\n\n`)
      break
    case 'TOO_MANY_TESTS_TO_TRIGGER':
      reporter.error(`\n${chalk.bgRed.bold(' ERROR: too many tests to trigger ')}\n${error.message}\n\n`)
      break
    case 'TRIGGER_TESTS_FAILED':
      reporter.error(`\n${chalk.bgRed.bold(' ERROR: unable to trigger tests ')}\n${error.message}\n\n`)
      break
    case 'UNAVAILABLE_TEST_CONFIG':
      reporter.error(
        `\n${chalk.bgRed.bold(' ERROR: unable to obtain test configurations with search query ')}\n${error.message}\n\n`
      )
      break
    case 'UNAVAILABLE_TUNNEL_CONFIG':
      reporter.error(`\n${chalk.bgRed.bold(' ERROR: unable to get tunnel configuration ')}\n${error.message}\n\n`)
      break

    default:
      reporter.error(`\n${chalk.bgRed.bold(' ERROR ')}\n${error.message}\n\n`)
  }
}
