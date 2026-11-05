// Shared by the v1 -> v2 migration scripts. They call the AWS CLI v2, so they need
// Node.js 18 or later and no npm packages. Credentials come from the usual AWS CLI
// chain; pass --profile=<name> to pick a profile.
const { execFile } = require('node:child_process');

const HOME_REGION = 'us-east-1';
const EXPORT_NAME = 'LambdaBasicExecutionRole';

// --key=value and --flag arguments
const parseArgs = (argv = process.argv.slice(2)) => Object.fromEntries(argv.map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
}));

const opts = parseArgs();

// Runs `aws <args> --region <region>` and returns parsed JSON (or text when json is false).
const aws = (region, args, { json = true, timeout = 900000 } = {}) => new Promise((resolve, reject) => {
    const argv = [...args, '--region', region];
    if (opts.profile) argv.push('--profile', opts.profile);
    if (json) argv.push('--output', 'json');
    execFile('aws', argv, { env: { ...process.env, AWS_PAGER: '' }, timeout, maxBuffer: 512 << 20 }, (err, stdout, stderr) => {
        if (err) {
            const e = new Error(`[${region}] aws ${args.slice(0, 2).join(' ')}: ${(stderr || err.message).trim()}`);
            e.stderr = stderr || '';
            return reject(e);
        }
        resolve(json && stdout.trim() ? JSON.parse(stdout) : stdout);
    });
});

// Runs fn over items with at most `limit` in flight. Never rejects; returns
// { item, value } or { item, error } per item, in input order.
const pool = async (items, limit, fn) => {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            try {
                results[i] = { item: items[i], value: await fn(items[i]) };
            } catch (error) {
                results[i] = { item: items[i], error: error.message };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
};

const account = async () => (await aws(HOME_REGION, ['sts', 'get-caller-identity'])).Account;

// --regions=all (every region enabled in the account) or a comma-separated list
const resolveRegions = async (arg = 'all') => {
    if (arg !== 'all') return arg.split(',').filter(Boolean);
    const { Regions } = await aws(HOME_REGION, ['ec2', 'describe-regions']);
    return Regions.map((r) => r.RegionName).sort();
};

// Names of the stacks that import `exportName` in `region` ([] when none, or no such export)
const importers = async (region, exportName = EXPORT_NAME) => {
    try {
        const { Imports = [] } = await aws(region, ['cloudformation', 'list-imports', '--export-name', exportName]);
        return Imports;
    } catch (e) {
        if (/is not imported by any stack|does not exist/i.test(e.stderr)) return [];
        throw e;
    }
};

// The stack that exports `exportName` in `region`, or undefined
const exporter = async (region, exportName = EXPORT_NAME) => {
    const { Exports = [] } = await aws(region, ['cloudformation', 'list-exports']);
    const found = Exports.find((x) => x.Name === exportName);
    return found && found.ExportingStackId.split('/')[1];
};

const print = (report) => console.log(JSON.stringify(report, null, 2));

module.exports = { HOME_REGION, EXPORT_NAME, opts, aws, pool, account, resolveRegions, importers, exporter, print };
