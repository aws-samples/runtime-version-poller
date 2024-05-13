# AWS Lambda Runtime Version Notification

This repository showcases a serverless solution for generating notifications whenever new AWS Lambda runtime versions become available. The implementation leverages multiple AWS services, including Lambda, CloudWatch Events, CloudWatch Logs, DynamoDB, EventBridge Pipelines and Simple Notification Service (SNS).

## Overview

The core functionality is achieved through a set of Lambda functions, one for each supported runtime and architecture. These functions are triggered hourly via CloudWatch Events and log their runtime version to CloudWatch Logs using the `INIT_START` log line.

CloudWatch Logs is configured with an Account Policy that subscribes to the `INIT_START` log line. Whenever a new log entry is detected, a target function extracts the latest runtime version information and stores it in a DynamoDB table.

EventBridge Pipelines monitors the DynamoDB table for new entries (create events). When a new entry is detected, EventBridge Pipelines triggers an SNS notification, alerting subscribers about the availability of a new Lambda runtime version.

## Deployment

**WARNING!** This example leverages CloudWatch Logs Account Policy subscription filters. This will create a subscription filter for **ALL** log groups in the region where the policy is deployed. It is recommended to deploy this example in a dedicated AWS account for this workload.

Follow these steps to deploy the solution:

1. **Deploy the Role CloudFormation Template**: In each region, first deploy the `role` CloudFormation template. Either provide no parameters to generate a role with basic CloudWatch Logs permissions, or provide the ARN of an existing Lambda role with permissions to write to CloudWatch Logs.

2. **Deploy the Target CloudFormation Template**: In the `us-east-1` region, deploy the `target` CloudFormation template. This template deploys the Lambda function that will receive `INIT_START` log lines, the DynamoDB table for storing version ARNs, the EventBridge Pipeline, and the SNS topic for notifications.

3. **Deploy the Account Policy CloudFormation Template**: In each region, deploy the `accountpolicy` CloudFormation template, which creates subscriptions for all log groups in the region.

4. **Deploy the Function CloudFormation Template**: In each region for every runtime and architecture, deploy the `function` CloudFormation template, which deploys a function, a log group (to limit log retention), and a CloudWatch Event to trigger the function hourly. The function template accepts either the name of an existing function or an S3 location of a Lambda deployment ZIP (e.g. create a blank function using the AWS console, download the deployment ZIP, and upload it to S3).

5. **Deploy the Update CloudFormation Template**: In each region, deploy the `update` CloudFormation template, which updates each function in the region with a timestamp to ensure each function is part of the first phase of Lambda's runtime version updates.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

