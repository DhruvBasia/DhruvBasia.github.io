// Snapshots a GitHub profile into data/github.json so the portfolio can show
// the contribution heatmap, repos and language mix without visitors leaving the page
// and without hitting GitHub's unauthenticated rate limit (60 req/hr/IP).
//
// Usage:  GITHUB_TOKEN=xxx node scripts/fetch-github.mjs [login]
// In CI:  runs on a cron in .github/workflows/refresh-github.yml

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGIN = process.argv[2] || process.env.GH_LOGIN || 'DhruvBasia';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) {
  console.error('GITHUB_TOKEN is required (a classic token with no scopes, or the Actions GITHUB_TOKEN, is enough for public data).');
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(root, 'data', 'github.json');

const QUERY = `
query($login: String!) {
  user(login: $login) {
    login name bio company location avatarUrl url createdAt
    followers { totalCount }
    following { totalCount }
    pinnedItems(first: 6, types: REPOSITORY) { nodes { ... on Repository { name } } }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalRepositoryContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel weekday } }
      }
    }
    repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC, orderBy: {field: PUSHED_AT, direction: DESC}) {
      totalCount
      nodes {
        name description url homepageUrl isFork isArchived
        stargazerCount forkCount
        createdAt updatedAt pushedAt
        primaryLanguage { name color }
        languages(first: 10, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } }
        repositoryTopics(first: 10) { nodes { topic { name } } }
        defaultBranchRef { target { ... on Commit { history { totalCount } } } }
      }
    }
  }
}`;

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'portfolio-snapshot' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GitHub GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function streaks(days) {
  let longest = 0, run = 0;
  for (const d of days) { run = d.contributionCount > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  // current streak: walk back from the latest day; today with 0 doesn't break it yet
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  return { longest, current };
}

// The calendar is shown exactly as github.com shows it: same counts, same
// colour levels (GitHub's own quartiles).
const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const { user } = await gql(QUERY, { login: LOGIN });
const cal = user.contributionsCollection.contributionCalendar;
const days = cal.weeks.flatMap(w => w.contributionDays);

const repos = user.repositories.nodes
  .filter(r => !r.isFork)
  .map(r => ({
    name: r.name,
    description: r.description,
    url: r.url,
    homepage: r.homepageUrl || null,
    stars: r.stargazerCount,
    forks: r.forkCount,
    archived: r.isArchived,
    createdAt: r.createdAt,
    pushedAt: r.pushedAt,
    commits: r.defaultBranchRef?.target?.history?.totalCount ?? null,
    language: r.primaryLanguage ? { name: r.primaryLanguage.name, color: r.primaryLanguage.color } : null,
    languages: r.languages.edges.map(e => ({ name: e.node.name, color: e.node.color, bytes: e.size })),
    topics: r.repositoryTopics.nodes.map(t => t.topic.name),
  }));

const langTotals = {};
for (const r of repos) for (const l of r.languages) {
  langTotals[l.name] ??= { name: l.name, color: l.color, bytes: 0 };
  langTotals[l.name].bytes += l.bytes;
}
const totalBytes = Object.values(langTotals).reduce((s, l) => s + l.bytes, 0) || 1;
const languages = Object.values(langTotals)
  .sort((a, b) => b.bytes - a.bytes)
  .map(l => ({ ...l, pct: +(100 * l.bytes / totalBytes).toFixed(1) }));

const snapshot = {
  generatedAt: new Date().toISOString(),
  profile: {
    login: user.login, name: user.name, bio: user.bio, company: user.company?.trim() || null,
    location: user.location, avatarUrl: user.avatarUrl, url: user.url, createdAt: user.createdAt,
    followers: user.followers.totalCount, following: user.following.totalCount,
    publicRepos: user.repositories.totalCount,
  },
  pinned: user.pinnedItems.nodes.map(n => n.name),
  contributions: {
    total: cal.totalContributions,
    commits: user.contributionsCollection.totalCommitContributions,
    pullRequests: user.contributionsCollection.totalPullRequestContributions,
    issues: user.contributionsCollection.totalIssueContributions,
    reposCreated: user.contributionsCollection.totalRepositoryContributions,
    private: user.contributionsCollection.restrictedContributionsCount,
    activeDays: days.filter(d => d.contributionCount > 0).length,
    busiestDay: days.reduce((m, d) => (d.contributionCount > m.contributionCount ? d : m), days[0]),
    streak: streaks(days),
    weeks: cal.weeks.map(w => w.contributionDays.map(d => ({
      date: d.date, count: d.contributionCount, level: LEVELS[d.contributionLevel] ?? 0, weekday: d.weekday,
    }))),
  },
  languages,
  repos,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(snapshot, null, 2));
// Same data as a script, so the page works even when opened straight from disk (file://),
// where fetch() of a local JSON file is blocked.
await writeFile(OUT.replace(/\.json$/, '.js'), `window.GH_DATA = ${JSON.stringify(snapshot)};\n`);
console.log(`Wrote ${OUT}: ${repos.length} repos, ${snapshot.contributions.total} contributions, ${languages.length} languages.`);
