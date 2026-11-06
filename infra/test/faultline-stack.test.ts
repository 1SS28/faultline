import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FaultlineStack } from '../lib/faultline-stack';

// Skips bundling the worker, which these tests don't need.
const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
const template = Template.fromStack(new FaultlineStack(app, 'Test', { env: { region: 'us-east-2' } }));
const groupId = (description: string) => {
  const [id] = Object.keys(template.findResources('AWS::EC2::SecurityGroup', { Properties: { GroupDescription: description } }));
  assert.ok(id, `No security group described as ${description}`);
  return { 'Fn::GetAtt': [id, 'GroupId'] };
};

test('the network has no route to or from the internet', () => {
  template.resourceCountIs('AWS::EC2::InternetGateway', 0);
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::EC2::Subnet', 2);
});

test('the database is the free plan size and stays private', () => {
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    Engine: 'postgres',
    EngineVersion: '18',
    DBInstanceClass: 'db.t4g.micro',
    AllocatedStorage: '20',
    PubliclyAccessible: false,
    MultiAZ: false,
    StorageEncrypted: true,
  });
});

test('only the worker can reach the database and the password', () => {
  const worker = groupId('Faultline worker');
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 2);
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    GroupId: groupId('Faultline Postgres'), SourceSecurityGroupId: worker, CidrIp: Match.absent(),
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 443, ToPort: 443, SourceSecurityGroupId: worker, CidrIp: Match.absent(),
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Faultline Postgres', SecurityGroupIngress: Match.absent(),
  });
});

test('the password is read from Secrets Manager at deploy time', () => {
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  const [instance] = Object.values(template.findResources('AWS::RDS::DBInstance'));
  assert.ok(instance);
  assert.match(JSON.stringify(instance.Properties.MasterUserPassword), /resolve:secretsmanager/);
});

test('the worker reaches Secrets Manager privately, through one zone', () => {
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    ServiceName: 'com.amazonaws.us-east-2.secretsmanager',
    VpcEndpointType: 'Interface',
    PrivateDnsEnabled: true,
    SubnetIds: Match.exact([Match.anyValue()]),
  });
});

test('the worker runs on Node 24 and Graviton inside the private network', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x',
    Architectures: ['arm64'],
    Timeout: 30,
    VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
  });
});

test('failed messages retry, then move to the dead-letter queue', () => {
  template.hasResourceProperties('AWS::SQS::Queue', {
    VisibilityTimeout: 180,
    RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
  });
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    FunctionResponseTypes: ['ReportBatchItemFailures'],
    ScalingConfig: { MaximumConcurrency: 2 },
  });
});

test('both queues refuse unencrypted connections', () => {
  template.resourceCountIs('AWS::SQS::QueuePolicy', 2);
  template.allResourcesProperties('AWS::SQS::QueuePolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]),
    }),
  });
});

test('tearing the stack down deletes the database', () => {
  template.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
});
