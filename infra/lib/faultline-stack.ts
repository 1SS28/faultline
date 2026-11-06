import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { scenarios, strategies } from '../../src/core/types.js';

const repoRoot = path.join(__dirname, '..', '..');

export class FaultlineStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly database: rds.DatabaseInstance;
  readonly databaseSecurityGroup: ec2.SecurityGroup;
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly worker: nodejs.NodejsFunction;
  readonly api: apigateway.RestApi;
  readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // A private network across two availability zones, which RDS requires. It has no internet
    // gateway and no NAT gateway, so nothing inside can reach the internet and nothing outside
    // can reach in. A NAT gateway would cost more than the database.
    this.vpc = new ec2.Vpc(this, 'Network', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });

    // The database's firewall. It starts with no inbound rules. The worker is let in below by
    // naming its security group, not by IP address.
    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'Faultline Postgres',
      allowAllOutbound: false,
    });

    this.database = new rds.DatabaseInstance(this, 'Database', {
      // Major version only, matching the embedded Postgres the app runs locally. RDS applies
      // minor updates itself, and pinning a minor version here would make the next deploy
      // try to roll them back.
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.of('18', '18') }),
      // The smallest class, and one of the two the AWS free plan allows.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.databaseSecurityGroup],
      publiclyAccessible: false,
      multiAz: false,
      databaseName: 'faultline',
      // A password is generated at deploy time and kept in Secrets Manager. It never appears
      // in this code or in the CloudFormation template.
      credentials: rds.Credentials.fromGeneratedSecret('faultline'),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(1),
      deleteAutomatedBackups: true,
      // This database holds test runs, not customer data, so tearing the stack down deletes it
      // without keeping a final snapshot that would keep costing money.
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const databaseSecret = this.database.secret!;

    // Messages the worker failed on five times in a row land here instead of retrying forever.
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    // Each message asks for one fixture trial, such as {"scenario":"rate-limit","strategy":"naive"}.
    this.queue = new sqs.Queue(this, 'JobQueue', {
      // Six times the worker's timeout, as AWS recommends, so a message isn't handed to a
      // second worker while the first is still running it.
      visibilityTimeout: Duration.minutes(3),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // More than the job table's three attempts, so a job can use all of them before its
      // message is given up on.
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 5 },
    });

    // The functions have no internet access, so they read the database password through a private
    // connection to Secrets Manager. One availability zone is enough here and halves the cost.
    const secretsEndpoint = this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnets: [this.vpc.isolatedSubnets[0]!] },
      open: false,
    });

    // Each function gets its own firewall that can reach only the database and Secrets Manager,
    // and permission to read only the database password.
    const privateFunction = (id: string, entry: string, description: string, timeout: Duration) => {
      const securityGroup = new ec2.SecurityGroup(this, `${id}SecurityGroup`, { vpc: this.vpc, description, allowAllOutbound: false });
      const fn = new nodejs.NodejsFunction(this, id, {
        entry: path.join(repoRoot, 'infra/functions', entry),
        // The functions import the app's own code from src/, so they bundle from the repo root.
        projectRoot: repoRoot,
        depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout,
        vpc: this.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [securityGroup],
        environment: { DATABASE_SECRET_ARN: databaseSecret.secretArn },
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: {
          format: nodejs.OutputFormat.ESM,
          mainFields: ['module', 'main'],
          // The Postgres driver is CommonJS and calls require(), which an ES module bundle has to provide.
          banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
          // The AWS SDK comes with the Lambda runtime. The others are never loaded on the server.
          externalModules: ['@aws-sdk/*', 'pg-native', '@electric-sql/pglite'],
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            // The migrations, and the certificates that prove the database is really Amazon RDS in us-east-2.
            afterBundling: (inputDir, outputDir) => [
              `cp -R "${inputDir}/sql" "${outputDir}/sql"`,
              `cp "${inputDir}/infra/functions/rds-ca-us-east-2.pem" "${outputDir}/rds-ca.pem"`,
            ],
          },
        },
      });
      databaseSecret.grantRead(fn);
      this.database.connections.allowDefaultPortFrom(securityGroup, `${description} to Postgres`);
      secretsEndpoint.connections.allowDefaultPortFrom(securityGroup, `${description} to Secrets Manager`);
      return fn;
    };

    this.worker = privateFunction('Worker', 'worker.mts', 'Faultline worker', Duration.seconds(30));
    this.worker.addEventSource(new SqsEventSource(this.queue, {
      batchSize: 5,
      reportBatchItemFailures: true,
      // At most two workers at once, which also keeps connections to the small database low.
      maxConcurrency: 2,
    }));

    // The HTTP API. Every request needs an API key. POST /jobs goes straight from API Gateway to
    // the queue with no function in between, and the GET routes read results from the database.
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'faultline',
      description: 'Faultline jobs and runs',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: 'v1', throttlingRateLimit: 5, throttlingBurstLimit: 10 },
      defaultMethodOptions: { apiKeyRequired: true },
      cloudWatchRole: false,
    });

    // API Gateway rejects a malformed body before it reaches the queue. The lists come from the
    // app's own code, so a new scenario is accepted as soon as it exists.
    const jobRequest = this.api.addModel('JobRequest', {
      contentType: 'application/json',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['scenario', 'strategy'],
        additionalProperties: false,
        properties: {
          scenario: { type: apigateway.JsonSchemaType.STRING, enum: [...scenarios] },
          strategy: { type: apigateway.JsonSchemaType.STRING, enum: [...strategies] },
        },
      },
    });
    const queueRole = new iam.Role(this, 'ApiQueueRole', { assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com') });
    this.queue.grantSendMessages(queueRole);
    const jobs = this.api.root.addResource('jobs');
    jobs.addMethod('POST', new apigateway.AwsIntegration({
      service: 'sqs',
      path: `${this.account}/${this.queue.queueName}`,
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: queueRole,
        // Anything that isn't JSON is refused instead of being passed to the queue unchecked.
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestParameters: { 'integration.request.header.Content-Type': "'application/x-www-form-urlencoded'" },
        requestTemplates: { 'application/json': 'Action=SendMessage&MessageBody=$util.urlEncode($input.body)' },
        integrationResponses: [
          { statusCode: '202', responseTemplates: { 'application/json': `{"id": "$input.path('$.SendMessageResponse.SendMessageResult.MessageId')"}` } },
          { statusCode: '500', selectionPattern: '[45]\\d{2}', responseTemplates: { 'application/json': '{"error": "The job could not be queued"}' } },
        ],
      },
    }), {
      requestValidator: new apigateway.RequestValidator(this, 'JobRequestValidator', { restApi: this.api, validateRequestBody: true }),
      requestModels: { 'application/json': jobRequest },
      methodResponses: [{ statusCode: '202' }, { statusCode: '500' }],
    });

    const reader = privateFunction('ApiReader', 'api.mts', 'Faultline API reader', Duration.seconds(10));
    const read = new apigateway.LambdaIntegration(reader, { allowTestInvoke: false });
    jobs.addResource('{id}').addMethod('GET', read);
    const runs = this.api.root.addResource('runs');
    runs.addMethod('GET', read);
    runs.addResource('{id}').addMethod('GET', read);
    this.api.root.addResource('summary').addMethod('GET', read);

    // Each key is limited separately from the stage-wide limit above.
    const apiKey = this.api.addApiKey('ApiKey', { description: 'Faultline default key' });
    const usagePlan = this.api.addUsagePlan('UsagePlan', {
      throttle: { rateLimit: 2, burstLimit: 5 },
      quota: { limit: 1000, period: apigateway.Period.DAY },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.api.deploymentStage });

    // Alarms notify this topic, in both directions: when something breaks and when it recovers.
    // An email address is subscribed once from the CLI, so no personal address is stored in this
    // public repo.
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', { displayName: 'Faultline alarms', enforceSSL: true });
    // The encrypted-only rule replaces the topic's default access policy, so CloudWatch needs an
    // explicit grant. It is limited to this account's Faultline alarms.
    this.alarmTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowFaultlineAlarms',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [this.alarmTopic.topicArn],
      conditions: {
        ArnLike: { 'aws:SourceArn': `arn:aws:cloudwatch:${this.region}:${this.account}:alarm:faultline-*` },
        StringEquals: { 'aws:SourceAccount': this.account },
      },
    }));
    const notify = new actions.SnsAction(this.alarmTopic);
    const alarm = (id: string, alarmName: string, alarmDescription: string, metric: cloudwatch.IMetric, threshold: number) => {
      const created = new cloudwatch.Alarm(this, id, {
        alarmName,
        alarmDescription,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        // No data means no traffic, which is normal for this stack.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      created.addAlarmAction(notify);
      created.addOkAction(notify);
    };
    const fiveMinutes = { period: Duration.minutes(5) };
    alarm('DeadLetterAlarm', 'faultline-dead-letters',
      'A message failed five times and moved to the dead-letter queue. Read it there, fix the cause, then delete it.',
      this.deadLetterQueue.metricApproximateNumberOfMessagesVisible(fiveMinutes), 1);
    // Failed trials and messages the worker retries don't count here. This catches the worker
    // itself failing, usually because it couldn't reach the database or ran out of time.
    alarm('WorkerErrorAlarm', 'faultline-worker-errors',
      'The worker crashed or timed out. Check the worker log.',
      this.worker.metricErrors(fiveMinutes), 1);
    alarm('ApiErrorAlarm', 'faultline-api-errors',
      'The API returned a 5xx error. Check the API reader log, or the queue if POST /jobs failed.',
      this.api.metricServerError(fiveMinutes), 1);
    // A message that keeps failing leaves for the dead-letter queue within about 15 minutes, so
    // anything older means the worker is down or falling behind.
    alarm('QueueBacklogAlarm', 'faultline-queue-backlog',
      'A job has waited more than 20 minutes, so the worker is down or falling behind.',
      this.queue.metricApproximateAgeOfOldestMessage(fiveMinutes), 20 * 60);

    new CfnOutput(this, 'DatabaseHost', { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DatabaseSecretName', { value: databaseSecret.secretName });
    new CfnOutput(this, 'QueueUrl', { value: this.queue.queueUrl });
    new CfnOutput(this, 'DeadLetterQueueUrl', { value: this.deadLetterQueue.queueUrl });
    new CfnOutput(this, 'WorkerLogGroup', { value: this.worker.logGroup.logGroupName });
    new CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new CfnOutput(this, 'ApiKeyId', { value: apiKey.keyId });
    new CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
  }
}
