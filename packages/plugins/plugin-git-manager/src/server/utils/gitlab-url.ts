import { assertUrlHasNoUserInfo } from './url-security';

/**
 * Shared utility for parsing GitLab repository URLs.
 * Extracted to avoid duplicating URL-parsing logic across
 * gitlab-api.ts, poller.ts, and review.ts.
 */

export interface GitLabProject {
  /** Full API base URL, e.g. https://gitlab.com/api/v4 */
  apiBase: string;
  /** Raw project path, e.g. group/sub/project */
  projectPath: string;
  /** URL-encoded project path for use in API endpoints */
  encodedProject: string;
}

/**
 * Extract GitLab API base URL and project path from a repository URL.
 * Supports: https://gitlab.com/group/project.git
 *           https://self-hosted.gitlab.com/group/sub/project.git
 *
 * @throws Error if the URL cannot be parsed or has no project path
 */
export function parseGitLabProject(repoUrl: string): GitLabProject {
  assertUrlHasNoUserInfo(repoUrl);
  const url = new URL(repoUrl);
  // Remove .git suffix and leading slash
  const projectPath = url.pathname.replace(/\.git$/, '').replace(/^\//, '');
  if (!projectPath) {
    throw new Error('Cannot extract project path from repository URL');
  }
  return {
    apiBase: `${url.protocol}//${url.host}/api/v4`,
    projectPath,
    encodedProject: encodeURIComponent(projectPath),
  };
}
