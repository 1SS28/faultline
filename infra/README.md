# Faultline on AWS

This folder describes Faultline's AWS setup as code, using the AWS CDK in TypeScript. The CDK turns `lib/faultline-stack.ts` into a CloudFormation template, and CloudFormation creates, updates and deletes the resources in it as one unit.

## What it creates

- A private network (VPC) across two availability zones. It has no route to or from the internet.
- A Postgres 18 database on RDS, the smallest size, with 20 GB of encrypted storage.
- The database password, generated at deploy time and stored in Secrets Manager.
- A job queue on SQS. Each message asks for one fixture trial, such as `{"scenario":"timeout-after-commit","strategy":"naive"}`.
- A worker on Lambda that runs inside the private network. It records each message as a job in the same job table the local worker uses, runs the trial, and saves the run.
- A dead-letter queue for messages the worker failed on five times, such as malformed JSON.
- A private connection to Secrets Manager, so the functions can read the password without internet access.
- An HTTP API on API Gateway. Every request needs an API key, and each key is limited to 2 requests a second and 1,000 a day. `POST /jobs` checks the body against the app's list of scenarios and sends it straight to the queue, with no function in between. The `GET` routes go to a small read function inside the private network.
- Four CloudWatch alarms. They email you when a message lands in the dead-letter queue, when the worker crashes or times out, when the API returns a server error, and when a job has waited more than 20 minutes. Each one emails again when it recovers.

Only the worker and the read function can reach the database and the password, and the database's certificate is checked on every connection.

SQS can deliver the same message twice. The worker uses the message ID as the job's idempotency key, so a second delivery finds the existing job instead of running the trial again.

Still to come: a query that flags agent versions whose pass rate dropped. Live model runs stay on your laptop, so no model API key is ever stored in AWS.

## Cost

While deployed it costs about $22 a month. Tear it down when you are not using it.

| Item | Per month |
| --- | --- |
| Database, db.t4g.micro | about $12 |
| Private connection to Secrets Manager | about $7.30 |
| Storage, 20 GB | about $2.30 |
| Password secret | $0.40 |
| Four alarms | $0.40 |
| API, queue, functions and logs at this volume | under $0.10 |

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

`npm run check` type checks the code and runs the tests in `test/`. `cdk synth` bundles the functions and writes the template to `cdk.out/`, so you can read exactly what would be created.

## Deploy

GitHub Actions type checks, tests and synthesizes this stack on every push, but deploys are run by hand. This account was created through AWS's free plan sign-up, which places it in an AWS-managed organization whose policy blocks creating identity providers. GitHub's keyless OIDC sign-in needs one, and the alternative is a long-lived access key in GitHub that can deploy anything, so deploys stay on a laptop signed in with `aws login`.

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

The first deploy takes about ten minutes, mostly waiting for the database. When it finishes it prints the API's URL and key ID, the alarm topic, both queue URLs, the worker's log group, the database's host and the secret's name.

## Try it

Read the API key's value, using the `ApiKeyId` the deploy printed.

```bash
aws apigateway get-api-key --profile faultline --api-key <ApiKeyId> --include-value --query value --output text
```

Submit a trial, using the `ApiUrl` it printed. The response is `{"id": "..."}`. A new key can take a minute to work after the first deploy, and until then requests get `403 Forbidden`.

```bash
curl -s -X POST <ApiUrl>jobs -H "x-api-key: <key>" -H "content-type: application/json" -d '{"scenario":"timeout-after-commit","strategy":"naive"}'
```

A second later, read the job and its run with that ID. The naive agent refunds twice when the reply is lost, so the run fails its checks.

```bash
curl -s <ApiUrl>jobs/<id> -H "x-api-key: <key>"
```

`GET /runs` lists recent runs, `GET /runs/<runId>` returns one with its full trace, and `GET /summary` gives pass rates by agent and scenario.

The worker's log shows each trial as it runs, using the `WorkerLogGroup` the deploy printed.

```bash
aws logs tail <WorkerLogGroup> --profile faultline --since 10m
```

A message the worker can't read, sent straight to the queue, is retried and then moved to the dead-letter queue. API Gateway rejects a malformed body before it gets that far.

Retrying `POST /jobs` creates a second job. Duplicates are caught per queue delivery, not per client request.

## Get alarm emails

The alarms send to a notification topic. Subscribe your email once, using the `AlarmTopicArn` the deploy printed, then click the confirmation link AWS emails you. The address stays out of the code, so it never lands in the public repo.

```bash
aws sns subscribe --profile faultline --topic-arn <AlarmTopicArn> --protocol email --notification-endpoint <your email>
```

To check that emails arrive, force an alarm on. It goes back to normal within five minutes and emails you again.

```bash
aws cloudwatch set-alarm-state --profile faultline --alarm-name faultline-dead-letters --state-value ALARM --state-reason "Testing alarm email"
```

## Tear down

This deletes everything the stack created, including the database and its data. The bootstrap resources stay and cost a few cents a month at most.

```bash
npx cdk destroy --profile faultline
```
