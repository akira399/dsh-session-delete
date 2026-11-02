/**
 * dsh-session-delete — host half.
 *
 * Registers local HTTP routes under `/dsh-session-delete/`:
 *   POST /dsh-session-delete/delete      — delete one session
 *   POST /dsh-session-delete/delete-all  — delete all sessions in a workspace
 *   POST /dsh-session-delete/archive-all — archive all unarchived sessions in a workspace
 *
 * Deletion uses Node's built-in fs.rm for file removal, then cleans workspace
 * accounting. Live (open/running) sessions are skipped with a clear error.
 *
 * Dependencies: webServer, sessionPersistence, workspaceRegistry, sessions.
 */

import { rm } from "node:fs/promises";

const MODULE = "[dsh-session-delete]";

function log(...args) {
	console.error(MODULE, ...args);
}

function textOf(v) {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	if (typeof v.text === "string") return v.text;
	try { return String(v); } catch { return ""; }
}

function dirname(p) {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i <= 0 ? "" : p.slice(0, i);
}

/** Read and parse the JSON request body (empty body → {}). */
async function readJsonBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}

function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}

/**
 * Delete one session:
 *   1. Reject if live (open/running).
 *   2. Locate its durable artifact via sessionPersistence.
 *   3. Remove the session directory via Node fs.rm.
 *   4. Clean workspace accounting (archive + detach).
 * Results go into the report object in-place.
 */
async function deleteOne(deps, id, report) {
	// 1) Reject live sessions
	if (deps.sessions.get(id) !== undefined) {
		report.live.push(id);
		return;
	}

	// 2) Resolve the persistence snapshot
	// list() returns { header: { id, ... }, revision, sizeBytes } objects
	let snapshot;
	try {
		const snapshots = await deps.persistence.list();
		snapshot = Array.isArray(snapshots)
			? snapshots.find((s) => s && s.header && s.header.id === id)
			: undefined;
	} catch (e) {
		report.failed.push({ id, code: "list-failed", detail: textOf(e && e.message) });
		return;
	}
	if (snapshot === undefined) {
		report.missing.push(id);
		return;
	}

	// 3) Locate and remove the session directory
	let loc;
	try { loc = deps.persistence.locate(snapshot.header); } catch { loc = undefined; }
	if (loc === undefined || typeof loc.path !== "string" || loc.path === "") {
		report.failed.push({ id, code: "no-location" });
		return;
	}
	const dir = dirname(loc.path);
	if (dir === "") {
		report.failed.push({ id, code: "bad-path" });
		return;
	}

	try {
		await rm(dir, { recursive: true, force: true });
	} catch (e) {
		report.failed.push({ id, code: "rm-failed", detail: textOf(e && e.message) });
		return;
	}

	// 4) Clean accounting (best effort; failures only affect display)
	try { await deps.registry.archiveSession(id); } catch { /* already archived or race */ }
	try {
		for (const w of deps.registry.list()) {
			if (w.sessionIds.includes(id)) {
				await w.detachSession(id);
				break;
			}
		}
	} catch { /* self-heals on next restart */ }

	report.deleted.push(id);
}

export default {
	name: "dsh-session-delete",
	inject: ["webServer", "sessionPersistence", "workspaceRegistry", "sessions"],

	apply(ctx) {
		const deps = {
			persistence: ctx.sessionPersistence,
			registry: ctx.workspaceRegistry,
			sessions: ctx.sessions
		};

		const routes = [
			// ---- Single session delete ----
			{
				path: "/dsh-session-delete/delete",
				handler: async (req, res) => {
					const body = await readJsonBody(req);
					if (body === null || typeof body.sessionId !== "string" || body.sessionId === "") {
						sendJson(res, 400, { ok: false, code: "bad-args" });
						return;
					}
					const report = { deleted: [], live: [], missing: [], failed: [] };
					await deleteOne(deps, body.sessionId, report);

					if (report.deleted.length > 0) sendJson(res, 200, { ok: true });
					else if (report.live.length > 0) sendJson(res, 409, { ok: false, code: "live" });
					else if (report.missing.length > 0) sendJson(res, 404, { ok: false, code: "missing" });
					else {
						const f = report.failed[0];
						sendJson(res, 500, {
							ok: false,
							code: f === undefined ? "unknown" : f.code,
							detail: f === undefined ? "" : f.detail
						});
					}
				}
			},

			// ---- Delete all sessions in a workspace ----
			{
				path: "/dsh-session-delete/delete-all",
				handler: async (req, res) => {
					const body = await readJsonBody(req);
					if (body === null || typeof body.workspaceId !== "string" || body.workspaceId === "") {
						sendJson(res, 400, { ok: false, code: "bad-args" });
						return;
					}
					const w = deps.registry.get(body.workspaceId);
					if (w === undefined) {
						sendJson(res, 404, { ok: false, code: "unknown-workspace" });
						return;
					}
					const report = { deleted: [], live: [], missing: [], failed: [] };
					for (const id of [...w.sessionIds]) await deleteOne(deps, id, report);

					sendJson(res, 200, {
						ok: true,
						deleted: report.deleted.length,
						live: report.live.length,
						missing: report.missing.length,
						failed: report.failed
					});
				}
			},

			// ---- Archive all unarchived sessions in a workspace ----
			{
				path: "/dsh-session-delete/archive-all",
				handler: async (req, res) => {
					const body = await readJsonBody(req);
					if (body === null || typeof body.workspaceId !== "string" || body.workspaceId === "") {
						sendJson(res, 400, { ok: false, code: "bad-args" });
						return;
					}
					const w = deps.registry.get(body.workspaceId);
					if (w === undefined) {
						sendJson(res, 404, { ok: false, code: "unknown-workspace" });
						return;
					}
					const archivedSet = new Set(deps.registry.archivedSessionIds);
					let count = 0;
					const failed = [];
					for (const id of [...w.sessionIds]) {
						if (archivedSet.has(id)) continue;
						try {
							await deps.registry.archiveSession(id);
							count += 1;
						} catch {
							failed.push(id);
						}
					}
					sendJson(res, 200, { ok: true, archived: count, failed });
				}
			}
		];

		for (const r of routes) {
			ctx.effect(() => ctx.webServer.register({ kind: "exact", path: r.path, handler: r.handler }));
		}
		log("host ready: POST /dsh-session-delete/{delete,delete-all,archive-all}");
	}
};