// v1 -> v2 DynamoDB migration. v1 keyed x86_64 functions as `<runtime>_x86_<region>` with
// arch `x86`; v2 uses `<runtime>_x86_64_<region>` and `x86_64`. This copies every v1 x86
// item to the v2 key (arch x86_64, plus `migratedFrom` = the v1 key, which the v2 pipe
// does not announce), skips items already stored under the v2 key, then deletes the v1
// originals. Each item's copy and delete happen in one transaction.
//
//   node migration/migrate-table.js [--stack=target] [--region=us-east-1] [--table=<name>] [--profile=<name>] [--apply]
//
// Without --apply it changes nothing and prints the counts. --apply refuses to run until
// the target stack is on v2 (its pipe filter skips `migratedFrom`), so copies never reach
// SNS subscribers. Safe to run again: a second run finds nothing to do.
const { opts, aws, pool, account, print } = require('./lib');

const region = opts.region || 'us-east-1';
const stack = opts.stack || 'target';
const apply = Boolean(opts.apply);

// pk is `<runtime>_<arch>_<region>`; a region has no underscore. `python3.12_x86_64_us-east-1`
// does not match (64_us-east-1 has one).
const V1_KEY = /_x86_([^_]+)$/;
const v2Key = (pk) => pk.replace(V1_KEY, '_x86_64_$1');

const physicalId = async (logicalId) => {
    const { StackResourceDetail } = await aws(region, ['cloudformation', 'describe-stack-resource',
        '--stack-name', stack, '--logical-resource-id', logicalId]);
    return StackResourceDetail.PhysicalResourceId;
};

const scan = async (table) => {
    const { Items = [] } = await aws(region, ['dynamodb', 'scan', '--table-name', table, '--consistent-read']);
    return Items;
};

const key = (pk, sk) => ({ pk: { S: pk }, sk: { S: sk } });
const exists = 'attribute_exists(pk)';

// The two actions that move one item: copy it (or check the copy is there), then delete the original
const actions = (table, item, copyExists) => {
    const pk = item.pk.S;
    const newPk = v2Key(pk);
    const first = copyExists
        ? { ConditionCheck: { TableName: table, Key: key(newPk, item.sk.S), ConditionExpression: exists } }
        : {
            Put: {
                TableName: table,
                Item: { ...item, pk: { S: newPk }, arch: { S: 'x86_64' }, migratedFrom: { S: pk } },
                ConditionExpression: 'attribute_not_exists(pk)',
            },
        };
    return [first, { Delete: { TableName: table, Key: key(pk, item.sk.S), ConditionExpression: exists } }];
};

const transact = (items) => aws(region, ['dynamodb', 'transact-write-items', '--transact-items', JSON.stringify(items)], { json: false });

// One item on its own, re-reading both keys first: used when a batch transaction was cancelled
// (for example `target` copied one of its items a moment earlier).
const moveOne = async (table, item) => {
    const get = (pk) => aws(region, ['dynamodb', 'get-item', '--table-name', table, '--consistent-read',
        '--key', JSON.stringify(key(pk, item.sk.S))]);
    const original = await get(item.pk.S);
    if (!original?.Item) return 'gone';
    const copy = await get(v2Key(item.pk.S));
    await transact(actions(table, original.Item, Boolean(copy?.Item)));
    return copy?.Item ? 'deleted' : 'copied';
};

const main = async () => {
    const table = opts.table || await physicalId('MyDynamoDBTable');
    const pipeName = await physicalId('MyEventBridgePipe');
    const { SourceParameters } = await aws(region, ['pipes', 'describe-pipe', '--name', pipeName]);
    const filters = (SourceParameters?.FilterCriteria?.Filters || []).map((f) => f.Pattern);
    const pipeSkipsCopies = filters.length > 0 && filters.every((p) => p.includes('migratedFrom'));

    const items = await scan(table);
    const present = new Set(items.map((i) => `${i.pk.S}|${i.sk.S}`));
    const v1Items = items.filter((i) => V1_KEY.test(i.pk.S));
    const toCopy = v1Items.filter((i) => !present.has(`${v2Key(i.pk.S)}|${i.sk.S}`));
    const report = {
        account: await account(),
        region,
        table,
        pipe: pipeName,
        pipeSkipsCopies,
        items: items.length,
        v1Items: v1Items.length,
        toCopy: toCopy.length,
        alreadyUnderV2Key: v1Items.length - toCopy.length,
        toDelete: v1Items.length,
        examples: v1Items.slice(0, 3).map((i) => `${i.pk.S} -> ${v2Key(i.pk.S)} (sk ${i.sk.S})`),
        applied: false,
    };

    if (!apply) {
        report.next = v1Items.length ? 'Dry run: nothing changed. Run again with --apply to migrate.' : 'Nothing to migrate.';
        return print(report);
    }
    if (!v1Items.length) {
        report.next = 'Nothing to migrate.';
        return print(report);
    }
    if (!pipeSkipsCopies) {
        report.next = `Refusing --apply: pipe ${pipeName} would announce every copy. Update the ${stack} stack to v2 first.`;
        print(report);
        process.exit(1);
    }

    // 50 items x 2 actions = 100, the TransactWriteItems limit
    const batches = [];
    for (let i = 0; i < v1Items.length; i += 50) batches.push(v1Items.slice(i, i + 50));
    const counts = { copied: 0, deleted: 0, gone: 0 };
    const errors = [];
    await pool(batches, 4, async (batch) => {
        try {
            await transact(batch.flatMap((item) => actions(table, item, present.has(`${v2Key(item.pk.S)}|${item.sk.S}`))));
            for (const item of batch) counts[present.has(`${v2Key(item.pk.S)}|${item.sk.S}`) ? 'deleted' : 'copied']++;
        } catch (e) {
            if (!/TransactionCanceledException/.test(e.stderr)) throw e;
            for (const item of batch) {
                try {
                    counts[await moveOne(table, item)]++;
                } catch (err) {
                    errors.push(`${item.pk.S} ${item.sk.S}: ${err.message.slice(0, 300)}`);
                }
            }
        }
    }).then((results) => results.filter((r) => r.error).forEach((r) => errors.push(r.error.slice(0, 300))));

    const remaining = (await scan(table)).filter((i) => V1_KEY.test(i.pk.S)).length;
    Object.assign(report, {
        applied: true,
        copied: counts.copied,
        deletedWithCopyAlreadyThere: counts.deleted,
        alreadyGone: counts.gone,
        remainingV1Items: remaining,
        errors,
        next: remaining || errors.length ? 'Some items did not move. Run again; it is safe to repeat.' : 'Done.',
    });
    print(report);
    process.exit(remaining || errors.length ? 1 : 0);
};

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
