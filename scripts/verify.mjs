/**
 * dsh-session-delete verify script.
 *
 * Checks:
 *  1. `node --check` syntax on both halves.
 *  2. Host plugin shape (default export with name/inject/apply) and route behaviour
 *     through a mock ctx: method guard, sessionId validation, live-session rejection,
 *     unknown-session 404, and a REAL deletion of a fixture directory plus
 *     accounting cleanup.
 *  3. Client bundle shape (ModuleLoader format, exports apply).
 *  4. Privacy scan: no tokens, no emails, no absolute local paths.
 *
 * Run: node scripts/verify.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";

const file = (name) => join(fileURLToPath(new URL("..", import.meta.url)), name);

let failures = 0;
function check(label, fn) {
	try {
		fn();
		console.log(`ok - ${label}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL - ${label}\n  ${error.message}`);
	}
}
async function checkAsync(label, fn) {
	try {
		await fn();
		console.log(`ok - ${label}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL - ${label}\n  ${error.message}`);
	}
}

const nodeCheck = (path) => {
	const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
	assert.equal(result.status, 0, `node --check ${path} failed:\n${result.stderr}`);
};

check("syntax: lib/index.js", () => nodeCheck(file("lib/index.js")));
check("syntax: lib/client.js", () => nodeCheck(file("lib/client.js")));

/** ------------------------------------------------------------------ */
/** Host plugin shape and route behaviour.                             */
/** ------------------------------------------------------------------ */
const plugin = await import(pathToFileURL(file("lib/index.js")).href);
const { name, inject, apply } = plugin.default;

check("host exports: name", () => assert.equal(name, "dsh-session-delete"));
check("host exports: inject declares webServer", () => assert.ok(inject.includes("webServer")));
check("host exports: inject declares sessionPersistence", () => assert.ok(inject.includes("sessionPersistence")));
check("host exports: inject declares workspaceRegistry", () => assert.ok(inject.includes("workspaceRegistry")));
check("host exports: inject declares sessions", () => assert.ok(inject.includes("sessions")));
check("host exports: apply is a function", () => assert.equal(typeof apply, "function"));

/** Minimal async-iterable request mock. */
function makeReq(body, method = "POST", url = "/dsh-session-delete/delete", host = "localhost:3080") {
	const text = body === void 0 ? "" : JSON.stringify(body);
	let sent = false;
	return {
		method,
		url,
		headers: { host },
		[Symbol.asyncIterator]() {
			return {
				next: async () => {
					if (sent) return { done: true };
					sent = true;
					return { done: false, value: Buffer.from(text) };
				}
			};
		}
	};
}

/** Minimal response mock collecting status + body. */
function makeRes() {
	const state = { status: 0, body: "" };
	return {
		writeHead(status, _headers) {
			state.status = status;
		},
		end(payload) {
			state.body = payload;
		},
		get status() {
			return state.status;
		},
		get json() {
			try {
				return JSON.parse(state.body);
			} catch {
				return null;
			}
		}
	};
}

/** Capture the handlers registered through ctx.webServer.register. */
function mountPlugin(services) {
	const captured = [];
	const webServer = {
		register(entry) {
			captured.push(entry);
			return () => {};
		}
	};
	const ctx = {
		...services,
		webServer,
		effect: (fn, _label) => { fn(); return () => {}; }
	};
	apply(ctx);
	assert.ok(captured.length > 0, "webServer.register was called");
	return captured;
}

const UUID = "12345678-1234-4234-8234-123456789abc";
const TARGET = `session-${UUID}`;
const OTHER = "session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const tempRoot = await mkdtemp(join(tmpdir(), "dsh-session-delete-verify-"));
try {
	/** Route: all three routes registered. */
	check("route: three routes registered", () => {
		const handlers = mountPlugin({});
		const paths = handlers.map((h) => h.path);
		assert.ok(paths.includes("/dsh-session-delete/delete"));
		assert.ok(paths.includes("/dsh-session-delete/delete-all"));
		assert.ok(paths.includes("/dsh-session-delete/archive-all"));
	});

	/** Route: kind is exact. */
	check("route: kind is exact", () => {
		const handlers = mountPlugin({});
		for (const h of handlers) assert.equal(h.kind, "exact");
	});

	/** Validation: empty sessionId rejected. */
	await checkAsync("validation: empty sessionId rejected", async () => {
		const handlers = mountPlugin({});
		const deleteRoute = handlers.find((h) => h.path === "/dsh-session-delete/delete");
		const res = makeRes();
		await deleteRoute.handler(makeReq({}), res);
		assert.equal(res.status, 400);
		assert.equal(res.json.ok, false);
		assert.equal(res.json.code, "bad-args");
	});

	/** Live session: skipped with error. */
	await checkAsync("live session is skipped with 'live' code", async () => {
		const handlers = mountPlugin({
			sessions: {
				get: (id) => (id === TARGET ? { id, header: { id, cwd: "/fixture" } } : void 0)
			},
			sessionPersistence: {
				list: async () => [],
				locate: () => ({ kind: "jsonl", path: join(tempRoot, "x", "session.jsonl.zstd") })
			},
			workspaceRegistry: {}
		});
		const deleteRoute = handlers.find((h) => h.path === "/dsh-session-delete/delete");
		const res = makeRes();
		await deleteRoute.handler(makeReq({ sessionId: TARGET }), res);
		assert.equal(res.status, 409);
		assert.equal(res.json.ok, false);
		assert.equal(res.json.code, "live");
	});

	/** Unknown session → 404. */
	await checkAsync("unknown session → 404", async () => {
		const handlers = mountPlugin({
			sessions: { get: () => void 0 },
			sessionPersistence: { list: async () => [] },
			workspaceRegistry: {}
		});
		const deleteRoute = handlers.find((h) => h.path === "/dsh-session-delete/delete");
		const res = makeRes();
		await deleteRoute.handler(makeReq({ sessionId: TARGET }), res);
		assert.equal(res.status, 404);
		assert.equal(res.json.code, "missing");
	});

	/** Real deletion: fixture directory removed, accounting cleaned. */
	await checkAsync("real deletion removes the session directory and cleans accounting", async () => {
		const sessionDir = join(tempRoot, TARGET);
		await mkdir(sessionDir, { recursive: true });
		await writeFile(join(sessionDir, "session.jsonl.zstd"), "fixture", "utf8");

		const accounting = [];
		const handlers = mountPlugin({
			sessions: { get: () => void 0 },
			sessionPersistence: {
				list: async () => [{ header: { id: TARGET, cwd: "/fixture" } }],
				locate: (meta) => ({
					kind: "jsonl",
					path: join(tempRoot, meta.id, "session.jsonl.zstd")
				})
			},
			workspaceRegistry: {
				archiveSession: async (id) => { accounting.push("archive:" + id); },
				list: () => [
					{
						sessionIds: [TARGET, OTHER],
						detachSession: async (id) => { accounting.push("detach:" + id); }
					}
				],
				archivedSessionIds: [TARGET]
			}
		});

		const deleteRoute = handlers.find((h) => h.path === "/dsh-session-delete/delete");
		const res = makeRes();
		await deleteRoute.handler(makeReq({ sessionId: TARGET }), res);
		assert.equal(res.status, 200, JSON.stringify(res.json));
		assert.equal(res.json.ok, true);
		await assert.rejects(readFile(join(sessionDir, "session.jsonl.zstd")));
		assert.ok(accounting.includes("archive:" + TARGET));
		assert.ok(accounting.includes("detach:" + TARGET));
	});

	/** Delete-all: all sessions in a workspace. */
	await checkAsync("delete-all removes multiple sessions", async () => {
		const sessionDir1 = join(tempRoot, "ws-s1");
		const sessionDir2 = join(tempRoot, "ws-s2");
		await mkdir(sessionDir1, { recursive: true });
		await mkdir(sessionDir2, { recursive: true });
		await writeFile(join(sessionDir1, "session.jsonl.zstd"), "f1", "utf8");
		await writeFile(join(sessionDir2, "session.jsonl.zstd"), "f2", "utf8");

		const handlers = mountPlugin({
			sessions: { get: () => void 0 },
			sessionPersistence: {
				list: async () => [
					{ header: { id: "session-s1", cwd: "/fixture" } },
					{ header: { id: "session-s2", cwd: "/fixture" } }
				],
				locate: (meta) => ({
					kind: "jsonl",
					path: join(tempRoot, "ws-" + meta.id.replace("session-", ""), "session.jsonl.zstd")
				})
			},
			workspaceRegistry: {
				get: () => ({ sessionIds: ["session-s1", "session-s2"] }),
				archiveSession: async () => {},
				list: () => [],
				archivedSessionIds: []
			}
		});

		const deleteAllRoute = handlers.find((h) => h.path === "/dsh-session-delete/delete-all");
		const res = makeRes();
		await deleteAllRoute.handler(makeReq({ workspaceId: "ws1" }, "POST", "/dsh-session-delete/delete-all"), res);
		assert.equal(res.status, 200);
		assert.equal(res.json.ok, true);
		assert.equal(res.json.deleted, 2);
		assert.equal(res.json.live, 0);
	});

	/** Archive-all: archives unarchived sessions only. */
	await checkAsync("archive-all archives unarchived sessions", async () => {
		const archived = [];
		const handlers = mountPlugin({
			sessions: { get: () => void 0 },
			sessionPersistence: { list: async () => [] },
			workspaceRegistry: {
				get: () => ({ sessionIds: ["session-a", "session-b", "session-c"] }),
				archiveSession: async (id) => { archived.push(id); },
				list: () => [],
				archivedSessionIds: ["session-c"]
			}
		});

		const archiveAllRoute = handlers.find((h) => h.path === "/dsh-session-delete/archive-all");
		const res = makeRes();
		await archiveAllRoute.handler(makeReq({ workspaceId: "ws1" }, "POST", "/dsh-session-delete/archive-all"), res);
		assert.equal(res.status, 200);
		assert.equal(res.json.ok, true);
		assert.equal(res.json.archived, 2);
		assert.deepEqual(archived, ["session-a", "session-b"]);
	});
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}

/** ------------------------------------------------------------------ */
/** Client bundle shape.                                               */
/** ------------------------------------------------------------------ */
const client = await readFile(file("lib/client.js"), "utf8");
check("client: ModuleLoader registration", () =>
	assert.match(client, /window\.__ModuleLoader__\.load\(\{\s*id: "dsh-session-delete"/, "client should register via ModuleLoader"));
check("client: exports apply", () => {
	assert.match(client, /exports\.apply = apply;/, "client should export apply");
});
check("client: data-menu-material selector", () => {
	assert.match(client, /data-menu-material/, "client should use the new menu surface selector");
});
check("client: data-row-key usage", () => {
	assert.match(client, /data-row-key/, "client should use data-row-key for row identification");
});

/** ------------------------------------------------------------------ */
/** Privacy scan (tokens, emails, absolute local paths).               */
/** ------------------------------------------------------------------ */
const scanned = ["lib/index.js", "lib/client.js", "README.md", "cordis.patch.yml", "package.json", "LICENSE"];
const privacyPatterns = [
	[/ghp_[A-Za-z0-9]{20,}/, "GitHub classic PAT"],
	[/github_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained PAT"],
	[/gho_[A-Za-z0-9]{20,}/, "GitHub OAuth token"],
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "email address"],
	[/[A-Za-z]:\\/, "absolute drive path"]
];
for (const name of scanned) {
	const content = await readFile(file(name), "utf8");
	for (const [pattern, kind] of privacyPatterns) {
		check(`privacy: no ${kind} in ${name}`, () => {
			const match = content.match(pattern);
			assert.equal(match, null, `found ${kind}: ${match?.[0]?.slice(0, 40)}`);
		});
	}
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed.`);
	process.exit(1);
}
console.log("\nAll checks passed.");