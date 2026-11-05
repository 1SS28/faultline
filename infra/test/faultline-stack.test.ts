import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FaultlineStack } from '../lib/faultline-stack';

const template = Template.fromStack(new FaultlineStack(new App(), 'Test', { env: { region: 'us-east-2' } }));

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

test('nothing can connect to the database yet', () => {
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Faultline Postgres',
    SecurityGroupIngress: Match.absent(),
  });
});

test('the password is read from Secrets Manager at deploy time', () => {
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  const [instance] = Object.values(template.findResources('AWS::RDS::DBInstance'));
  assert.ok(instance);
  assert.match(JSON.stringify(instance.Properties.MasterUserPassword), /resolve:secretsmanager/);
});

test('tearing the stack down deletes the database', () => {
  template.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
});
