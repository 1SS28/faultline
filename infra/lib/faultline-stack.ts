import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

export class FaultlineStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly database: rds.DatabaseInstance;
  readonly databaseSecurityGroup: ec2.SecurityGroup;

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

    // The database's firewall. It starts with no inbound rules, so nothing can connect yet.
    // Later steps let the worker and API functions in by naming their security groups.
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

    new CfnOutput(this, 'DatabaseHost', { value: this.database.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DatabaseSecretName', { value: this.database.secret!.secretName });
  }
}
