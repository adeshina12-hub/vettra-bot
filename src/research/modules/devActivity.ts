import { config } from "../../config.js";
import type { CriterionResult, ProjectProfile } from "../../types.js";

export async function analyzeDevActivity(profile: ProjectProfile): Promise<CriterionResult> {
  if (!profile.githubRepo) {
    return {
      criterion: "dev_activity",
      label: "Developer Activity",
      findings: "No GitHub repository found in this project's listed links.",
      confidence: "low",
    };
  }

  const headers: Record<string, string> = { "User-Agent": "web3-research-agent" };
  if (config.github.token) headers.Authorization = `Bearer ${config.github.token}`;

  try {
    const repoRes = await fetch(`https://api.github.com/repos/${profile.githubRepo}`, { headers });
    if (!repoRes.ok) {
      return {
        criterion: "dev_activity",
        label: "Developer Activity",
        findings: `GitHub repo "${profile.githubRepo}" could not be fetched (status ${repoRes.status}) — may be private, renamed, or org-level rather than a single repo.`,
        confidence: "low",
      };
    }
    const repo = await repoRes.json();

    // Commit activity endpoint can 202 (still computing) on first request —
    // treat that as "unavailable this run" rather than an error.
    const activityRes = await fetch(
      `https://api.github.com/repos/${profile.githubRepo}/stats/commit_activity`,
      { headers }
    );
    let last4WeeksCommits: number | null = null;
    if (activityRes.ok) {
      const activity = await activityRes.json();
      if (Array.isArray(activity)) {
        last4WeeksCommits = activity.slice(-4).reduce((sum: number, w: any) => sum + (w.total ?? 0), 0);
      }
    }

    const daysSincePush = Math.round((Date.now() - new Date(repo.pushed_at).getTime()) / (1000 * 60 * 60 * 24));

    return {
      criterion: "dev_activity",
      label: "Developer Activity",
      findings: `${repo.stargazers_count.toLocaleString()} stars, ${repo.forks_count.toLocaleString()} forks, ${repo.open_issues_count} open issues. Last commit ${daysSincePush} day(s) ago.${last4WeeksCommits !== null ? ` ${last4WeeksCommits} commits in the last 4 weeks.` : ""}`,
      data: {
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        openIssues: repo.open_issues_count,
        daysSinceLastPush: daysSincePush,
        commitsLast4Weeks: last4WeeksCommits,
      },
      confidence: "high",
    };
  } catch (err) {
    console.error("[dev-activity] failed:", err);
    return {
      criterion: "dev_activity",
      label: "Developer Activity",
      findings: "Failed to fetch GitHub data.",
      confidence: "low",
    };
  }
}
