# Changelog

## v2.0.2 (2026-11-09)

- `update` runs on `nodejs24.x`. `nodejs20.x` was deprecated on 30 Apr 2026.
- `target`'s role may only `GetItem` and `PutItem` on the table, the two calls its code makes. Update the target stack to drop the unused `UpdateItem`, `DeleteItem`, `Scan` and `Query`.

## v2.0.1 (2026-11-06)

- `target` ignores functions whose name does not end in `_x86_64` or `_arm64`. The account log policy sends it every function's `INIT_START`, and v2.0.0 stored a function with no `_` in its name under an empty arch (`<runtime>__<region>`) and announced it.
- `target` no longer copies a version it holds under a v1 key; it writes nothing, and `migration/migrate-table.js` moves the item. A pipe keeps its old filter for a short while after an update, so a copy made just after step 3 of the upgrade could be announced.
- `migration/migrate-table.js --apply` refuses to run until the pipe was last updated at least 5 minutes ago.
- If you run v2.0.0, update the target stack. Then list any items whose `arch` is not `x86_64`, `arm64` or (v1, not yet migrated) `x86`, and delete them with `aws dynamodb delete-item`:

  ```
  aws dynamodb scan --table-name <table> --filter-expression "NOT (arch IN (:a, :b, :c))" --expression-attribute-values '{":a":{"S":"x86_64"},":b":{"S":"arm64"},":c":{"S":"x86"}}' --projection-expression "pk, sk" --region us-east-1
  ```

## v2.0.0 (2026-11-05)

Breaking changes. If you run v1, follow [Upgrading from v1](README.md#upgrading-from-v1) in the README, in order.

- `update` updates only functions tagged `runtime-version-poller`, not every function in the region. The function template tags the functions it creates. Tag functions you bring in with `MyFunctionParameter` yourself. The `update` role may only update tagged functions, and the function returns the names it updated.
- DynamoDB: x86_64 functions are stored as `<runtime>_x86_64_<region>` with `arch` = `x86_64` (v1: `<runtime>_x86_<region>`, `x86`). `target` copies a version it already holds under the v1 key instead of announcing it again, and the pipe no longer announces items with `migratedFrom`.
- One role stack, in `us-east-1`. Function stacks read its `ExportedRole` output with `Fn::GetStackOutput`. The role template no longer exports `LambdaBasicExecutionRole`. In the function template, `RoleStackName` (default `LambdaBasicExecutionRole`) replaces `MyRoleParameter`, and the `UseExportedRole` condition is gone. Turn on termination protection for the role stack.
- `target` no longer grants me-central-1 permission to deliver logs. Neither me-central-1 nor me-south-1 is supported.
- New: `migration/migrate-table.js` moves v1 x86 items to the v2 keys, and `migration/migrate-roles.js` moves function stacks to the `us-east-1` role and deletes the regional role stacks.

## v1

The templates up to commit `8862da9`: a role stack in every region exporting `LambdaBasicExecutionRole`, x86_64 stored as `x86`, and `update` touching every function in the region.
