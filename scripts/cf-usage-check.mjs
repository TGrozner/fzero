// Daily Cloudflare consumption check. Queries the GraphQL Analytics API for
// the last 24 h of Worker invocations and Durable Object requests, sums them
// against the Workers free tier (100 k requests/day total), and writes a
// summary to stdout. The wrapping GH Actions workflow decides whether to
// open an issue based on the threshold output.
//
// Required env:
//   CLOUDFLARE_API_TOKEN    — token with "Account Analytics: Read"
//   CLOUDFLARE_ACCOUNT_ID   — 32-char account hash
//
// Optional env:
//   THRESHOLD_PERCENT       — alert above this percent (default 80)
//
// Output: a single JSON object on stdout, e.g.
//   {"window":"24h","totalRequests":2665,"limitDaily":100000,"percent":2.7,
//    "alert":false,"breakdown":{"workers":[…],"durableObjects":[…]}}

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID;
const THRESHOLD = Number(process.env.THRESHOLD_PERCENT ?? 80);
const LIMIT_DAILY = 100_000; // Workers free tier (req/day, includes DO)

if (!TOKEN || !ACCT) {
  console.error('Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID');
  process.exit(2);
}

const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const until = new Date().toISOString();

const query = `
  query($a: string!, $s: Time!, $e: Time!) {
    viewer {
      accounts(filter: { accountTag: $a }) {
        workersInvocationsAdaptive(
          filter: { datetime_geq: $s, datetime_leq: $e }
          limit: 100
          orderBy: [sum_requests_DESC]
        ) {
          sum { requests subrequests errors }
          dimensions { scriptName }
        }
        durableObjectsInvocationsAdaptiveGroups(
          filter: { datetime_geq: $s, datetime_leq: $e }
          limit: 100
          orderBy: [sum_requests_DESC]
        ) {
          sum { requests }
          dimensions { scriptName }
        }
      }
    }
  }
`;

const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query,
    variables: { a: ACCT, s: since, e: until },
  }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`Cloudflare API returned ${res.status}: ${body.slice(0, 200)}`);
  console.error(
    'If 401/403, re-issue CLOUDFLARE_API_TOKEN with the "Account Analytics: Read" permission.',
  );
  process.exit(1);
}

const json = await res.json();
if (json.errors) {
  console.error('GraphQL errors:', JSON.stringify(json.errors));
  process.exit(1);
}

const account = json.data?.viewer?.accounts?.[0];
if (!account) {
  console.error('No account data returned — check CLOUDFLARE_ACCOUNT_ID matches the token scope.');
  process.exit(1);
}

const workers = (account.workersInvocationsAdaptive ?? []).map((row) => ({
  scriptName: row.dimensions.scriptName,
  requests: row.sum.requests,
  subrequests: row.sum.subrequests,
  errors: row.sum.errors,
}));
const durableObjects = (account.durableObjectsInvocationsAdaptiveGroups ?? []).map((row) => ({
  scriptName: row.dimensions.scriptName,
  requests: row.sum.requests,
}));

const totalWorkers = workers.reduce((s, r) => s + r.requests, 0);
const totalDO = durableObjects.reduce((s, r) => s + r.requests, 0);
const totalRequests = totalWorkers + totalDO;
const percent = (totalRequests / LIMIT_DAILY) * 100;

console.log(
  JSON.stringify(
    {
      window: '24h',
      windowStart: since,
      windowEnd: until,
      totalRequests,
      totalWorkers,
      totalDurableObjects: totalDO,
      limitDaily: LIMIT_DAILY,
      percent: Number(percent.toFixed(2)),
      threshold: THRESHOLD,
      alert: percent >= THRESHOLD,
      breakdown: { workers, durableObjects },
    },
    null,
    2,
  ),
);
