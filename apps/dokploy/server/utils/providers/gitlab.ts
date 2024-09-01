import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { APPLICATIONS_PATH, COMPOSE_PATH } from "@/server/constants";
import { TRPCError } from "@trpc/server";
import { recreateDirectory } from "../filesystem/directory";
import { spawnAsync } from "../process/spawnAsync";
import {
	getGitlabProvider,
	type GitlabProvider,
	updateGitlabProvider,
} from "@/server/api/services/git-provider";
import type { InferResultType } from "@/server/types/with";
import type { Compose } from "@/server/api/services/compose";

export const refreshGitlabToken = async (gitlabProviderId: string) => {
	const gitlabProvider = await getGitlabProvider(gitlabProviderId);
	const currentTime = Math.floor(Date.now() / 1000);

	const safetyMargin = 60;
	if (
		gitlabProvider.expiresAt &&
		currentTime + safetyMargin < gitlabProvider.expiresAt
	) {
		console.log("Token still valid, no need to refresh");
		return;
	}

	const response = await fetch("https://gitlab.com/oauth/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: gitlabProvider.refreshToken as string,
			client_id: gitlabProvider.applicationId as string,
			client_secret: gitlabProvider.secret as string,
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to refresh token: ${response.statusText}`);
	}

	const data = await response.json();

	const expiresAt = Math.floor(Date.now() / 1000) + data.expires_in;

	console.log("Refreshed token");

	await updateGitlabProvider(gitlabProviderId, {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt,
	});
	return data;
};

export const haveGitlabRequirements = (gitlabProvider: GitlabProvider) => {
	return !!(gitlabProvider?.accessToken && gitlabProvider?.refreshToken);
};

const getErrorCloneRequirements = (entity: {
	repository?: string | null;
	owner?: string | null;
	branch?: string | null;
}) => {
	const reasons: string[] = [];
	const { repository, owner, branch } = entity;

	if (!repository) reasons.push("1. Repository not assigned.");
	if (!owner) reasons.push("2. Owner not specified.");
	if (!branch) reasons.push("3. Branch not defined.");

	return reasons;
};

export type ApplicationWithGitlab = InferResultType<
	"applications",
	{ gitlabProvider: true }
>;

export type ComposeWithGitlab = InferResultType<
	"compose",
	{ gitlabProvider: true }
>;

export const cloneGitlabRepository = async (
	entity: ApplicationWithGitlab | ComposeWithGitlab,
	logPath: string,
	isCompose = false,
) => {
	const writeStream = createWriteStream(logPath, { flags: "a" });
	const {
		appName,
		gitlabRepository,
		gitlabOwner,
		gitlabBranch,
		gitlabId,
		gitlabProvider,
		gitlabPathNamespace,
	} = entity;

	if (!gitlabId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Gitlab Provider not found",
		});
	}

	await refreshGitlabToken(gitlabId);

	const requirements = getErrorCloneRequirements(entity);

	// Check if requirements are met
	if (requirements.length > 0) {
		writeStream.write(
			`\nGitLab Repository configuration failed for application: ${appName}\n`,
		);
		writeStream.write("Reasons:\n");
		writeStream.write(requirements.join("\n"));
		writeStream.end();
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error: GitLab repository information is incomplete.",
		});
	}
	const basePath = isCompose ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = join(basePath, appName, "code");
	await recreateDirectory(outputPath);
	const repoclone = `gitlab.com/${gitlabPathNamespace}.git`;
	const cloneUrl = `https://oauth2:${gitlabProvider?.accessToken}@${repoclone}`;

	try {
		writeStream.write(`\nClonning Repo ${repoclone} to ${outputPath}: ✅\n`);
		await spawnAsync(
			"git",
			[
				"clone",
				"--branch",
				gitlabBranch!,
				"--depth",
				"1",
				cloneUrl,
				outputPath,
				"--progress",
			],
			(data) => {
				if (writeStream.writable) {
					writeStream.write(data);
				}
			},
		);
		writeStream.write(`\nCloned ${repoclone}: ✅\n`);
	} catch (error) {
		writeStream.write(`ERROR Clonning: ${error}: ❌`);
		throw error;
	} finally {
		writeStream.end();
	}
};

export const getGitlabRepositories = async (input: {
	gitlabId?: string;
}) => {
	if (!input.gitlabId) {
		return [];
	}

	await refreshGitlabToken(input.gitlabId);

	const gitlabProvider = await getGitlabProvider(input.gitlabId);

	const response = await fetch(
		`https://gitlab.com/api/v4/projects?membership=true&owned=true&page=${0}&per_page=${100}`,
		{
			headers: {
				Authorization: `Bearer ${gitlabProvider.accessToken}`,
			},
		},
	);

	if (!response.ok) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Failed to fetch repositories: ${response.statusText}`,
		});
	}

	const repositories = await response.json();

	const filteredRepos = repositories.filter((repo: any) => {
		const { full_path, kind } = repo.namespace;
		const groupName = gitlabProvider.groupName?.toLowerCase();

		if (groupName) {
			return full_path.toLowerCase().includes(groupName) && kind === "group";
		}
		return kind === "user";
	});
	const mappedRepositories = filteredRepos.map((repo: any) => {
		return {
			id: repo.id,
			name: repo.name,
			url: repo.path_with_namespace,
			owner: {
				username: repo.namespace.path,
			},
		};
	});

	return mappedRepositories as {
		id: number;
		name: string;
		url: string;
		owner: {
			username: string;
		};
	}[];
};

export const getGitlabBranches = async (input: {
	id: number | null;
	gitlabId?: string;
	owner: string;
	repo: string;
}) => {
	if (!input.gitlabId || !input.id) {
		return [];
	}

	const gitlabProvider = await getGitlabProvider(input.gitlabId);

	const branchesResponse = await fetch(
		`https://gitlab.com/api/v4/projects/${input.id}/repository/branches`,
		{
			headers: {
				Authorization: `Bearer ${gitlabProvider.accessToken}`,
			},
		},
	);

	if (!branchesResponse.ok) {
		throw new Error(`Failed to fetch branches: ${branchesResponse.statusText}`);
	}

	const branches = await branchesResponse.json();

	return branches as {
		id: string;
		name: string;
		commit: {
			id: string;
		};
	}[];
};

export const cloneRawGitlabRepository = async (entity: Compose) => {
	const {
		appName,
		gitlabRepository,
		gitlabOwner,
		gitlabBranch,
		gitlabId,
		gitlabPathNamespace,
	} = entity;

	if (!gitlabId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Gitlab Provider not found",
		});
	}

	const gitlabProvider = await getGitlabProvider(gitlabId);

	await refreshGitlabToken(gitlabId);
	const basePath = COMPOSE_PATH;
	const outputPath = join(basePath, appName, "code");
	await recreateDirectory(outputPath);
	const repoclone = `gitlab.com/${gitlabPathNamespace}.git`;
	const cloneUrl = `https://oauth2:${gitlabProvider?.accessToken}@${repoclone}`;

	try {
		await spawnAsync("git", [
			"clone",
			"--branch",
			gitlabBranch!,
			"--depth",
			"1",
			cloneUrl,
			outputPath,
			"--progress",
		]);
	} catch (error) {
		throw error;
	}
};
