import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { scenarios } from '../../src/core/types.js';
import { FaultlineStack } from '../lib/faultline-stack';

// Skips bundling the functions, which these tests do not need.
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

test('only the two functions can reach the database and the password', () => {
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 4);
  for (const source of ['Faultline worker', 'Faultline API reader']) {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      GroupId: groupId('Faultline Postgres'), SourceSecurityGroupId: groupId(source), CidrIp: Match.absent(),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 443, ToPort: 443, SourceSecurityGroupId: groupId(source), CidrIp: Match.absent(),
    });
  }
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

test('both functions run on Node 24 and Graviton inside the private network', () => {
  const functions = template.findResources('AWS::Lambda::Function', { Properties: { Handler: 'index.handler' } });
  assert.equal(Object.keys(functions).length, 2);
  for (const fn of Object.values(functions)) {
    assert.equal(fn.Properties.Runtime, 'nodejs24.x');
    assert.deepEqual(fn.Properties.Architectures, ['arm64']);
    assert.equal(fn.Properties.VpcConfig.SubnetIds.length, 2);
  }
});

test('every API route needs an API key', () => {
  const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
  assert.equal(methods.length, 6);
  for (const method of methods) assert.equal(method.Properties.ApiKeyRequired, true);
});

test('POST /jobs checks the body, then sends it straight to SQS', () => {
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'POST',
    RequestValidatorId: Match.anyValue(),
    Integration: Match.objectLike({ Type: 'AWS', PassthroughBehavior: 'NEVER', Uri: Match.objectLike({ 'Fn::Join': Match.anyValue() }) }),
  });
  const [model] = Object.values(template.findResources('AWS::ApiGateway::Model'));
  assert.deepEqual(model?.Properties.Schema.properties.scenario.enum, [...scenarios]);
  assert.equal(model?.Properties.Schema.additionalProperties, false);
});

test('each API key is throttled and capped per day', () => {
  template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
    Throttle: { RateLimit: 2, BurstLimit: 5 },
    Quota: { Limit: 1000, Period: 'DAY' },
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

test('alarms watch dead letters, errors and backlog, and notify both ways', () => {
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
  assert.deepEqual(alarms.map(alarm => alarm.Properties.AlarmName).sort(),
    ['faultline-api-errors', 'faultline-dead-letters', 'faultline-queue-backlog', 'faultline-worker-errors']);
  for (const alarm of alarms) {
    assert.equal(alarm.Properties.AlarmActions.length, 1);
    assert.deepEqual(alarm.Properties.OKActions, alarm.Properties.AlarmActions);
    assert.equal(alarm.Properties.TreatMissingData, 'notBreaching');
  }
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'faultline-dead-letters', MetricName: 'ApproximateNumberOfMessagesVisible', Threshold: 1,
  });
});

test('CloudWatch may publish to the alarm topic, over encrypted connections only', () => {
  template.hasResourceProperties('AWS::SNS::TopicPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        Match.objectLike({
          Effect: 'Allow', Action: 'sns:Publish', Principal: { Service: 'cloudwatch.amazonaws.com' },
          Condition: Match.objectLike({ StringEquals: Match.objectLike({ 'aws:SourceAccount': Match.anyValue() }) }),
        }),
      ]),
    }),
  });
});

test('no email address is stored in the template', () => {
  template.resourceCountIs('AWS::SNS::Subscription', 0);
});

test('tearing the stack down deletes the database', () => {
  template.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
});
