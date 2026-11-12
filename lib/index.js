/**
 * dsh-session-delete — host half.
 *
 * Mounts one local HTTP route: `POST /session-delete/api/delete`
 * (`{ "sessionId": "session-<uuid>" }`). The handler performs a REAL
 * file-system deletion of the session's durable artifact
 * (`~/.dsh/sessions/<cwd-key>/session-<uuid>/`, located through the official
 * `sessionPersistence.locate()` contract — never a hard-coded path), then
 * cleans the workspace registry accounting (sessionIds seat + global archive
 * set) through the registry's own operation queue, so the frontend receives
 * the same `domain/changed` frames as any official mutation.
 *
 * Safety:
 * - Requests pass the DSH web host's own trust fence: the official
 *   `connection` service's Host/Origin check plus browser-session
 *   authentication. Reverse-proxied deployments (an nginx LAN entry, for
 *   example) are therefore accepted when DSH lists their authority in
 *   `trustedHosts`; a host without that service falls back to the previous
 *   loopback-only check.
 * - `sessionId` must match `session-<uuid>` exactly (no traversal).
 * - Live sessions are cancelled and detached through the official services
 *   before their files are removed, so the in-memory log cannot resurrect
 *   the artifact and the frontend gets the official removal frame.
 * - Shared attachments are never touched (other sessions may reference them).
 *
 * Zero runtime dependencies: Node built-ins + injected services only.
 */
import { access, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const name = "dsh-session-delete";

/** Required services (cordis fiber inject): the web server route host. */
export const inject = ["webServer"];

/** A session id is `session-` followed by a lowercase uuid — the only accepted shape. */
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20;
const ROUTE_PREFIX = "/session-delete";

/** Business error carrying an HTTP status; rendered as `{ ok: false, error }`. */
class SessionDeleteError extends Error {
	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

/** Read and parse the JSON request body (bounded; malformed → bad-request). */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new SessionDeleteError("bad-request", "request body too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new SessionDeleteError("bad-request", "request body is not valid JSON");
	}
}

/** Write a JSON response with the given status. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}

/** Write the success envelope. */
function writeOk(res, value) {
	writeJson(res, 200, { ok: true, value });
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
function writeError(res, error) {
	if (error instanceof SessionDeleteError) {
		writeJson(res, error.status, {
			ok: false,
			error: { code: error.code, message: error.message }
		});
		return;
	}
	writeJson(res, 500, {
		ok: false,
		error: { code: "internal", message: String(error?.message ?? error) }
	});
}

/**
 * Only requests whose Host header names the local machine reach the deletion
 * route. An empty host (some proxies) is allowed; anything else is rejected.
 */
function isLocalRequest(req) {
	const host = req.headers?.host ?? "";
	return host === "" || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

/**
 * Reject a request the DSH web host would not accept itself.
 *
 * DSH exposes the same Host/Origin fence and browser-session check it applies
 * to its own API routes through the `connection` service. Reusing it keeps
 * this route working behind a reverse proxy (whose upstream Host is the
 * configured `trustedHosts` authority rather than a loopback name) without
 * weakening the CSRF/rebinding protection: a cross-site page cannot forge the
 * authenticated origin, and an unauthenticated request gets 401. Hosts that
 * predate the `connection` service keep the loopback-only check.
 * @param ctx - host plugin context.
 * @param req - incoming HTTP request.
 */
function assertTrustedRequest(ctx, req) {
	const connection = ctx.get("connection");
	if (connection !== void 0 && typeof connection.requestRejection === "function") {
		const rejection = connection.requestRejection(req);
		if (rejection === 401) throw new SessionDeleteError("unauthorized", "unauthorized", 401);
		if (rejection !== void 0) throw new SessionDeleteError("forbidden", "forbidden", 403);
		return;
	}
	if (!isLocalRequest(req)) throw new SessionDeleteError("forbidden", "forbidden", 403);
}

/**
 * Plugin body: mount the fenced route and delegate to the deletion routine.
 * @param ctx - host plugin context (webServer required; sessions,
 *   sessionPersistence and workspaceRegistry are read via ctx.get when present).
 */
export function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			try {
				assertTrustedRequest(ctx, req);
				if (req.method !== "POST") throw new SessionDeleteError("method-error", "method not allowed", 405);
				const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
				const endpoint = pathname.startsWith(`${ROUTE_PREFIX}/`) ? pathname.slice(ROUTE_PREFIX.length + 1) : void 0;
				if (endpoint !== "api/delete") {
					throw new SessionDeleteError("not-found", `unknown session-delete endpoint "${endpoint ?? ""}"`, 404);
				}
				writeOk(res, await deleteSession(ctx, await readJsonBody(req)));
			} catch (error) {
				writeError(res, error);
			}
		}
	}), "dsh-session-delete: routes");
}

/**
 * Physically delete one session and clean the workspace accounting. Live
 * sessions are deleted too: the running turn is cancelled through the agent
 * service and the in-memory session is detached through the store's own
 * disposal path, so the log can never be resurrected and the frontend
 * receives the official `session/disposed` → `host/session-removed` frame.
 * @param ctx - host plugin context.
 * @param payload - parsed JSON body.
 * @returns the deleted session id and the removed directory path.
 */
async function deleteSession(ctx, payload) {
	const sessionId = payload?.sessionId;
	if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
		throw new SessionDeleteError("invalid-session-id", "sessionId must look like 'session-<uuid>'");
	}

	const sessions = ctx.get("sessions");
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) {
		throw new SessionDeleteError("no-persistence", "session persistence service is unavailable", 500);
	}

	// Resolve the session header: live sessions carry it in memory (their
	// artifact may not be flushed yet); cold sessions come from persistence.
	const live = sessions?.get(sessionId);
	let header;
	if (live !== void 0) {
		// Cancel the running turn (best effort; detach below stops the log).
		const agents = ctx.get("agents");
		try {
			agents?.get(sessionId)?.cancel({ kind: "user" }, { keepInbox: false });
		} catch (error) {
			ctx.logger?.warn?.(`dsh-session-delete: cancel failed for ${sessionId}: ${String(error?.message ?? error)}`);
		}
		// Detach the in-memory session through the store's own disposal path:
		// without it the next append/flush would resurrect the file.
		const entry = sessions.store?.get(sessionId);
		if (entry?.detach === void 0) {
			throw new SessionDeleteError("session-live", "该会话当前处于打开状态且无法从内存移除，请重启 DSH 后再试。");
		}
		try {
			entry.detach();
		} catch (error) {
			throw new SessionDeleteError("detach-failed", `无法从内存移除会话：${String(error?.message ?? error)}`);
		}
		header = live.header;
	} else {
		// `sessionPersistence.list()` returns stored-log snapshots shaped
		// `{ header, revision, sizeBytes, location }`; the identity is
		// `header.id` (older hosts may still return bare headers).
		const snapshots = await persistence.list();
		const snapshot = snapshots.find((entry) => String(entry?.header?.id ?? entry?.id) === sessionId);
		if (snapshot === void 0) {
			throw new SessionDeleteError("session-not-found", `会话 ${sessionId} 不存在`, 404);
		}
		header = snapshot.header ?? snapshot;
	}

	// Locate the durable artifact through the official persistence contract.
	const location = persistence.locate(header);
	if (location?.kind !== "jsonl" || typeof location.path !== "string") {
		throw new SessionDeleteError("unsupported-backend", `unsupported persistence backend "${String(location?.kind)}"`, 500);
	}

	// Delete the whole session directory (the log plus any side artifacts the
	// backend keeps there). Shared attachments live elsewhere and stay.
	const sessionDir = dirname(location.path);
	await rm(sessionDir, { recursive: true, force: true });
	try {
		await access(sessionDir);
		// Still there: report a loud failure rather than a silent no-op.
		throw new SessionDeleteError("delete-failed", `无法删除会话目录 ${sessionDir}`, 500);
	} catch (error) {
		if (error instanceof SessionDeleteError) throw error;
		// ENOENT — the directory is gone, which is what we want.
	}

	// Clean the workspace registry accounting through its own operation queue,
	// so the frontend gets the same domain/changed frames as official writes.
	await removeSessionAccounting(ctx, sessionId);

	return { sessionId, path: sessionDir };
}

/**
 * Remove the session id from every workspace `sessionIds` seat and from the
 * global archived set. Uses the registry instance's own queue/state methods
 * (plain JS members of the official WorkspaceRegistry) so persistence and
 * change frames stay consistent with the rest of the system.
 * @param ctx - host plugin context.
 * @param sessionId - the deleted session id.
 */
async function removeSessionAccounting(ctx, sessionId) {
	const registry = ctx.get("workspaceRegistry");
	if (registry === void 0 || typeof registry.enqueueOperation !== "function") return;
	await registry.enqueueOperation(async () => {
		const table = registry.requireTable();
		const updates = [];
		for (const [id, record] of table.entries()) {
			if (Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId)) {
				updates.push(table.update(id, (current) => ({
					...current,
					sessionIds: current.sessionIds.filter((entry) => entry !== sessionId)
				})));
			}
		}
		await Promise.all(updates);
		const state = registry.requireState();
		if (state.archivedSessionIds.includes(sessionId)) {
			await registry.setState({
				...state,
				archivedSessionIds: state.archivedSessionIds.filter((entry) => entry !== sessionId)
			});
		}
	});
}
