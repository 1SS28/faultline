import { App } from 'aws-cdk-lib';
import { FaultlineStack } from '../lib/faultline-stack';

const app = new App();

// the account comes from whoever deploys, so no account ID lives in the repo
// the free plan pins each project to one region
new FaultlineStack(app, 'Faultline', {
  env: { region: 'us-east-2' },
  tags: { project: 'faultline' },
});
