import {CloudWatchLogs, Lambda} from 'aws-sdk'
import chalk from 'chalk'
import {Cli, Command} from 'clipanion'
import {FileStatusResult} from 'simple-git'
import {InvalidConfigurationError} from '../../helpers/errors'
import {parseConfigFile} from '../../helpers/utils'
import {getCommitInfo, newSimpleGit} from '../commit/git'
import {UploadCommand} from '../commit/upload'
import {EXTRA_TAGS_REG_EXP} from './constants'
import {FunctionConfiguration, getLambdaConfigs, InstrumentationSettings, updateLambdaConfigs} from './function'
import {LambdaConfigOptions} from './interfaces'

export class InstrumentCommand extends Command {
  private config: LambdaConfigOptions = {
    functions: [],
    region: process.env.AWS_DEFAULT_REGION,
    tracing: 'true',
  }
  private configPath?: string
  private dryRun = false
  private environment?: string
  private extensionVersion?: string
  private extraTags?: string
  private flushMetricsToLogs?: string
  private forwarder?: string
  private functions: string[] = []
  private layerAWSAccount?: string
  private layerVersion?: string
  private logLevel?: string
  private mergeXrayTraces?: string
  private region?: string
  private service?: string
  private sourceCodeIntegration = false
  private tracing?: string
  private version?: string

  public async execute() {
    const lambdaConfig = {lambda: this.config}
    this.config = (await parseConfigFile(lambdaConfig, this.configPath)).lambda

    const settings = this.getSettings()
    if (settings === undefined) {
      return 1
    }

    const hasSpecifiedFuntions = this.functions.length !== 0 || this.config.functions.length !== 0
    if (!hasSpecifiedFuntions) {
      this.context.stdout.write('No functions specified for instrumentation.\n')

      return 1
    }

    const functionGroups = this.collectFunctionsByRegion()
    if (functionGroups === undefined) {
      return 1
    }

    if (settings.extensionVersion && settings.forwarderARN) {
      this.context.stdout.write('"extensionVersion" and "forwarder" should not be used at the same time.\n')

      return 1
    }

    if (this.sourceCodeIntegration) {
      if (!process.env.DATADOG_API_KEY) {
        throw new InvalidConfigurationError(`Missing ${chalk.bold('DATADOG_API_KEY')} in your environment.`)
      }
      const code = await this.getGitDataAndUpload(settings)
      if (code === 1) {
        return code
      }
    }

    const configGroups: {
      cloudWatchLogs: CloudWatchLogs
      configs: FunctionConfiguration[]
      lambda: Lambda
      region: string
    }[] = []

    for (const [region, functionList] of Object.entries(functionGroups)) {
      const lambda = new Lambda({region})
      const cloudWatchLogs = new CloudWatchLogs({region})
      try {
        const configs = await getLambdaConfigs(lambda, cloudWatchLogs, region, functionList, settings)
        configGroups.push({configs, lambda, cloudWatchLogs, region})
      } catch (err) {
        this.context.stdout.write(`Couldn't fetch lambda functions. ${err}\n`)

        return 1
      }
    }

    const configList = configGroups.map((group) => group.configs).reduce((a, b) => a.concat(b))
    this.printPlannedActions(configList)
    if (this.dryRun || configList.length === 0) {
      return 0
    }

    const promises = Object.values(configGroups).map((group) =>
      updateLambdaConfigs(group.lambda, group.cloudWatchLogs, group.configs)
    )
    try {
      await Promise.all(promises)
    } catch (err) {
      this.context.stdout.write(`Failure during update. ${err}\n`)

      return 1
    }

    return 0
  }

  private collectFunctionsByRegion() {
    const functions = this.functions.length !== 0 ? this.functions : this.config.functions
    const defaultRegion = this.region || this.config.region
    const groups: {[key: string]: string[]} = {}
    const regionless: string[] = []
    for (const func of functions) {
      const region = this.getRegion(func) ?? defaultRegion
      if (region === undefined) {
        regionless.push(func)
        continue
      }
      if (groups[region] === undefined) {
        groups[region] = []
      }
      const group = groups[region]
      group.push(func)
    }
    if (regionless.length > 0) {
      this.context.stdout.write(
        `'No default region specified for ${JSON.stringify(regionless)}. Use -r,--region, or use a full functionARN\n`
      )

      return
    }

    return groups
  }

  private convertStringBooleanToBoolean(fallback: boolean, value?: string, configValue?: string): boolean {
    return value ? value.toLowerCase() === 'true' : configValue ? configValue.toLowerCase() === 'true' : fallback
  }

  private async getCurrentGitStatus() {
    const simpleGit = await newSimpleGit()
    const gitCommitInfo = await getCommitInfo(simpleGit, this.context.stdout)
    if (gitCommitInfo === undefined) {
      return 1
    }
    const status = await simpleGit.status()

    return {isClean: status.isClean(), ahead: status.ahead, files: status.files, hash: gitCommitInfo?.hash}
  }

  private async getGitDataAndUpload(settings: InstrumentationSettings) {
    const currentStatus = await this.getCurrentGitStatus()

    if (currentStatus === 1) {
      return 1
    }

    if (!currentStatus.isClean) {
      this.printModifiedFilesFound(currentStatus.files)

      return 1
    }

    if (currentStatus.ahead > 0) {
      this.context.stdout.write('Local changes have not been pushed remotely. Aborting git upload.\n')

      return 1
    }

    const commitSha = currentStatus.hash
    if (settings.extraTags) {
      settings.extraTags += `,git.commit.sha:${commitSha}`
    } else {
      settings.extraTags = `git.commit.sha:${commitSha}`
    }

    return this.uploadGitData()
  }

  private getRegion(functionARN: string) {
    const [, , , region] = functionARN.split(':')

    return region === undefined || region === '*' ? undefined : region
  }

  private getSettings(): InstrumentationSettings | undefined {
    const layerVersionStr = this.layerVersion ?? this.config.layerVersion
    const extensionVersionStr = this.extensionVersion ?? this.config.extensionVersion
    const layerAWSAccount = this.layerAWSAccount ?? this.config.layerAWSAccount
    const forwarderARN = this.forwarder ?? this.config.forwarder

    let layerVersion
    if (layerVersionStr !== undefined) {
      layerVersion = parseInt(layerVersionStr, 10)
    }
    if (Number.isNaN(layerVersion)) {
      this.context.stdout.write(`Invalid layer version ${layerVersion}.\n`)

      return
    }

    let extensionVersion: number | undefined
    if (extensionVersionStr !== undefined) {
      extensionVersion = parseInt(extensionVersionStr, 10)
    }
    if (Number.isNaN(extensionVersion)) {
      this.context.stdout.write(`Invalid extension version ${extensionVersion}.\n`)

      return
    }

    const stringBooleansMap: {[key: string]: string | undefined} = {
      flushMetricsToLogs: this.flushMetricsToLogs?.toLowerCase() ?? this.config.flushMetricsToLogs?.toLowerCase(),
      mergeXrayTraces: this.mergeXrayTraces?.toLowerCase() ?? this.config.mergeXrayTraces?.toLowerCase(),
      tracing: this.tracing?.toLowerCase() ?? this.config.tracing?.toLowerCase(),
    }

    for (const [stringBoolean, value] of Object.entries(stringBooleansMap)) {
      if (!['true', 'false', undefined].includes(value)) {
        this.context.stdout.write(`Invalid boolean specified for ${stringBoolean}.\n`)

        return
      }
    }

    const flushMetricsToLogs = this.convertStringBooleanToBoolean(
      true,
      this.flushMetricsToLogs,
      this.config.flushMetricsToLogs
    )
    const mergeXrayTraces = this.convertStringBooleanToBoolean(false, this.mergeXrayTraces, this.config.mergeXrayTraces)
    const tracingEnabled = this.convertStringBooleanToBoolean(true, this.tracing, this.config.tracing)
    const logLevel = this.logLevel ?? this.config.logLevel

    const service = this.service ?? this.config.service
    const environment = this.environment ?? this.config.environment
    const version = this.version ?? this.config.version

    const tagsMap: {[key: string]: string | undefined} = {
      environment,
      service,
      version,
    }
    const tagsMissing = []
    for (const [tag, value] of Object.entries(tagsMap)) {
      if (!value) {
        tagsMissing.push(tag)
      }
    }
    if (tagsMissing.length > 0) {
      const tags = tagsMissing.join(', ').replace(/, ([^,]*)$/, ' and $1')
      const plural = tagsMissing.length > 1
      this.context.stdout.write(
        `Warning: The ${tags} tag${
          plural ? 's have' : ' has'
        } not been configured. Learn more about Datadog unified service tagging: https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/#serverless-environment.\n`
      )
    }

    const extraTags = this.extraTags?.toLowerCase() ?? this.config.extraTags?.toLowerCase()
    if (extraTags && !sentenceMatchesRegEx(extraTags, EXTRA_TAGS_REG_EXP)) {
      this.context.stdout.write('Extra tags do not comply with the <key>:<value> array.\n')

      return
    }

    return {
      environment,
      extensionVersion,
      extraTags,
      flushMetricsToLogs,
      forwarderARN,
      layerAWSAccount,
      layerVersion,
      logLevel,
      mergeXrayTraces,
      service,
      tracingEnabled,
      version,
    }
  }

  private printModifiedFilesFound(gitStatusPayload: FileStatusResult[]) {
    this.context.stdout.write('Found local modified files:\n')
    gitStatusPayload.forEach((file) => {
      this.context.stdout.write(`${file.path}\n`)
    })
    this.context.stdout.write('\nAborting git upload...\n')
  }

  private printPlannedActions(configs: FunctionConfiguration[]) {
    const prefix = this.dryRun ? '[Dry Run] ' : ''

    let anyUpdates = false
    for (const config of configs) {
      if (
        config.updateRequest !== undefined ||
        config.logGroupConfiguration?.createLogGroupRequest !== undefined ||
        config.logGroupConfiguration?.deleteSubscriptionFilterRequest !== undefined ||
        config.logGroupConfiguration?.subscriptionFilterRequest !== undefined ||
        config?.tagConfiguration !== undefined
      ) {
        anyUpdates = true
        break
      }
    }
    if (!anyUpdates) {
      this.context.stdout.write(`${prefix}No updates will be applied\n`)

      return
    }
    this.context.stdout.write(`${prefix}Will apply the following updates:\n`)
    for (const config of configs) {
      if (config.updateRequest) {
        this.context.stdout.write(
          `UpdateFunctionConfiguration -> ${config.functionARN}\n${JSON.stringify(
            config.updateRequest,
            undefined,
            2
          )}\n`
        )
      }
      const {logGroupConfiguration, tagConfiguration} = config
      if (tagConfiguration?.tagResourceRequest) {
        this.context.stdout.write(
          `TagResource -> ${tagConfiguration.tagResourceRequest.Resource}\n${JSON.stringify(
            tagConfiguration.tagResourceRequest.Tags,
            undefined,
            2
          )}\n`
        )
      }
      if (logGroupConfiguration?.createLogGroupRequest) {
        this.context.stdout.write(
          `CreateLogGroup -> ${logGroupConfiguration.logGroupName}\n${JSON.stringify(
            logGroupConfiguration.createLogGroupRequest,
            undefined,
            2
          )}\n`
        )
      }
      if (logGroupConfiguration?.deleteSubscriptionFilterRequest) {
        this.context.stdout.write(
          `DeleteSubscriptionFilter -> ${logGroupConfiguration.logGroupName}\n${JSON.stringify(
            logGroupConfiguration.deleteSubscriptionFilterRequest,
            undefined,
            2
          )}\n`
        )
      }
      if (logGroupConfiguration?.subscriptionFilterRequest) {
        this.context.stdout.write(
          `PutSubscriptionFilter -> ${logGroupConfiguration.logGroupName}\n${JSON.stringify(
            logGroupConfiguration.subscriptionFilterRequest,
            undefined,
            2
          )}\n`
        )
      }
    }
  }

  private async uploadGitData() {
    try {
      const cli = new Cli()
      cli.register(UploadCommand)
      await cli.run(['commit', 'upload'], this.context)
    } catch (err) {
      this.context.stdout.write(`Could not upload commit information. ${err}\n`)

      return 1
    }

    return 0
  }
}

export const sentenceMatchesRegEx = (sentence: string, regex: RegExp) => sentence.match(regex)

InstrumentCommand.addPath('lambda', 'instrument')
InstrumentCommand.addOption('functions', Command.Array('-f,--function'))
InstrumentCommand.addOption('region', Command.String('-r,--region'))
InstrumentCommand.addOption('extensionVersion', Command.String('-e,--extensionVersion'))
InstrumentCommand.addOption('layerVersion', Command.String('-v,--layerVersion'))
InstrumentCommand.addOption('layerAWSAccount', Command.String('-a,--layerAccount', {hidden: true}))
InstrumentCommand.addOption('tracing', Command.String('--tracing'))
InstrumentCommand.addOption('mergeXrayTraces', Command.String('--mergeXrayTraces'))
InstrumentCommand.addOption('flushMetricsToLogs', Command.String('--flushMetricsToLogs'))
InstrumentCommand.addOption('dryRun', Command.Boolean('-d,--dry'))
InstrumentCommand.addOption('configPath', Command.String('--config'))
InstrumentCommand.addOption('forwarder', Command.String('--forwarder'))
InstrumentCommand.addOption('logLevel', Command.String('--logLevel'))

InstrumentCommand.addOption('service', Command.String('--service'))
InstrumentCommand.addOption('environment', Command.String('--env'))
InstrumentCommand.addOption('version', Command.String('--version'))
InstrumentCommand.addOption('extraTags', Command.String('--extra-tags'))
InstrumentCommand.addOption('sourceCodeIntegration', Command.Boolean('-sci,--sourceCodeIntegration'))
