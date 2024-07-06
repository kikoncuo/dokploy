import {
	generateHash,
	generateRandomDomain,
	type Template,
	type Schema,
	generateBase64,
} from "../utils";

export function generate(schema: Schema): Template {
	const mainServiceHash = generateHash(schema.projectName);
	const randomDomain = generateRandomDomain(schema);
	const secretKeyBase = generateBase64(64);

	const envs = [
		`DOUBLEZERO_HOST=${randomDomain}`,
		"DOUBLEZERO_PORT=4000",
		`HASH=${mainServiceHash}`,
		`SECRET_KEY_BASE=${secretKeyBase}`,
		"AWS_ACCESS_KEY_ID=",
		"AWS_SECRET_ACCESS_KEY=",
		"AWS_REGION=",
		"SQS_URL=",
		"SYSTEM_EMAIL=",
	];

	return {
		envs,
	};
}
