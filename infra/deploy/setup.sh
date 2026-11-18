#!/usr/bin/env bash
# one-time setup for deploys from GitHub Actions. run after `aws login --profile faultline`.
# safe to run again: it replaces the key.
set -euo pipefail
cd "$(dirname "$0")"

export AWS_PROFILE="${AWS_PROFILE:-faultline}"
user=faultline-deploy
env=production
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

aws sts get-caller-identity >/dev/null
aws iam get-user --user-name "$user" >/dev/null 2>&1 || aws iam create-user --user-name "$user" >/dev/null
aws iam put-user-policy --user-name "$user" --policy-name assume-cdk-roles --policy-document file://policy.json

# only runs from main can use the environment, and so the key
gh api -X PUT "repos/$repo/environments/$env" --input - >/dev/null \
  <<< '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
if ! gh api "repos/$repo/environments/$env/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main; then
  gh api -X POST "repos/$repo/environments/$env/deployment-branch-policies" -f name=main -f type=branch >/dev/null
fi

# an old key would keep working, so replace it instead of adding one
for old in $(aws iam list-access-keys --user-name "$user" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
  [ "$old" = None ] || aws iam delete-access-key --user-name "$user" --access-key-id "$old"
done

# straight from AWS to GitHub: never printed, never written to disk
read -r key_id secret < <(aws iam create-access-key --user-name "$user" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
[ -n "$key_id" ] && [ -n "$secret" ]
printf %s "$key_id" | gh secret set AWS_ACCESS_KEY_ID --env "$env" --repo "$repo"
printf %s "$secret" | gh secret set AWS_SECRET_ACCESS_KEY --env "$env" --repo "$repo"
unset secret

gh variable set DEPLOY_ENABLED --body true --repo "$repo"
echo "Deploys from main are on for $repo."
