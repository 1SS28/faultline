import { App } from 'aws-cdk-lib';
import { FaultlineStack } from '../lib/faultline-stack';

const app = new App();

// The account comes from the AWS profile that runs the deploy, so no account ID lives in the repo.
// The region is fixed because the AWS free plan pins each project to one region.
new FaultlineStack(app, 'Faultline', {
  env: { region: 'us-east-2' },
  tags: { project: 'faultline' },
});
