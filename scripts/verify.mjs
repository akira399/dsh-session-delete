/**
 * dsh-session-delete verify script.
 *
 * Checks:
 *  1. `node --check` syntax on both halves.
 *  2. Host plugin shape (name/inject/apply) and route behaviour through a
 *     mock ctx: method guard, sessionId validation, live-session rejection,
 *     unknown-session 404, and a REAL deletion of a fixture directory plus
 *     accounting cleanup.
 *  3. Client bundle shape (ModuleLoader format, exports, service injects).
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
const { name, inject, apply } = await import(pathToFileURL(file("lib/index.js")).href);

check("host exports: name", () => assert.equal(name, "dsh-session-delete"));
check("host exports: inject declares webServer", () => assert.ok(inject.includes("webServer")));
check("host exports: apply is a function", () => assert.equal(typeof apply, "function"));

/** Minimal async-iterable request mock. */
function makeReq(body, method = "POST", url = "/session-delete/api/delete", host = "localhost:3080") {
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

/** Capture the handler registered through ctx.webServer.register. */
function mountPlugin(services) {
	let captured = null;
	const webServer = {
		register(entry) {
			captured = entry;
			return () => {};
		}
	};
	const ctx = {
		...services,
		webServer,
		get: (name) => services[name],
		effect: (fn) => {
			const disposer = fn();
			return disposer ?? (() => {});
		}
	};
	apply(ctx);
	assert.ok(captured !== null, "webServer.register was not called");
	return captured.handler;
}

const UUID = "12345678-1234-4234-8234-123456789abc";
const TARGET = `session-${UUID}`;
const OTHER = "session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const tempRoot = await mkdtemp(join(tmpdir(), "dsh-session-delete-verify-"));
try {
	/** Route: method guard. */
	await checkAsync("route: non-POST rejected with 405", async () => {
		const handler = mountPlugin({});
		const res = makeRes();
		await handler(makeReq({ sessionId: TARGET }, "GET"), res);
		assert.equal(res.status, 405);
		assert.equal(res.json.ok, false);
	});

	/** Route: forbidden host. */
	await checkAsync("route: non-local host rejected with 403", async () => {
		const handler = mountPlugin({});
		const res = makeRes();
		await handler(makeReq({ sessionId: TARGET }, "POST", "/session-delete/api/delete", "evil.example.com"), res);
		assert.equal(res.status, 403);
	});

	/** Route: unknown endpoint. */
	await checkAsync("route: unknown endpoint rejected with 404", async () => {
		const handler = mountPlugin({});
		const res = makeRes();
		await handler(makeReq({}, "POST", "/session-delete/api/nope"), res);
		assert.equal(res.status, 404);
	});

	/** Validation: malformed session id. */
	await checkAsync("validation: malformed sessionId rejected", async () => {
		const handler = mountPlugin({});
		const res = makeRes();
		await handler(makeReq({ sessionId: "../../etc/passwd" }), res);
		assert.equal(res.status, 400);
		assert.equal(res.json.error.code, "invalid-session-id");
	});

	/** Live session: cancel + detach, then physically remove. */
	await checkAsync("live session is cancelled, detached and deleted", async () => {
		const calls = [];
		const sessionDir = join(tempRoot, `${TARGET}-live`);
		await mkdir(sessionDir, { recursive: true });
		await writeFile(join(sessionDir, "session.jsonl.zstd"), "live-fixture", "utf8");

		const handler = mountPlugin({
			logger: { warn: () => {} },
			sessions: {
				get: (id) => (id === TARGET ? { id, header: { id, cwd: "/fixture" } } : void 0),
				store: {
					get: (id) => ({
						detach: () => {
							calls.push("detach");
						}
					})
				}
			},
			agents: {
				get: (id) => ({
					cancel: () => {
						calls.push("cancel");
					}
				})
			},
			sessionPersistence: {
				// Live sessions are not in the persistence listing; the header
				// must come from the in-memory session instead.
				list: async () => [],
				locate: (meta) => ({
					kind: "jsonl",
					path: join(tempRoot, `${meta.id}-live`, "session.jsonl.zstd")
				})
			},
			workspaceRegistry: {
				enqueueOperation: async (fn) => fn(),
				requireTable: () => ({ entries: () => [].values(), update: async () => {} }),
				requireState: () => ({ archivedSessionIds: [] }),
				setState: async () => {}
			}
		});
		const res = makeRes();
		await handler(makeReq({ sessionId: TARGET }), res);
		assert.equal(res.status, 200, JSON.stringify(res.json));
		assert.deepEqual(calls, ["cancel", "detach"]);
		await assert.rejects(readFile(join(sessionDir, "session.jsonl.zstd")));
	});

	/** Live session whose detach is unavailable → loud failure. */
	await checkAsync("live session without detach entry fails loudly", async () => {
		const handler = mountPlugin({
			sessions: {
				get: (id) => (id === TARGET ? { id, header: { id, cwd: "/fixture" } } : void 0),
				store: { get: () => void 0 }
			},
			agents: { get: () => void 0 },
			sessionPersistence: {
				list: async () => [],
				locate: () => ({ kind: "jsonl", path: join(tempRoot, "x", "session.jsonl.zstd") })
			}
		});
		const res = makeRes();
		await handler(makeReq({ sessionId: TARGET }), res);
		assert.equal(res.status, 400);
		assert.equal(res.json.error.code, "session-live");
	});

	/** Unknown session → 404. */
	await checkAsync("unknown session → 404", async () => {
		const handler = mountPlugin({
			sessions: { get: () => void 0 },
			sessionPersistence: { list: async () => [] }
		});
		const res = makeRes();
		await handler(makeReq({ sessionId: TARGET }), res);
		assert.equal(res.status, 404);
		assert.equal(res.json.error.code, "session-not-found");
	});

	/** Real deletion: fixture directory removed, accounting cleaned. */
	await checkAsync("real deletion removes the session directory and cleans accounting", async () => {
		const sessionDir = join(tempRoot, TARGET);
		await mkdir(sessionDir, { recursive: true });
		await writeFile(join(sessionDir, "session.jsonl.zstd"), "fixture", "utf8");

		const accounting = [];
		const registry = {
			enqueueOperation: async (fn) => {
				accounting.push("enqueue");
				await fn();
			},
			requireTable() {
				return {
					entries() {
						return [
							["w1", { sessionIds: [TARGET, OTHER] }],
							["w2", { sessionIds: [OTHER] }]
						].values();
					},
					async update(id, fn) {
						accounting.push(`update:${id}`);
						const record = { sessionIds: [TARGET, OTHER] };
						fn(record);
					}
				};
			},
			requireState() {
				return { archivedSessionIds: [TARGET] };
			},
			setState: async (state) => {
				accounting.push("setState");
				assert.ok(!state.archivedSessionIds.includes(TARGET), "archived set cleaned");
			}
		};
		const handler = mountPlugin({
			sessions: { get: () => void 0 },
			sessionPersistence: {
				list: async () => [{ id: TARGET, cwd: "/fixture" }],
				locate: (meta) => ({
					kind: "jsonl",
					path: join(tempRoot, meta.id, "session.jsonl.zstd")
				})
			},
			workspaceRegistry: registry
		});

		const res = makeRes();
		await handler(makeReq({ sessionId: TARGET }), res);
		assert.equal(res.status, 200, JSON.stringify(res.json));
		assert.equal(res.json.ok, true);
		assert.equal(res.json.value.sessionId, TARGET);
		await assert.rejects(readFile(join(sessionDir, "session.jsonl.zstd")));
		assert.ok(accounting.includes("enqueue"), "registry queue used");
		assert.ok(accounting.includes("update:w1"), "workspace seat cleaned");
		assert.ok(!accounting.includes("update:w2"), "unrelated workspace untouched");
		assert.ok(accounting.includes("setState"), "archived set write issued");
	});

	/** Accounting cleanup keeps unrelated archived ids. */
	await checkAsync("accounting cleanup keeps unrelated archived ids", async () => {
		const archived = [TARGET, OTHER];
		const registry = {
			enqueueOperation: async (fn) => fn(),
			requireTable() {
				return { entries: () => [].values(), update: async () => {} };
			},
			requireState() {
				return { archivedSessionIds: archived };
			},
			setState: async (state) => {
				assert.deepEqual(state.archivedSessionIds, [OTHER]);
			}
		};
		const handler = mountPlugin({
			sessions: { get: () => void 0 },
			sessionPersistence: {
				list: async () => [{ id: TARGET, cwd: "/fixture" }],
				locate: (meta) => ({
					kind: "jsonl",
					path: join(tempRoot, meta.id, "session.jsonl.zstd")
				})
			},
			workspaceRegistry: registry
		});
		const res = makeRes();
		await handler(makeReq({ sessionId: TARGET }), res);
		assert.equal(res.status, 200);
	});
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}

/** ------------------------------------------------------------------ */
/** Client bundle shape.                                               */
/** ------------------------------------------------------------------ */
const client = await readFile(file("lib/client.js"), "utf8");
check("client: ModuleLoader registration", () =>
	assert.match(client, /window\.__ModuleLoader__\.load\(\{\s*id: "dsh-session-delete"/));
check("client: exports apply/inject", () => {
	assert.match(client, /exports\.apply = apply;/);
	assert.match(client, /exports\.inject = inject;/);
});
check("client: inject declares sessions/workspaces/connection", () => {
	assert.match(client, /"sessions"/);
	assert.match(client, /"workspaces"/);
	assert.match(client, /"connection"/);
});

/** ------------------------------------------------------------------ */
/** Client resolve logic: DOM-order simulation.                         */
/** ------------------------------------------------------------------ */
/** Minimal Element mock supporting the selectors resolveSessionId uses. */
class El {
	constructor(tag, attrs = {}, children = []) {
		this.tag = tag;
		this.attrs = attrs;
		this.children = children;
		this.parent = null;
		for (const child of children) child.parent = this;
	}
	matches(selector) {
		const parts = selector.split("][");
		for (const part of parts) {
			const match = part.match(/\[([a-zA-Z-]+)="([^"]*)"\]/);
			if (match === null) return false;
			if (this.attrs[match[1]] !== match[2]) return false;
		}
		return true;
	}
	hasAttribute(name) {
		return name in this.attrs;
	}
	closest(selector) {
		let current = this;
		while (current !== null) {
			if (current.matches(selector)) return current;
			current = current.parent;
		}
		return null;
	}
	querySelectorAll(selector) {
		const out = [];
		const walk = (node) => {
			for (const child of node.children) {
				if (child.matches(selector)) out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}
	get parentElement() {
		return this.parent;
	}
}
const node = (tag, attrs = {}, children = []) => new El(tag, attrs, children);
const row = (id) => node("div", { role: "treeitem" });
const header = () => node("div", { role: "treeitem", "aria-expanded": "true" });
/** A session row wrapped the way HoverCard wraps it (span between row and section). */
const wrappedRow = () => node("span", {}, [row()]);

/** Execute the client bundle in a vm and return its exports. */
function loadClientModule() {
	let handoff = null;
	const sandbox = {
		window: { __ModuleLoader__: { load: (entry) => { handoff = entry; } } },
		console
	};
	vm.createContext(sandbox);
	vm.runInContext(client, sandbox, { filename: "lib/client.js" });
	assert.ok(handoff !== null, "client did not register via __ModuleLoader__.load");
	return handoff.factory(() => ({}));
}

/** Build the store snapshots matching a DOM tree. */
function makeRuntime(byIdEntries, workspaceItems, archivedSessionIds = [], listIds = null) {
	const byId = {};
	for (const [id, entry] of Object.entries(byIdEntries)) byId[id] = entry;
	const ids = listIds ?? Object.keys(byId);
	const slist = { getSnapshot: () => ({ ids, byId }) };
	const wlist = {
		getSnapshot: () => ({
			items: workspaceItems,
			archivedSessionIds
		})
	};
	return { sessions: { list: slist }, workspaces: { list: wlist } };
}
const anchorFor = (title) => ({ getAttribute: () => `会话“${title}”的操作` });

const exportsObj = loadClientModule();
const resolve = exportsObj._resolveSessionId;
check("client: _resolveSessionId is exported for testing", () =>
	assert.equal(typeof resolve, "function"));

const S1 = "session-1", S2 = "session-2", S3 = "session-3", S4 = "session-4", S5 = "session-5";
const runtime = makeRuntime(
	{
		[S1]: { displayTitle: "Alpha", updatedAt: 100 },
		[S2]: { displayTitle: "Beta", updatedAt: 200 },
		[S3]: { displayTitle: "Gamma", updatedAt: 300 },
		[S4]: { displayTitle: "Delta", updatedAt: 400 },
		[S5]: { displayTitle: "Epsilon", updatedAt: 500 }
	},
	[
		{ workspaceId: "w1", title: "ws1", sessionIds: [S1, S2, S3] },
		{ workspaceId: "w2", title: "ws2", sessionIds: [S4] }
	]
);

/** Tree view, all groups expanded, HoverCard wrappers everywhere. */
const tree = node("div", { role: "tree" }, [
	node("div", {}, [header(), wrappedRow(), wrappedRow(), wrappedRow()]),
	node("div", {}, [header(), wrappedRow()]),
	node("div", {}, [header(), wrappedRow()]) // Ungrouped bucket (stray: S5)
]);
const [r1, r2, r3] = tree.children[0].children.slice(1).map((span) => span.children[0]);
const [r4] = tree.children[1].children.slice(1).map((span) => span.children[0]);
const [r5] = tree.children[2].children.slice(1).map((span) => span.children[0]);

check("resolve: first workspace, first row (wrapped in span)", () =>
	assert.equal(resolve(r1, runtime, anchorFor("Alpha")), S1));
check("resolve: first workspace, third row", () =>
	assert.equal(resolve(r3, runtime, anchorFor("Gamma")), S3));
check("resolve: second workspace row", () =>
	assert.equal(resolve(r4, runtime, anchorFor("Delta")), S4));
check("resolve: ungrouped row maps to stray session", () =>
	assert.equal(resolve(r5, runtime, anchorFor("Epsilon")), S5));
check("resolve: null when row is not in the tree", () => {
	const orphan = row();
	assert.equal(resolve(orphan, runtime, anchorFor("Alpha")), null);
});
check("resolve: title mismatch falls back to updatedAt order", () => {
	// DOM order follows account order [S3, S1, S2], but the anchor title says
	// "Beta" — account pick (S3) and updated pick (S3) both fail the guard,
	// so the unique-title fallback must resolve S2.
	const reordered = node("div", { role: "tree" }, [
		node("div", {}, [header(), wrappedRow(), wrappedRow(), wrappedRow()])
	]);
	const rows = reordered.children[0].children.slice(1).map((span) => span.children[0]);
	const byUpdatedRuntime = makeRuntime(
		{
			[S1]: { displayTitle: "Alpha", updatedAt: 300 },
			[S2]: { displayTitle: "Beta", updatedAt: 100 },
			[S3]: { displayTitle: "Gamma", updatedAt: 200 }
		},
		[{ workspaceId: "w1", title: "ws1", sessionIds: [S3, S1, S2] }]
	);
	assert.equal(resolve(rows[1], byUpdatedRuntime, anchorFor("Beta")), S2);
});
check("resolve: archived sessions are skipped in the row order", () => {
	const archivedTree = node("div", { role: "tree" }, [
		node("div", {}, [header(), wrappedRow(), wrappedRow()]) // S2 archived → only S1, S3 visible
	]);
	const rows = archivedTree.children[0].children.slice(1).map((span) => span.children[0]);
	const archivedRuntime = makeRuntime(
		{
			[S1]: { displayTitle: "Alpha", updatedAt: 100 },
			[S2]: { displayTitle: "Beta", updatedAt: 200 },
			[S3]: { displayTitle: "Gamma", updatedAt: 300 }
		},
		[{ workspaceId: "w1", title: "ws1", sessionIds: [S1, S2, S3] }],
		[S2]
	);
	assert.equal(resolve(rows[1], archivedRuntime, anchorFor("Gamma")), S3);
});
check("resolve: collapsed group keeps leading rows only", () => {
	const collapsedTree = node("div", { role: "tree" }, [
		node("div", {}, [header(), wrappedRow(), wrappedRow()]) // only first 2 of 3 rendered
	]);
	const rows = collapsedTree.children[0].children.slice(1).map((span) => span.children[0]);
	assert.equal(resolve(rows[1], runtime, anchorFor("Beta")), S2);
});
check("resolve: flat view maps rows in session-list order", () => {
	const flatTree = node("div", { role: "tree" }, [
		wrappedRow(), wrappedRow(), wrappedRow(), wrappedRow(), wrappedRow()
	]);
	const rows = flatTree.children.map((span) => span.children[0]);
	assert.equal(resolve(rows[2], runtime, anchorFor("Gamma")), S3);
});
check("resolve: blank title guard never blocks (no anchor label)", () => {
	// No anchor passed → title is "" → pure order mapping.
	assert.equal(resolve(r2, runtime), S2);
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
