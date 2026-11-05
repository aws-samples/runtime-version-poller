// v1 -> v2 role migration. v1 has a role stack in every region that exports
// `LambdaBasicExecutionRole`, and function stacks import it. v2 keeps one role stack, in
// us-east-1, and function stacks read its `ExportedRole` output with Fn::GetStackOutput.
// Three steps, in this order:
//   1. functions  update every function stack that imports the export to the v2 function
//                 template, keeping its parameters and setting RoleStackName
//   2. role       update the us-east-1 role stack to the v2 role template (no Export) once
//                 nothing imports it, and turn on termination protection
//   3. cleanup    delete the role stacks in other regions, only when nothing imports their
//                 export and they do not own the IAM role
//
//   node migration/migrate-roles.js [--regions=all|r1,r2] [--step=all|functions|role|cleanup]
//                                   [--role-stack=<us-east-1 role stack>] [--profile=<name>] [--apply]
//
// Without --apply it changes nothing and prints what each step would do. Safe to run
// again: finished work is skipped.
const fs = require('node:fs');
const path = require('node:path');
const { HOME_REGION, EXPORT_NAME, opts, aws, pool, account, resolveRegions, importers, exporter, print } = require('./lib');

const REPO = path.resolve(__dirname, '..');
const apply = Boolean(opts.apply);
const step = opts.step || 'all';
const runs = (s) => step === 'all' || step === s;
const FUNCTION_TEMPLATE = path.join(REPO, 'function.template.json');
const ROLE_TEMPLATE = path.join(REPO, 'role.template.json');
const V2_FUNCTION_PARAMS = Object.keys(JSON.parse(fs.readFileSync(FUNCTION_TEMPLATE, 'utf8')).Parameters);

const describe = async (region, name) => {
    const { Stacks: [stack] } = await aws(region, ['cloudformation', 'describe-stacks', '--stack-name', name]);
    return stack;
};
const param = (stack, k) => stack.Parameters?.find((p) => p.ParameterKey === k)?.ParameterValue;
const isFunctionStack = (stack) => param(stack, 'MyRuntimeParameter') !== undefined;
const isRoleStack = (stack) => param(stack, 'ExistingRole') !== undefined && stack.Outputs?.some((o) => o.OutputKey === 'ExportedRole');

const waitFor = (region, name, what) => aws(region, ['cloudformation', 'wait', what, '--stack-name', name], { json: false, timeout: 1800000 });

// Step 1, one region: update the function stacks that import the export
const migrateFunctions = async (region, roleStack) => {
    const out = { region, update: [], updated: [], otherImporters: [], usesMyRoleParameter: [] };
    const { Stacks = [] } = await aws(region, ['cloudformation', 'describe-stacks']);
    // v1 stacks given MyRoleParameter do not import the export. v2 gives them the role stack's role
    // instead, so they are left for you: see "Upgrading from v1" in the README.
    out.usesMyRoleParameter = Stacks.filter((s) => isFunctionStack(s) && param(s, 'MyRoleParameter'))
        .map((s) => `${s.StackName} (${param(s, 'MyRoleParameter')})`);
    const byName = new Map(Stacks.map((s) => [s.StackName, s]));
    for (const name of await importers(region)) {
        const stack = byName.get(name);
        if (stack && isFunctionStack(stack)) out.update.push(name);
        else out.otherImporters.push(name);
    }
    if (!apply) return out;
    const results = await pool(out.update, 4, async (name) => {
        const stack = byName.get(name);
        const params = V2_FUNCTION_PARAMS.filter((k) => k !== 'RoleStackName' && param(stack, k) !== undefined)
            .map((k) => `ParameterKey=${k},UsePreviousValue=true`);
        params.push(`ParameterKey=RoleStackName,ParameterValue=${roleStack}`);
        await aws(region, ['cloudformation', 'update-stack', '--stack-name', name,
            '--template-body', `file://${FUNCTION_TEMPLATE}`, '--parameters', ...params]);
        await waitFor(region, name, 'stack-update-complete');
        return name;
    });
    out.updated = results.filter((r) => r.value).map((r) => r.value);
    out.errors = results.filter((r) => r.error).map((r) => r.error);
    return out;
};

// Step 2: the us-east-1 role stack
const migrateRole = async (roleStack) => {
    const out = { stack: roleStack };
    const stack = await describe(HOME_REGION, roleStack);
    const stillExports = (await exporter(HOME_REGION)) === roleStack;
    const blockers = stillExports ? await importers(HOME_REGION) : [];
    out.exports = stillExports;
    out.importers = blockers;
    out.terminationProtection = Boolean(stack.EnableTerminationProtection);
    if (!apply) {
        out.action = !stillExports ? 'already v2' : blockers.length
            ? `update after step 1 moves its ${blockers.length} importers` : 'update to the v2 role template';
        if (!out.terminationProtection) out.action += '; turn on termination protection';
        return out;
    }
    if (stillExports) {
        if (blockers.length) throw new Error(`Refusing to update ${roleStack}: ${blockers.length} stacks in ${HOME_REGION} still import ${EXPORT_NAME} (${blockers.slice(0, 5).join(', ')}...). Run step functions first.`);
        await aws(HOME_REGION, ['cloudformation', 'update-stack', '--stack-name', roleStack,
            '--template-body', `file://${ROLE_TEMPLATE}`, '--capabilities', 'CAPABILITY_NAMED_IAM',
            '--parameters', 'ParameterKey=ExistingRole,UsePreviousValue=true']);
        await waitFor(HOME_REGION, roleStack, 'stack-update-complete');
        out.action = 'updated';
        out.exports = false;
    } else {
        out.action = 'already v2';
    }
    if (!out.terminationProtection) {
        await aws(HOME_REGION, ['cloudformation', 'update-termination-protection', '--stack-name', roleStack, '--enable-termination-protection']);
        out.terminationProtection = true;
    }
    return out;
};

// Step 3, one region: delete the role stack that exports the name, if it is safe
const cleanupRegion = async (region) => {
    const name = await exporter(region);
    if (!name) return { region, action: 'none: no role stack exports the name' };
    const stack = await describe(region, name);
    if (!isRoleStack(stack)) return { region, stack: name, action: `refused: ${name} is not a role stack` };
    if (!param(stack, 'ExistingRole')) {
        return { region, stack: name, action: 'refused: it owns the IAM role, which every region uses. Update it with role.template.json (drops the export) and keep it' };
    }
    if (stack.EnableTerminationProtection) return { region, stack: name, action: 'refused: termination protection is on' };
    const using = await importers(region);
    if (using.length) {
        // A dry run of every step: the function stacks step 1 would move do not count
        if (!apply && runs('functions')) {
            const { Stacks = [] } = await aws(region, ['cloudformation', 'describe-stacks']);
            const functionStacks = new Set(Stacks.filter(isFunctionStack).map((s) => s.StackName));
            if (using.every((s) => functionStacks.has(s))) {
                return { region, stack: name, action: `delete, once step functions moves its ${using.length} importers` };
            }
        }
        return { region, stack: name, action: `refused: ${using.length} stacks still import it (${using.slice(0, 3).join(', ')})` };
    }
    if (!apply) return { region, stack: name, action: 'delete' };
    // CloudFormation also refuses to delete an export that is in use; check once more just before
    if ((await importers(region)).length) return { region, stack: name, action: 'refused: a stack started importing it' };
    await aws(region, ['cloudformation', 'delete-stack', '--stack-name', stack.StackId], { json: false });
    await waitFor(region, stack.StackId, 'stack-delete-complete');
    return { region, stack: name, action: 'deleted' };
};

// The us-east-1 role stack: the one that exports the name (before step 2), else the only role
// stack there (after it). Pass --role-stack=<name> when there are several.
const findRoleStack = async () => {
    const exporting = await exporter(HOME_REGION);
    if (exporting) return exporting;
    const { Stacks = [] } = await aws(HOME_REGION, ['cloudformation', 'describe-stacks']);
    const roleStacks = Stacks.filter((s) => !s.StackStatus.startsWith('DELETE') && isRoleStack(s)).map((s) => s.StackName);
    if (roleStacks.length === 1) return roleStacks[0];
    if (!roleStacks.length) return EXPORT_NAME;
    throw new Error(`Several role stacks in ${HOME_REGION} (${roleStacks.join(', ')}): pass --role-stack=<name>`);
};

const main = async () => {
    const regions = await resolveRegions(opts.regions);
    const roleStack = opts['role-stack'] || await findRoleStack();
    const report = { account: await account(), applied: apply, step, roleStack };
    let failed = false;

    if (runs('functions')) {
        const results = await pool(regions, 8, (region) => migrateFunctions(region, roleStack));
        const ok = results.filter((r) => r.value).map((r) => r.value);
        report.functions = {
            toUpdate: ok.reduce((n, r) => n + r.update.length, 0),
            updated: ok.reduce((n, r) => n + r.updated.length, 0),
            regions: ok.filter((r) => r.update.length).map((r) => `${r.region}: ${r.update.length}`),
            otherImporters: ok.flatMap((r) => r.otherImporters.map((s) => `${r.region} ${s}`)),
            usesMyRoleParameter: ok.flatMap((r) => r.usesMyRoleParameter.map((s) => `${r.region} ${s}`)),
            errors: [...results.filter((r) => r.error).map((r) => r.error), ...ok.flatMap((r) => r.errors || [])],
        };
        // A dry run reports every step; --apply stops at the first step that failed
        failed ||= apply && report.functions.errors.length > 0;
    }
    if (runs('role') && !failed) {
        try {
            report.role = await migrateRole(roleStack);
        } catch (e) {
            report.role = { stack: roleStack, error: e.message };
            failed = apply;
        }
    }
    if (runs('cleanup') && !failed) {
        const results = await pool(regions.filter((r) => r !== HOME_REGION), 8, cleanupRegion);
        const rows = results.map((r) => r.error ? { region: r.item, action: `error: ${r.error}` } : r.value);
        report.cleanup = {
            delete: rows.filter((r) => r.action.startsWith('delete')).map((r) => `${r.region} ${r.stack} (${r.action})`),
            refused: rows.filter((r) => r.action.startsWith('refused') || r.action.startsWith('error')).map((r) => `${r.region} ${r.stack || ''}: ${r.action}`),
            none: rows.filter((r) => r.action.startsWith('none')).length,
        };
        failed ||= results.some((r) => r.error);
    }
    const errors = failed || Boolean(report.functions?.errors.length || report.role?.error || report.cleanup?.refused.some((r) => r.includes(': error:')));
    const kept = report.cleanup?.refused.length;
    report.next = apply ? (failed ? 'Stopped on an error; fix it and run again (finished work is skipped).'
        : kept ? `Done, but kept ${kept} role stacks: see cleanup.refused.` : 'Done.')
        : `Dry run: nothing changed.${errors ? ' Fix the errors above (or leave unreachable regions out of --regions), then' : ''} Run again with --apply.`;
    print(report);
    process.exit(errors ? 1 : 0);
};

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
