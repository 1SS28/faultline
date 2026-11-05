# Faultline on AWS

This folder describes Faultline's AWS setup as code, using the AWS CDK in TypeScript. The CDK turns `lib/faultline-stack.ts` into a CloudFormation template, and CloudFormation creates, updates and deletes the resources in it as one unit.

## What it creates

- A private network (VPC) across two availability zones. It has no route to or from the internet.
- A Postgres 18 database on RDS, the smallest size, with 20 GB of encrypted storage. Nothing can connect to it yet.
- The database password, generated at deploy time and stored in Secrets Manager.

Still to come: a queue and a worker function that run fixture trials, an HTTP API, an alarm, and deploys from GitHub Actions. Live model runs stay on your laptop, so no model API key is ever stored in AWS.

## Cost

While deployed it costs about $15 a month, almost all of it the database. Tear it down when you are not using it.

| Item | Per month |
| --- | --- |
| Database, db.t4g.micro | about $12 |
| Storage, 20 GB | about $2.30 |
| Password secret | $0.40 |

## Check it locally

Run these from this folder. None of them touch AWS.

```bash
npm install
```

```bash
npm run check
```

```bash
npx cdk synth
```

`npm run check` type checks the code and runs the tests in `test/`. `cdk synth` writes the template to `cdk.out/` so you can read exactly what would be created.

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

The database takes about ten minutes to start. When the deploy finishes it prints the database's host and the name of the secret holding its password.

## Tear down

This deletes everything the stack created, including the database and its data. The bootstrap resources stay and cost a few cents a month at most.

```bash
npx cdk destroy --profile faultline
```
