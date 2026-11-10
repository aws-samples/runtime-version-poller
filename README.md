# AWS Lambda Runtime Version Notification

This repository showcases a serverless solution for generating notifications whenever new AWS Lambda runtime versions become available. The implementation leverages multiple AWS services, including Lambda, CloudWatch Events, CloudWatch Logs, DynamoDB, EventBridge Pipelines and Simple Notification Service (SNS).

If you run v1 of this sample, follow [Upgrading from v1](#upgrading-from-v1). Releases are listed in the [CHANGELOG](CHANGELOG.md).

## Overview

The core functionality is achieved through a set of Lambda functions, one for each supported runtime and architecture. These functions are triggered hourly via CloudWatch Events and log their runtime version to CloudWatch Logs using the `INIT_START` log line.

CloudWatch Logs is configured with an Account Policy that subscribes to the `INIT_START` log line. Whenever a new log entry is detected, a target function extracts the latest runtime version information and stores it in a DynamoDB table. The policy covers every function in the account, so `target` reads the architecture from the function name (`<name>_x86_64` or `<name>_arm64`) and ignores functions named any other way.

EventBridge Pipelines monitors the DynamoDB table for new entries (create events). When a new entry is detected, EventBridge Pipelines triggers an SNS notification, alerting subscribers about the availability of a new Lambda runtime version.

### DynamoDB items

Each item is one runtime version seen in one region for one architecture:

| Attribute | Value |
|---|---|
| `pk` | `<runtime>_<arch>_<region>`, for example `python3.14_x86_64_eu-west-1` or `nodejs24.x_arm64_us-east-1` |
| `sk` | The runtime version's patch number (the `vN` in `INIT_START`) |
| `arch` | `arm64` or `x86_64` |
| `runtime`, `region`, `patch`, `runtimeVersion`, `runtimeVersionArn`, `timestamp` | From the `INIT_START` line; `timestamp` is when the version was first seen |
| `migratedFrom` | Only on items moved from a v1 key (see [Upgrading from v1](#upgrading-from-v1)). The pipe does not announce these. |

## Supported Runtime and Architecture Combinations

The following runtime and architecture combinations are currently supported by the CloudFormation templates:

| Runtime | Architecture | Status |
|---------|-------------|---------|
| dotnet6 | arm64, x86_64 | ✅ Supported |
| dotnet8 | arm64, x86_64 | ✅ Supported |
| dotnet10 | arm64, x86_64 | ✅ Supported |
| java8.al2 | arm64, x86_64 | ✅ Supported |
| java8.al2023 | arm64, x86_64 | ✅ Supported |
| java11 | arm64, x86_64 | ✅ Supported |
| java11.al2023 | arm64, x86_64 | ✅ Supported |
| java17 | arm64, x86_64 | ✅ Supported |
| java17.al2023 | arm64, x86_64 | ✅ Supported |
| java21 | arm64, x86_64 | ✅ Supported |
| java25 | arm64, x86_64 | ✅ Supported |
| nodejs16.x | arm64, x86_64 | ✅ Supported |
| nodejs18.x | arm64, x86_64 | ✅ Supported |
| nodejs20.x | arm64, x86_64 | ✅ Supported |
| nodejs22.x | arm64, x86_64 | ✅ Supported |
| nodejs24.x | arm64, x86_64 | ✅ Supported |
| nodejs26.x | arm64, x86_64 | 🧪 Preview |
| python3.8 | arm64, x86_64 | ✅ Supported |
| python3.9 | arm64, x86_64 | ✅ Supported |
| python3.10 | arm64, x86_64 | ✅ Supported |
| python3.11 | arm64, x86_64 | ✅ Supported |
| python3.12 | arm64, x86_64 | ✅ Supported |
| python3.13 | arm64, x86_64 | ✅ Supported |
| python3.14 | arm64, x86_64 | ✅ Supported |
| ruby3.2 | arm64, x86_64 | ✅ Supported |
| ruby3.3 | arm64, x86_64 | ✅ Supported |
| ruby3.4 | arm64, x86_64 | ✅ Supported |
| ruby4.0 | arm64, x86_64 | ✅ Supported |
| provided.al2 | arm64, x86_64 | ✅ Supported |
| provided.al2023 | arm64, x86_64 | ✅ Supported |

**Note**: All runtimes listed above are defined in the CloudFormation templates. For deployment, you can either create functions using the AWS console and provide the function name, or upload deployment packages to S3 and reference them in the template parameters.

Runtimes that Lambda offers only as container images (for example `dotnet9`) are not included, because the functions are deployed as .zip packages.

## Deployment

**WARNING!** This example leverages CloudWatch Logs Account Policy subscription filters. This will create a subscription filter for **ALL** log groups in the region where the policy is deployed. It is recommended to deploy this example in a dedicated AWS account for this workload.

### Region Support

This solution supports deployment to all commercial AWS regions except those listed under Unavailable Regions below. It relies on the Account Policy CloudFormation resource (`AWS::Logs::AccountPolicy`), which can reach a new region some time after the region launches. Before deploying to a new region, check that it is available with `aws cloudformation describe-type --type RESOURCE --type-name AWS::Logs::AccountPolicy --region <region>`.

#### Unavailable Regions

- **me-south-1** (Middle East - Bahrain) is not supported.
- **me-central-1** (Middle East - UAE) is not supported. `target` does not grant it permission to deliver logs.

**Note**: In a region where `AWS::Logs::AccountPolicy` is not available, you can still deploy the function and update templates but will need to configure log subscriptions manually or use alternative approaches instead of the Account Policy template.

### Opt-in Region Support

This solution supports deployment to AWS opt-in regions (regions that require explicit opt-in before services can be deployed). Additional Lambda permissions are automatically configured through the CloudFormation templates to ensure proper cross-region functionality with Account Policies.

### Deployment Steps

Follow these steps to deploy the solution:

1. **Deploy the Role CloudFormation Template**: In `us-east-1` only, deploy the `role` CloudFormation template as a stack named `LambdaBasicExecutionRole`. Either provide no parameters to generate a role with basic CloudWatch Logs permissions, or provide the ARN of an existing Lambda role with permissions to write to CloudWatch Logs as `ExistingRole`. Function stacks in every region read the role from this stack's `ExportedRole` output with `Fn::GetStackOutput`. That reference does not stop the stack being deleted, so turn on termination protection:

   ```
   aws cloudformation update-termination-protection --enable-termination-protection --stack-name LambdaBasicExecutionRole --region us-east-1
   ```

2. **Deploy the Target CloudFormation Template**: In the `us-east-1` region, deploy the `target` CloudFormation template. This template deploys the Lambda function that will receive `INIT_START` log lines, the DynamoDB table for storing version ARNs, the EventBridge Pipeline, and the SNS topic for notifications.

3. **Deploy the Account Policy CloudFormation Template**: In each supported region (see Region Support section above), deploy the `accountpolicy` CloudFormation template, which creates subscriptions for all log groups in the region.

4. **Deploy the Function CloudFormation Template**: In each region for every runtime and architecture, deploy the `function` CloudFormation template, which deploys a function, a log group (to limit log retention), and a CloudWatch Event to trigger the function hourly. The function template accepts either the name of an existing function or an S3 location of a Lambda deployment ZIP (e.g. create a blank function using the AWS console, download the deployment ZIP, and upload it to S3). Functions it creates use the role from step 1 (pass `RoleStackName` if you named that stack differently) and carry the tag `runtime-version-poller`. If you pass an existing function in `MyFunctionParameter`, name it `<name>_x86_64` or `<name>_arm64` with no other `_` (or `target` ignores it), and tag it yourself so `update` refreshes it:

   ```
   aws lambda tag-resource --resource <function ARN> --tags runtime-version-poller=function --region <region>
   ```

5. **Deploy the Update CloudFormation Template**: In each region, deploy the `update` CloudFormation template. Every hour it updates each function in the region tagged `runtime-version-poller` (any value) with a timestamp, to ensure each function is part of the first phase of Lambda's runtime version updates. It touches no other function: its role may only update functions with that tag. Invoking it returns the names of the functions it updated.

### Handling Opt-in Regions During Deployment

When deploying to opt-in regions, follow these additional considerations:

1. **Enable Opt-in Regions**: Ensure all target opt-in regions are enabled in your AWS account before deployment
2. **Cross-Region Permissions**: The target function in `us-east-1` automatically receives the necessary permissions to process logs from opt-in regions through Lambda permissions configured in the CloudFormation templates
3. **Region-Specific Resources**: Each opt-in region requires its own deployment of the account policy, function, and update templates (the role stack stays in `us-east-1`)
4. **Validation**: After deployment, verify that functions in opt-in regions are successfully sending logs to the target function by checking the DynamoDB table for entries from those regions

## Upgrading from v1

### What changes for v1 users

- **`update` touches only tagged functions.** v1 updated every function in the region. v2 updates only functions tagged `runtime-version-poller`. The function template tags the functions it creates once their stacks are on v2. Functions you brought in with `MyFunctionParameter` are not tagged: tag them (step 2) or `update` stops refreshing them.
- **x86_64 is `x86_64` in DynamoDB.** v1 wrote x86_64 functions as `<runtime>_x86_<region>` with `arch` = `x86`. v2 writes `<runtime>_x86_64_<region>` with `arch` = `x86_64`. Anything that reads the table by key or by `arch` must change. Without the migration (step 4), each x86 runtime's history is split across two keys.
- **One role stack, in `us-east-1`.** Function stacks read the role with `Fn::GetStackOutput` from the `us-east-1` role stack (`RoleStackName`, default `LambdaBasicExecutionRole`). The role stack no longer exports `LambdaBasicExecutionRole`, and the role stacks in other regions are deleted. `MyRoleParameter` is gone: a function stack that passed it would get the role stack's role instead (see step 5).
- **me-central-1** is no longer granted access to `target` (like me-south-1 before it).

### Before you start

You need Node.js 18 or later, AWS CLI v2, and credentials for the account. The scripts in `migration/` use the AWS CLI and need no npm packages. Pass `--profile=<name>` to choose a profile, and `--regions=<r1,r2,...>` to list the regions you deployed to (the default, `all`, is every region enabled in the account; leave out any you cannot reach).

Every script is a dry run unless you add `--apply`: it prints what it would change and changes nothing. Each one skips work that is already done, so it is safe to run again.

Run the steps in this order. A step's undo is under it.

### Steps

1. **Back up the table.** Find its name, then take an on-demand backup:

   ```
   aws cloudformation describe-stack-resource --stack-name target --logical-resource-id MyDynamoDBTable --query StackResourceDetail.PhysicalResourceId --output text --region us-east-1
   aws dynamodb create-backup --table-name <table> --backup-name runtime-versions-v1 --region us-east-1
   ```

2. **Tag functions you brought in with `MyFunctionParameter`**, in each region (skip this if all your function stacks create their own function):

   ```
   aws lambda tag-resource --resource <function ARN> --tags runtime-version-poller=function --region <region>
   ```

3. **Update the target stack** in `us-east-1`:

   ```
   aws cloudformation deploy --stack-name target --template-file target.template.json --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --region us-east-1
   ```

   From now on `target` writes `x86_64` keys. For a version it already holds under the v1 key it writes nothing, so no version is announced twice; step 4 moves those items. Do this before step 4: the v2 pipe does not announce the migration's copies (they carry `migratedFrom`), but the v1 pipe would send every one to your SNS subscribers.
   Undo: deploy the v1 `target.template.json` the same way.

4. **Move the x86 history to the new keys:**

   ```
   node migration/migrate-table.js
   node migration/migrate-table.js --apply
   ```

   The first command prints how many items it would copy, how many already exist under the new key (it skips those) and how many v1 items it would delete. With `--apply` it copies each `<runtime>_x86_<region>` item to `<runtime>_x86_64_<region>` with `arch` = `x86_64`, then deletes the original, in one transaction per item. It refuses `--apply` until step 3 is done and the pipe was last updated at least 5 minutes ago (a pipe keeps its old filter for a short while after an update). Pass `--stack=<name>` if your target stack is not called `target`.
   Undo: restore the backup from step 1.

5. **Only if a function stack passed `MyRoleParameter`:** create a role stack for that role in `us-east-1`, then update those function stacks yourself with the v2 `function.template.json` and `RoleStackName=<that stack>`. Step 6 lists them under `usesMyRoleParameter` and leaves them alone.

   ```
   aws cloudformation deploy --stack-name <name> --template-file role.template.json --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ExistingRole=<role ARN> --region us-east-1
   aws cloudformation update-termination-protection --enable-termination-protection --stack-name <name> --region us-east-1
   ```

6. **Move the function stacks to the `us-east-1` role:**

   ```
   node migration/migrate-roles.js --step=functions --regions=<regions>
   node migration/migrate-roles.js --step=functions --regions=<regions> --apply
   ```

   This updates every function stack that imports `LambdaBasicExecutionRole` to the v2 `function.template.json`. It keeps each stack's parameters and sets `RoleStackName` to the `us-east-1` stack that exports the role (or `--role-stack=<name>`). The functions keep the same role and gain the tag. It needs a role stack in `us-east-1`: if you had none there, deploy one first as in step 1 of [Deployment Steps](#deployment-steps), with `ExistingRole` set to your role's ARN. Stacks other than function stacks that import the export are listed under `otherImporters`; change them yourself, or step 9 keeps that region's role stack.
   Undo: update the stack with the v1 `function.template.json`.

7. **Update the `us-east-1` role stack:**

   ```
   node migration/migrate-roles.js --step=role
   node migration/migrate-roles.js --step=role --apply
   ```

   This updates the role stack to the v2 `role.template.json`, which drops the export, and turns on termination protection. It refuses while any stack in `us-east-1` still imports the export.
   Undo: deploy the v1 `role.template.json` to that stack.

8. **Update the update stack** in each region:

   ```
   aws cloudformation deploy --stack-name update --template-file update.template.json --capabilities CAPABILITY_IAM --region <region>
   aws lambda invoke --function-name update update.json --region <region>
   ```

   `update.json` lists the functions it updated: your poller functions, and nothing else.
   Undo: deploy the v1 `update.template.json` the same way.

9. **Delete the role stacks outside `us-east-1`:**

   ```
   node migration/migrate-roles.js --step=cleanup --regions=<regions>
   node migration/migrate-roles.js --step=cleanup --regions=<regions> --apply
   ```

   In each region it deletes the stack that exports `LambdaBasicExecutionRole`, but only when no stack imports that export. It never deletes a role stack that owns the IAM role (one deployed without `ExistingRole`): every region uses that role, so update that stack with the v2 `role.template.json` instead, which drops its export and keeps the role.
   Undo: deploy the v1 `role.template.json` in that region with `ExistingRole=<role ARN>`.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

