/**
 * dsh-session-delete — web client half.
 *
 * Adds a "删除对话 / Delete session" entry below the official "归档会话 /
 * Archive session" row of every conversation's ellipsis menu. Clicking it
 * asks for confirmation and calls the host route
 * `POST /session-delete/api/delete`, which physically removes the session's
 * log files from disk (no archive/hide). On success the official session and
 * workspace stores are refreshed through their runtime services, so the row
 * disappears without a page reload.
 *
 * The official row menu has no slot, so this half injects a clone of the
 * archive entry into the rendered `role="menu"` DOM and resolves the target
 * session id from the sidebar row position against the official
 * `ctx.sessions` / `ctx.workspaces` snapshot stores (the exact data the UI
 * renders from), guarded by the row title from the anchor's aria-label.
 *
 * Zero runtime dependencies: platform modules (react / primitives are not
 * even required here) + injected services only.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const DELETE_ROUTE = "/session-delete/api/delete";
		/** Locale-dependent labels of the official archive entry (both shipped locales). */
		const ARCHIVE_LABELS = ["归档会话", "Archive session"];
		/** Trash icon path, same geometry as the official IconTrashOutline16. */
		const TRASH_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.67369 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z" fill="currentColor"/></svg>';

		/** Required services: the official runtime stores + wire client. */
		const inject = ["sessions", "workspaces", "connection"];

		/** Plugin context captured in apply() for the DOM handlers. */
		let ctx = null;
		/** The anchor button of the most recently opened row menu (capture-phase click). */
		let lastAnchor = null;
		/** Mutation observer injecting the delete entry into freshly rendered menus. */
		let observer = null;

		/** Whether the UI language is Chinese (for our own labels/dialogs). */
		function isZh() {
			return (document.documentElement.lang || navigator.language || "").toLowerCase().startsWith("zh");
		}

		/** Extract the session title from the anchor's official aria-label. */
		function titleFromLabel(button) {
			const label = button.getAttribute("aria-label") ?? "";
			const zh = label.match(/^会话["“](.+)["”]的操作$/);
			if (zh !== null) return zh[1];
			const en = label.match(/^Session actions for (.+)$/);
			if (en !== null) return en[1];
			return "";
		}

		/**
		 * Resolve the session id behind one sidebar row, using the exact
		 * snapshot stores the official UI renders from, plus the rendered DOM
		 * order (which is authoritative for what the user actually sees).
		 *
		 * Layout facts this relies on:
		 * - the session tree (`[role="tree"]`) renders one section per group;
		 *   each section starts with a group header row (`[role="treeitem"]`
		 *   with `aria-expanded`), followed by session rows (`[role="treeitem"]`
		 *   without it). Rows are wrapped in a HoverCard `<span>`, so we never
		 *   assume direct parent-child relationships — DOM order alone decides.
		 * - group sections render in workspace order (Ungrouped last, only when
		 *   it has members); within a section, session rows render in the
		 *   workspace's visible sessionIds order (archived members are hidden,
		 *   collapsed groups keep the leading rows).
		 * - the flat "In one list" view has no group headers; rows follow the
		 *   session list order.
		 *
		 * Account order is tried first, updatedAt order as a fallback, and the
		 * row title from the anchor's aria-label as a guard. If the title is
		 * unique inside the group, it wins even when the order assumptions
		 * fail, so deletion keeps working under local reorderings.
		 * @param row - the `[role="treeitem"]` session row element.
		 * @param runtime - optional store overrides (testing); defaults to the
		 *   plugin context.
		 * @param anchor - optional anchor button (testing); defaults to the
		 *   most recently opened menu anchor.
		 * @returns the session id, or null when the row cannot be identified.
		 */
		function resolveSessionId(row, runtime, anchor) {
			const active = runtime ?? ctx;
			if (active === null) return null;
			const slist = active.sessions.list.getSnapshot();
			const wlist = active.workspaces.list.getSnapshot();
			const tree = row.closest('[role="tree"]');
			if (tree === null || tree === void 0) return null;

			const archived = wlist.archivedSessionIds ?? [];
			const byId = slist.byId ?? {};
			const anchorEl = anchor ?? lastAnchor;
			const title = anchorEl === null ? "" : titleFromLabel(anchorEl);

			// All rows in DOM order (group headers included).
			const allRows = [...tree.querySelectorAll('[role="treeitem"]')];
			const rowIndex = allRows.indexOf(row);
			if (rowIndex === -1) return null;
			const headerIndexes = [];
			allRows.forEach((entry, index) => {
				if (entry.hasAttribute("aria-expanded")) headerIndexes.push(index);
			});

			let candidates;
			let inGroupIndex;
			if (headerIndexes.length === 0) {
				// Flat view: no headers; rows follow the session list order.
				candidates = slist.ids.filter((id) => byId[id] !== void 0 && !archived.includes(id));
				inGroupIndex = rowIndex;
			} else {
				// The row belongs to the group whose header precedes it: the
				// group number is the index of the last header before the row.
				let groupIndex = -1;
				for (let index = 0; index < headerIndexes.length; index += 1) {
					if (headerIndexes[index] < rowIndex) groupIndex = index;
					else break;
				}
				if (groupIndex === -1) return null;
				inGroupIndex = rowIndex - headerIndexes[groupIndex] - 1;
				if (groupIndex < wlist.items.length) {
					const workspace = wlist.items[groupIndex];
					candidates = workspace.sessionIds.filter((id) => !archived.includes(id));
				} else {
					// Ungrouped bucket: every listed session not accounted by a workspace.
					const accounted = new Set(wlist.items.flatMap((workspace) => workspace.sessionIds));
					candidates = slist.ids.filter((id) => byId[id] !== void 0 && !accounted.has(id) && !archived.includes(id));
				}
			}
			if (inGroupIndex < 0) return null;

			const displayTitleOf = (id) => byId[id]?.displayTitle ?? byId[id]?.title;
			const matchesTitle = (id) => {
				if (title === "") return true;
				const candidateTitle = displayTitleOf(id);
				return candidateTitle === void 0 || candidateTitle === "" || candidateTitle === title;
			};
			const byUpdated = [...candidates].sort((a, b) => (byId[b]?.updatedAt ?? 0) - (byId[a]?.updatedAt ?? 0));
			const pick = (list) => (inGroupIndex < list.length ? list[inGroupIndex] : null);

			const accountPick = pick(candidates);
			if (accountPick !== null && matchesTitle(accountPick)) return accountPick;
			const updatedPick = pick(byUpdated);
			if (updatedPick !== null && matchesTitle(updatedPick)) return updatedPick;
			// Last resort: a title unique inside the group identifies the row
			// even when every order assumption failed (e.g. local reordering).
			if (title !== "") {
				const byTitle = candidates.filter((id) => {
					const candidateTitle = displayTitleOf(id);
					return candidateTitle !== void 0 && candidateTitle !== "" && candidateTitle === title;
				});
				if (byTitle.length === 1) return byTitle[0];
			}
			if (typeof console !== "undefined") {
				console.warn("dsh-session-delete: cannot resolve session", {
					rowIndex,
					headerCount: headerIndexes.length,
					candidateCount: candidates.length,
					title
				});
			}
			return null;
		}

		/** Inject one "删除对话" entry below the archive entry of a session menu. */
		function injectDeleteEntry(menu) {
			if (menu.dataset.sessionDeleteInjected === "1") return;
			const items = [...menu.querySelectorAll('button[role="menuitem"]')];
			const archive = items.find((button) => ARCHIVE_LABELS.some((label) => (button.textContent ?? "").includes(label)));
			if (archive === void 0) return;
			const wrap = archive.parentElement;
			if (wrap === null || wrap.parentElement === null) return;

			const clone = wrap.cloneNode(true);
			const button = clone.querySelector('button[role="menuitem"]');
			if (button === null) return;

			// Replace the icon slot with a trash icon and the label with ours.
			const iconSlot = button.querySelector("span");
			if (iconSlot !== null) {
				iconSlot.innerHTML = TRASH_SVG;
				iconSlot.style.display = "inline-flex";
				iconSlot.style.alignItems = "center";
			}
			const labelSlot = [...button.querySelectorAll("span")].find((span) => ARCHIVE_LABELS.some((label) => (span.textContent ?? "").includes(label)));
			if (labelSlot !== void 0) labelSlot.textContent = isZh() ? "删除对话" : "Delete session";
			// Danger affordance: error color, kept readable on both themes.
			button.style.color = "var(--dsw-alias-state-error-primary, #d64545)";

			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void handleDeleteClicked();
			});

			wrap.parentElement.insertBefore(clone, wrap.nextSibling);
			menu.dataset.sessionDeleteInjected = "1";
		}

		/** Scan a newly added subtree for rendered session menus and inject. */
		function scanForMenus(root) {
			if (root.nodeType !== 1) return;
			const element = root;
			if (element.matches?.('[role="menu"]') === true) injectDeleteEntry(element);
			for (const menu of element.querySelectorAll?.('[role="menu"]') ?? []) injectDeleteEntry(menu);
		}

		/**
		 * The delete entry was clicked: close the menu, identify the session,
		 * confirm, call the host deletion route and refresh the official stores.
		 */
		async function handleDeleteClicked() {
			const anchor = lastAnchor;
			if (anchor === null || ctx === null) return;
			const row = anchor.closest('[role="treeitem"]');
			if (row === null) return;

			// Close the official menu the same way Escape does.
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

			const sessionId = resolveSessionId(row);
			if (sessionId === null) {
				window.alert(isZh() ? "无法识别该会话，请刷新页面后重试。" : "Could not identify this session. Please refresh and try again.");
				return;
			}
			const title = titleFromLabel(anchor) || sessionId;
			const message = isZh()
				? `确定要永久删除会话“${title}”吗？\n\n该会话的日志文件将从磁盘彻底删除，无法恢复。`
				: `Permanently delete session "${title}"?\n\nThe session log files will be removed from disk and cannot be recovered.`;
			if (!window.confirm(message)) return;

			try {
				const response = await fetch(DELETE_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				});
				const body = await response.json().catch(() => null);
				if (response.ok !== true || body === null || body.ok !== true) {
					throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
				}

				// The host answered OK: the log directory is gone. Re-pull the
				// official Session list so the row disappears without a reload. The
				// Workspace store is a live stream that already reflects the host's
				// accounting cleanup (it exposes no refresh method). A refresh
				// failure must never turn a completed deletion into an error alert.
				try {
					if (typeof ctx.sessions.refresh === "function") await ctx.sessions.refresh();
				} catch (error) {
					console.warn("dsh-session-delete: session list refresh failed", error);
				}
				window.alert(isZh() ? `会话“${title}”已永久删除。` : `Session "${title}" was permanently deleted.`);
			} catch (error) {
				window.alert(isZh() ? `删除失败：${String(error?.message ?? error)}` : `Delete failed: ${String(error?.message ?? error)}`);
			}
		}

		/** Plugin body: install the capture listener, the menu observer and cleanup. */
		function apply(pluginCtx) {
			ctx = pluginCtx;

			ctx.effect(() => {
				// Capture phase runs before the official onClick's stopPropagation,
				// so we can remember which row menu anchor was just opened.
				const onCaptureClick = (event) => {
					const target = event.target;
					if (!(target instanceof Element)) return;
					if (target.closest('[role="menu"]') !== null) return;
					const button = target.closest('button[aria-label]');
					if (button === null) return;
					const row = button.closest('[role="treeitem"]');
					if (row === null) return;
					lastAnchor = button;
				};
				document.addEventListener("click", onCaptureClick, true);

				observer = new MutationObserver((mutations) => {
					for (const mutation of mutations) {
						for (const node of mutation.addedNodes) {
							if (node instanceof Element) scanForMenus(node);
						}
					}
				});
				observer.observe(document.body, { childList: true, subtree: true });
				// Catch any menu that was already rendered before we started.
				for (const menu of document.querySelectorAll('[role="menu"]')) injectDeleteEntry(menu);

				return () => {
					document.removeEventListener("click", onCaptureClick, true);
					observer?.disconnect();
					observer = null;
					lastAnchor = null;
					ctx = null;
				};
			}, "dsh-session-delete: menu injection");
		}

		exports.apply = apply;
		exports.inject = inject;
		// Internal surface for the verify harness (DOM-order resolution logic);
		// harmless to the runtime, which only consumes apply/inject.
		exports._resolveSessionId = resolveSessionId;
		return module.exports;
	}
});
