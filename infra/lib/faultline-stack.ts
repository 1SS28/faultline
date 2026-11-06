import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const repoRoot = path.join(__dirname, '..', '..');

export class FaultlineStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly database: rds.DatabaseInstance;
  readonly databaseSecurityGroup: ec2.SecurityGroup;
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly worker: nodejs.NodejsFunction;

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

    const workerSecurityGroup = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc: this.vpc,
      description: 'Faultline worker',
      allowAllOutbound: false,
    });

    // The worker has no internet access, so it reads the database password through a private
    // connection to Secrets Manager. One availability zone is enough here and halves the cost.
    const secretsEndpoint = this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnets: [this.vpc.isolatedSubnets[0]!] },
      open: false,
    });

    this.worker = new nodejs.NodejsFunction(this, 'Worker', {
      entry: path.join(repoRoot, 'infra/functions/worker.mts'),
      // The worker imports the app's own job code from src/, so it bundles from the repo root.
      projectRoot: repoRoot,
      depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [workerSecurityGroup],
      environment: { DATABASE_SECRET_ARN: databaseSecret.secretArn },
      logGroup: new logs.LogGroup(this, 'WorkerLogs', {
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

    this.worker.addEventSource(new SqsEventSource(this.queue, {
      batchSize: 5,
      reportBatchItemFailures: true,
      // At most two workers at once, which also keeps connections to the small database low.
      maxConcurrency: 2,
    }));
    databaseSecret.grantRead(this.worker);
    this.database.connections.allowDefaultPortFrom(workerSecurityGroup, 'Worker to Postgres');
    secretsEndpoint.connections.allowDefaultPortFrom(workerSecurityGroup, 'Worker to Secrets Manager');

    new CfnOutput(this, 'DatabaseHost', { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DatabaseSecretName', { value: databaseSecret.secretName });
    new CfnOutput(this, 'QueueUrl', { value: this.queue.queueUrl });
    new CfnOutput(this, 'DeadLetterQueueUrl', { value: this.deadLetterQueue.queueUrl });
    new CfnOutput(this, 'WorkerLogGroup', { value: this.worker.logGroup.logGroupName });
  }
}
