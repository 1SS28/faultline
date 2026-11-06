# Faultline on AWS

This folder describes Faultline's AWS setup as code, using the AWS CDK in TypeScript. The CDK turns `lib/faultline-stack.ts` into a CloudFormation template, and CloudFormation creates, updates and deletes the resources in it as one unit.

## What it creates

- A private network (VPC) across two availability zones. It has no route to or from the internet.
- A Postgres 18 database on RDS, the smallest size, with 20 GB of encrypted storage.
- The database password, generated at deploy time and stored in Secrets Manager.
- A job queue on SQS. Each message asks for one fixture trial, such as `{"scenario":"timeout-after-commit","strategy":"naive"}`.
- A worker on Lambda that runs inside the private network. It records each message as a job in the same job table the local worker uses, runs the trial, and saves the run.
- A dead-letter queue for messages the worker failed on five times, such as malformed JSON.
- A private connection to Secrets Manager, so the worker can read the password without internet access.

Only the worker can reach the database and the password, and the database's certificate is checked on every connection.

SQS can deliver the same message twice. The worker uses the message ID as the job's idempotency key, so a second delivery finds the existing job instead of running the trial again.

Still to come: an HTTP API, an alarm, and deploys from GitHub Actions. Live model runs stay on your laptop, so no model API key is ever stored in AWS.

## Cost

While deployed it costs about $22 a month. Tear it down when you are not using it.

| Item | Per month |
| --- | --- |
| Database, db.t4g.micro | about $12 |
| Private connection to Secrets Manager | about $7.30 |
| Storage, 20 GB | about $2.30 |
| Password secret | $0.40 |
| Queue, worker and logs at this volume | under $0.10 |

## Check it locally

Run these from this folder. None of them touch AWS. The worker imports the app's code, so run `npm install` in the repo root first too.

```bash
npm install
```

```bash
npm run check
```

```bash
npx cdk synth
```

`npm run check` type checks the code and runs the tests in `test/`. `cdk synth` bundles the worker and writes the template to `cdk.out/`, so you can read exactly what would be created.

## Deploy

Deploying creates real resources that cost money. Sign in first, since a session lasts 12 hours.

```bash
aws login --profile faultline
```

Bootstrapping runs once per account and region. It creates the storage bucket and roles the CDK deploys through.

```bash
npx cdk bootstrap --profile faultline
```

```bash
npx cdk deploy --profile faultline
```

The first deploy takes about ten minutes, mostly waiting for the database. When it finishes it prints the database's host, the secret's name, both queue URLs and the worker's log group.

## Try it

Send a trial to the queue, using the `QueueUrl` the deploy printed.

```bash
aws sqs send-message --profile faultline --queue-url <QueueUrl> --message-body '{"scenario":"timeout-after-commit","strategy":"naive"}'
```

Then read the worker's log, using the `WorkerLogGroup` it printed. The naive agent refunds twice when the reply is lost, so the run should fail its checks.

```bash
aws logs tail <WorkerLogGroup> --profile faultline --since 10m
```

A message the worker can't read, such as `not json`, is retried and then moved to the dead-letter queue.

## Tear down

This deletes everything the stack created, including the database and its data. The bootstrap resources stay and cost a few cents a month at most.

```bash
npx cdk destroy --profile faultline
```
