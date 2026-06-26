import * as planner from './planner.js';
import { addLog } from '../db/repo.js';

const UA = { 'User-Agent': 'AutoForge/1.0' };

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { headers: { ...UA, ...(opts.headers || {}) }, ...opts });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const KEYWORDS = ['tool', 'script', 'automation', 'cli', 'api'];
const matchesKeyword = (text) => {
  const t = (text || '').toLowerCase();
  return KEYWORDS.some((k) => t.includes(k));
};

// Source A — Hacker News "Ask HN"
async function fetchHackerNews() {
  try {
    const ids = await fetchJSON('https://hacker-news.firebaseio.com/v0/askstories.json');
    const top = (ids || []).slice(0, 10);
    const items = await Promise.all(
      top.map((id) =>
        fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)
      )
    );
    return items
      .filter((i) => i && i.title && matchesKeyword(i.title))
      .map((i) => ({ source: 'HackerNews', title: i.title, url: i.url || '' }));
  } catch {
    return [];
  }
}

// Source B — GitHub Trending (with API fallback)
async function fetchGitHubTrending() {
  try {
    const data = await fetchJSON(
      'https://github-trending-api.deta.dev/repositories?language=javascript&since=weekly'
    );
    return (data || [])
      .slice(0, 10)
      .map((r) => ({ source: 'GitHubTrending', title: r.name, description: r.description, stars: r.stars }));
  } catch {
    // Fallback to the public search API.
    try {
      const data = await fetchJSON(
        'https://api.github.com/search/repositories?q=stars:>100+language:javascript+created:>2024-01-01&sort=stars'
      );
      return (data.items || [])
        .slice(0, 10)
        .map((r) => ({
          source: 'GitHubSearch',
          title: r.name,
          description: r.description,
          stars: r.stargazers_count,
        }));
    } catch {
      return [];
    }
  }
}

// Source C — Reddit r/programming
async function fetchReddit() {
  try {
    const data = await fetchJSON('https://www.reddit.com/r/programming/top.json?limit=10&t=week');
    const posts = data?.data?.children || [];
    return posts
      .map((p) => p.data)
      .filter((d) => d && matchesKeyword(d.title))
      .map((d) => ({ source: 'Reddit', title: d.title, url: d.url || '' }));
  } catch {
    return [];
  }
}

// Produce a full project plan. If a brief is provided, build exactly that;
// otherwise scrape trending sources and let the planner choose.
export async function findProblem({ brief = '', domain = 'CLI tools', images = [], documents = [] }, maxIssues = 8, runId = null) {
  brief = (brief || '').trim();

  let trends = [];
  if (!brief) {
    if (runId) await addLog(runId, '🔎 Scraping HN, GitHub Trending, Reddit…');
    const [hn, gh, rd] = await Promise.all([fetchHackerNews(), fetchGitHubTrending(), fetchReddit()]);
    trends = [...hn, ...gh, ...rd];
    if (runId) await addLog(runId, `📊 Gathered ${trends.length} trending items.`);
  } else if (runId) {
    await addLog(runId, '📝 Using your project brief.');
  }

  return planner.buildPlan({ brief, trends, domain, maxIssues, images, documents }, runId);
}
