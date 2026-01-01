# AWS Lambda Runtime Version Notification

This repository showcases a serverless solution for generating notifications whenever new AWS Lambda runtime versions become available. The implementation leverages multiple AWS services, including Lambda, CloudWatch Events, CloudWatch Logs, DynamoDB, EventBridge Pipelines and Simple Notification Service (SNS).

## Overview

The core functionality is achieved through a set of Lambda functions, one for each supported runtime and architecture. These functions are triggered hourly via CloudWatch Events and log their runtime version to CloudWatch Logs using the `INIT_START` log line.

CloudWatch Logs is configured with an Account Policy that subscribes to the `INIT_START` log line. Whenever a new log entry is detected, a target function extracts the latest runtime version information and stores it in a DynamoDB table.

EventBridge Pipelines monitors the DynamoDB table for new entries (create events). When a new entry is detected, EventBridge Pipelines triggers an SNS notification, alerting subscribers about the availability of a new Lambda runtime version.

## Supported Runtime and Architecture Combinations

The following runtime and architecture combinations are currently supported by the CloudFormation templates:

| Runtime | Architecture | Status |
|---------|-------------|---------|
| dotnet6 | arm64, x86_64 | ✅ Supported |
| dotnet8 | arm64, x86_64 | ✅ Supported |
| java8.al2 | arm64, x86_64 | ✅ Supported |
| java11 | arm64, x86_64 | ✅ Supported |
| java17 | arm64, x86_64 | ✅ Supported |
| java21 | arm64, x86_64 | ✅ Supported |
| java25 | arm64, x86_64 | ✅ Supported |
| nodejs16.x | arm64, x86_64 | ✅ Supported |
| nodejs18.x | arm64, x86_64 | ✅ Supported |
| nodejs20.x | arm64, x86_64 | ✅ Supported |
| nodejs22.x | arm64, x86_64 | ✅ Supported |
| nodejs24.x | arm64, x86_64 | ✅ Supported |
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
| provided.al2 | arm64, x86_64 | ✅ Supported |
| provided.al2023 | arm64, x86_64 | ✅ Supported |

**Note**: All runtimes listed above are defined in the CloudFormation templates. For deployment, you can either create functions using the AWS console and provide the function name, or upload deployment packages to S3 and reference them in the template parameters.

## Deployment

**WARNING!** This example leverages CloudWatch Logs Account Policy subscription filters. This will create a subscription filter for **ALL** log groups in the region where the policy is deployed. It is recommended to deploy this example in a dedicated AWS account for this workload.

### Region Support

This solution supports deployment to most AWS regions. However, the Account Policy CloudFormation resource (`AWS::Logs::AccountPolicy`) is not available in all regions.

#### Regions with Limited Support (4 regions)

The following regions do not support the Account Policy CloudFormation resource and require alternative deployment approaches:

- **ap-east-2** (Asia Pacific - Hong Kong SAR)
- **mx-central-1** (North America - Mexico)
- **ap-southeast-6** (Asia Pacific - Malaysia)
- **ap-southeast-7** (Asia Pacific - Thailand)

**Note**: For regions with limited support, you can still deploy the other components (role, target, function, update templates) but will need to configure log subscriptions manually or use alternative approaches instead of the Account Policy template.

### Opt-in Region Support

This solution supports deployment to AWS opt-in regions (regions that require explicit opt-in before services can be deployed). Additional Lambda permissions are automatically configured through the CloudFormation templates to ensure proper cross-region functionality with Account Policies.

### Deployment Steps

Follow these steps to deploy the solution:

1. **Deploy the Role CloudFormation Template**: In each region, first deploy the `role` CloudFormation template. Either provide no parameters to generate a role with basic CloudWatch Logs permissions, or provide the ARN of an existing Lambda role with permissions to write to CloudWatch Logs.

2. **Deploy the Target CloudFormation Template**: In the `us-east-1` region, deploy the `target` CloudFormation template. This template deploys the Lambda function that will receive `INIT_START` log lines, the DynamoDB table for storing version ARNs, the EventBridge Pipeline, and the SNS topic for notifications.

3. **Deploy the Account Policy CloudFormation Template**: In each supported region (see Region Support section above), deploy the `accountpolicy` CloudFormation template, which creates subscriptions for all log groups in the region.

4. **Deploy the Function CloudFormation Template**: In each region for every runtime and architecture, deploy the `function` CloudFormation template, which deploys a function, a log group (to limit log retention), and a CloudWatch Event to trigger the function hourly. The function template accepts either the name of an existing function or an S3 location of a Lambda deployment ZIP (e.g. create a blank function using the AWS console, download the deployment ZIP, and upload it to S3).

5. **Deploy the Update CloudFormation Template**: In each region, deploy the `update` CloudFormation template, which updates each function in the region with a timestamp to ensure each function is part of the first phase of Lambda's runtime version updates.

### Handling Opt-in Regions During Deployment

When deploying to opt-in regions, follow these additional considerations:

1. **Enable Opt-in Regions**: Ensure all target opt-in regions are enabled in your AWS account before deployment
2. **Cross-Region Permissions**: The target function in `us-east-1` automatically receives the necessary permissions to process logs from opt-in regions through Lambda permissions configured in the CloudFormation templates
3. **Region-Specific Resources**: Each opt-in region requires its own deployment of the role, account policy, function, and update templates
4. **Validation**: After deployment, verify that functions in opt-in regions are successfully sending logs to the target function by checking the DynamoDB table for entries from those regions

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

