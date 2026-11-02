/**
 * dsh-session-delete — web client half.
 *
 * Injects "Delete Session" / "Delete All Sessions" / "Archive All Sessions"
 * entries into the sidebar row menus by cloning an existing menu-item wrapper
 * from the portal menu surface (`div[data-menu-material="translucent"]`).
 *
 * Updated for DSH >= 0.2.0-rc.2:
 *   - Menu surfaces use `data-menu-material="translucent"`, not `role="menu"`.
 *   - Session rows carry `data-row-key="session:<id>"`.
 *   - Workspace rows carry `data-row-key="workspace:<key>"`.
 *   - No `div[role="presentation"]` viewport — inject directly into the surface.
 *
 * Zero runtime dependencies: platform fetch/document + injected services only.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/* ========== Helpers ========== */

		function isZh(localeService) {
			try {
				var snap = localeService !== undefined && typeof localeService.getLocale === "function"
					? localeService.getLocale() : undefined;
				var lid = typeof snap === "string" ? snap
					: (snap !== null && snap !== undefined && typeof snap.id === "string" ? snap.id : "");
				return lid.toLowerCase().indexOf("en") !== 0;
			} catch (e) { return true; }
		}

		/* ========== Dictionary ========== */
		var DICT = {
			zh: {
				deleteSession: "删除会话",
				archiveAll: "归档全部会话",
				deleteAll: "删除全部会话",
				delTitle: "删除会话",
				delBody: function (t) { return "将永久删除会话「" + t + "」的全部本地记录（含日志文件），不可恢复。"; },
				archTitle: "归档全部会话",
				archBody: function (l, n) { return "将归档工作区「" + l + "」下未归档的 " + n + " 个会话。归档的会话不再显示，但记录保留。"; },
				delAllTitle: "删除全部会话",
				delAllBody: function (l, n) { return "将永久删除工作区「" + l + "」下全部 " + n + " 个会话（含已归档）的本地记录，不可恢复。正在运行的会话将被跳过。"; },
				cancel: "取消", ok: "好的", busy: "处理中…",
				errLive: "该会话正在运行或已被打开，无法删除。请重启 DSH 后再试。",
				errMissing: "未找到该会话的持久化记录。",
				errNetwork: "请求失败（服务不可达）。",
				errUnknown: "操作失败。",
				archResult: function (n, f) { return "已归档 " + n + " 个会话。" + (f > 0 ? " 失败 " + f + " 个。" : ""); },
				delAllResult: function (d, lv, f) { return "已删除 " + d + " 个" + (lv > 0 ? "，跳过运行中 " + lv + " 个" : "") + (f > 0 ? "，失败 " + f + " 个" : "") + "。"; }
			},
			en: {
				deleteSession: "Delete Session",
				archiveAll: "Archive All Sessions",
				deleteAll: "Delete All Sessions",
				delTitle: "Delete session",
				delBody: function (t) { return "Permanently delete all local records (including the log file) of session \"" + t + "\". This cannot be undone."; },
				archTitle: "Archive all sessions",
				archBody: function (l, n) { return "Archive " + n + " unarchived sessions in workspace \"" + l + "\". Archived sessions are hidden but kept."; },
				delAllTitle: "Delete all sessions",
				delAllBody: function (l, n) { return "Permanently delete all " + n + " sessions (archived included) in workspace \"" + l + "\". Running sessions are skipped. This cannot be undone."; },
				cancel: "Cancel", ok: "OK", busy: "Working…",
				errLive: "This session is live in the current process and cannot be deleted. Restart DSH first.",
				errMissing: "No persisted record found for this session.",
				errNetwork: "Request failed (service unreachable).",
				errUnknown: "Operation failed.",
				archResult: function (n, f) { return "Archived " + n + " session(s)." + (f > 0 ? " Failed: " + f + "." : ""); },
				delAllResult: function (d, lv, f) { return "Deleted " + d + "." + (lv > 0 ? " Skipped running: " + lv + "." : "") + (f > 0 ? " Failed: " + f + "." : ""); }
			}
		};

		/* ========== SVG Icons ========== */
		var ICONS = {
			trash: "M2.5 4.2h11M6.3 2h3.4M4.2 4.2l.6 8.6c0 .7.6 1.2 1.2 1.2h4c.7 0 1.2-.5 1.2-1.2l.6-8.6M6.5 7v4.2M9.5 7v4.2",
			archive: "M2.2 4.3h11.6M3.2 4.3v7.7c0 .9.7 1.6 1.6 1.6h6.4c.9 0 1.6-.7 1.6-1.6V4.3M6.4 7.8h3.2M2.2 4.3l.9-2.1h9.8l.9 2.1"
		};

		function makeIcon(d) {
			var NS = "http://www.w3.org/2000/svg";
			var svg = document.createElementNS(NS, "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("width", "16");
			svg.setAttribute("height", "16");
			var path = document.createElementNS(NS, "path");
			path.setAttribute("d", d);
			path.setAttribute("fill", "none");
			path.setAttribute("stroke", "currentColor");
			path.setAttribute("stroke-width", "1.3");
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("stroke-linejoin", "round");
			svg.appendChild(path);
			return svg;
		}

		/* ========== Host API ========== */
		async function callApi(path, body) {
			var r;
			try {
				r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			} catch (e) { return null; }
			try { return await r.json(); } catch (e) { return null; }
		}

		/* ========== Modal ========== */
		var openModalClose = null;
		function openConfirm(L, cfg) {
			if (openModalClose !== null) openModalClose();
			var overlay = document.createElement("div");
			overlay.className = "sesdel-overlay";
			var modal = document.createElement("div");
			modal.className = "sesdel-modal";
			modal.setAttribute("role", "dialog");
			modal.setAttribute("aria-modal", "true");
			var title = document.createElement("div");
			title.className = "sesdel-title";
			title.textContent = cfg.title;
			var body = document.createElement("div");
			body.className = "sesdel-body";
			body.textContent = cfg.body;
			var err = document.createElement("div");
			err.className = "sesdel-error";
			err.setAttribute("role", "alert");
			var footer = document.createElement("div");
			footer.className = "sesdel-footer";
			var btnCancel = document.createElement("button");
			btnCancel.type = "button";
			btnCancel.className = "sesdel-btn";
			btnCancel.textContent = L.cancel;
			var btnOk = document.createElement("button");
			btnOk.type = "button";
			btnOk.className = "sesdel-btn sesdel-btn-primary" + (cfg.danger ? " sesdel-danger" : "");
			btnOk.textContent = cfg.confirm;
			footer.appendChild(btnCancel);
			footer.appendChild(btnOk);
			modal.appendChild(title); modal.appendChild(body); modal.appendChild(err); modal.appendChild(footer);
			overlay.appendChild(modal);
			function close() {
				document.removeEventListener("keydown", onKey);
				if (overlay.parentNode !== null) overlay.parentNode.removeChild(overlay);
				if (openModalClose === close) openModalClose = null;
			}
			function onKey(e) { if (e.key === "Escape") close(); }
			overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
			document.addEventListener("keydown", onKey);
			btnCancel.addEventListener("click", close);
			btnOk.addEventListener("click", async function () {
				btnOk.disabled = true;
				btnOk.textContent = L.busy;
				err.textContent = "";
				try {
					var outcome = await cfg.run();
					if (typeof outcome === "string" && outcome !== "") {
						err.textContent = outcome;
						btnOk.disabled = false;
						btnOk.textContent = cfg.confirm;
						return;
					}
					if (outcome !== null && typeof outcome === "object" && typeof outcome.done === "string") {
						body.textContent = outcome.done;
						while (footer.firstChild !== null) footer.removeChild(footer.firstChild);
						var okBtn = document.createElement("button");
						okBtn.type = "button";
						okBtn.className = "sesdel-btn sesdel-btn-primary";
						okBtn.textContent = L.ok;
						okBtn.addEventListener("click", close);
						footer.appendChild(okBtn);
						okBtn.focus();
						return;
					}
					close();
				} catch (e2) {
					err.textContent = e2 !== null && e2 !== undefined && e2.message ? String(e2.message) : String(e2);
					btnOk.disabled = false;
					btnOk.textContent = cfg.confirm;
				}
			});
			openModalClose = close;
			document.body.appendChild(overlay);
			btnOk.focus();
		}

		function errorText(L, res) {
			if (res === null || res === undefined) return L.errNetwork;
			if (res.code === "live") return L.errLive;
			if (res.code === "missing") return L.errMissing;
			return L.errUnknown + (res.code ? " (" + String(res.code) + ")" : "");
		}

		/* ========== Workspace counts ========== */
		function workspaceCounts(ctx, workspaceId) {
			try {
				var ws = ctx.get("workspaces");
				if (ws === undefined || ws.list === undefined || typeof ws.list.getSnapshot !== "function") return null;
				var snap = ws.list.getSnapshot();
				var item = snap !== null && snap !== undefined && Array.isArray(snap.items)
					? snap.items.find(function (w) { return w.workspaceId === workspaceId; })
					: undefined;
				if (item === undefined || !Array.isArray(item.sessionIds)) return null;
				var archived = new Set(Array.isArray(snap.archivedSessionIds) ? snap.archivedSessionIds : []);
				var unarchived = 0;
				for (var i = 0; i < item.sessionIds.length; i++) {
					if (!archived.has(item.sessionIds[i])) unarchived += 1;
				}
				return { total: item.sessionIds.length, unarchived: unarchived };
			} catch (e) { return null; }
		}

		/* ========== Row identification via data-row-key ========== */
		function resolveSessionId(rowEl) {
			if (rowEl === null || rowEl === undefined) return null;
			var key = rowEl.getAttribute("data-row-key");
			if (key === null || key === undefined) return null;
			if (key.indexOf("session:") === 0) return key.slice(8);
			return null;
		}

		function resolveSessionTitle(rowEl) {
			if (rowEl === null || rowEl === undefined) return "";
			var spans = rowEl.querySelectorAll("span");
			for (var i = 0; i < spans.length; i++) {
				var cls = spans[i].className;
				if (typeof cls === "string" && cls.indexOf("_title") !== -1) {
					return (spans[i].textContent || "").trim();
				}
			}
			// Fallback: find the longest plain-text span
			var best = "";
			for (var j = 0; j < spans.length; j++) {
				var text = (spans[j].textContent || "").trim();
				if (text.length > best.length) best = text;
			}
			return best;
		}

		function resolveWorkspace(rowEl) {
			if (rowEl === null || rowEl === undefined) return null;
			var key = rowEl.getAttribute("data-row-key");
			if (key === null || key === undefined) return null;
			if (key.indexOf("workspace:") === 0) {
				var label = "";
				var spans = rowEl.querySelectorAll("span");
				for (var i = 0; i < spans.length; i++) {
					var cls = spans[i].className;
					if (typeof cls === "string" && cls.indexOf("_title") !== -1) {
						label = (spans[i].textContent || "").trim();
						break;
					}
				}
				return { workspaceId: key.slice(10), label: label };
			}
			return null;
		}

		/* ========== Menu type detection ========== */
		/**
		 * Extract the visible label text from a menu item button,
		 * skipping the shortcut span (which would make textContent inaccurate).
		 * MenuItemButton renders: <button><span icon/><span label/><span shortcut/></button>
		 */
		function menuItemLabel(btn) {
			var spans = btn.querySelectorAll(":scope > span");
			for (var i = 0; i < spans.length; i++) {
				// Skip icon span (contains svg)
				if (spans[i].querySelector("svg") !== null) continue;
				var cls = spans[i].getAttribute("class") || "";
				// Skip shortcut span
				if (cls.indexOf("shortcut") !== -1) continue;
				// This is the label span
				return (spans[i].textContent || "").trim();
			}
			// Fallback: use the button's textContent minus any shortcut text
			return (btn.textContent || "").trim();
		}

		/** Detect session menu: has "rename" + ("archive" or "fork") items */
		function isSessionMenu(menuEl) {
			var buttons = menuEl.querySelectorAll('button[role="menuitem"]');
			var labels = [];
			for (var i = 0; i < buttons.length; i++) {
				labels.push(menuItemLabel(buttons[i]));
			}
			return labels.some(function (l) { return l === "重命名" || l === "Rename"; })
				&& labels.some(function (l) { return l === "归档会话" || l === "Archive session" || l === "取消归档" || l === "Unarchive session"; });
		}

		/** Detect workspace menu: has "rename" + "delete workspace" items */
		function isWorkspaceMenu(menuEl) {
			var buttons = menuEl.querySelectorAll('button[role="menuitem"]');
			var labels = [];
			for (var i = 0; i < buttons.length; i++) {
				labels.push(menuItemLabel(buttons[i]));
			}
			return labels.some(function (l) { return l === "重命名" || l === "Rename"; })
				&& labels.some(function (l) { return l === "删除工作区" || l === "Delete workspace"; });
		}

		/* ========== DOM injection ========== */
		function closeOpenMenu() {
			try {
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			} catch (e) {}
		}

		/**
		 * Clone an existing `role="menuitem"` button wrapper and inject a new item.
		 * The template is one of the existing item-wrapping divs inside the surface.
		 */
		function injectMenuItem(menuEl, templateWrap, dangerWrap, label, iconD, danger, handler) {
			var clone = templateWrap.cloneNode(true);
			var btn = clone.querySelector('button[role="menuitem"]');
			if (btn === null) return;

			// Apply danger styling from the "delete workspace" item
			if (danger && dangerWrap !== null) {
				var dangerBtn = dangerWrap.querySelector('button[role="menuitem"]');
				if (dangerBtn !== null) {
					var dangerClass = dangerBtn.getAttribute("class") || "";
					btn.setAttribute("class", dangerClass);
				}
			} else if (danger) {
				btn.style.color = "var(--dsw-alias-state-error-primary, #d92d20)";
			}

			// Replace icon
			var oldSvg = btn.querySelector("svg");
			var icon = makeIcon(iconD);
			if (oldSvg !== null && oldSvg.parentNode !== null) {
				oldSvg.parentNode.replaceChild(icon, oldSvg);
			} else {
				btn.insertBefore(icon, btn.firstChild);
			}

			// Replace label text — find the label span (usually the last plain span or a text node)
			var labelSpan = null;
			var spans = btn.querySelectorAll(":scope > span");
			for (var s = 0; s < spans.length; s++) {
				var span = spans[s];
				// Skip icon span (contains svg)
				if (span.querySelector("svg") !== null) continue;
				// Skip shortcut span
				var scls = span.getAttribute("class") || "";
				if (scls.indexOf("shortcut") !== -1) continue;
				if (span.children.length === 0) { labelSpan = span; break; }
			}
			if (labelSpan !== null) {
				labelSpan.textContent = label;
			} else {
				// Remove text nodes and add new text
				for (var t = btn.childNodes.length - 1; t >= 0; t--) {
					if (btn.childNodes[t].nodeType === 3) btn.removeChild(btn.childNodes[t]);
				}
				btn.appendChild(document.createTextNode(" " + label));
			}

			btn.addEventListener("click", function (e) {
				e.stopPropagation();
				e.preventDefault();
				handler();
			});
			menuEl.appendChild(clone);
		}

		/** Get item-wrapping divs from the menu surface */
		function getItemWraps(menuEl) {
			var wraps = [];
			var children = menuEl.children;
			for (var i = 0; i < children.length; i++) {
				var child = children[i];
				if (child.tagName === "DIV" && child.querySelector('button[role="menuitem"]') !== null) {
					wraps.push(child);
				}
			}
			return wraps;
		}

		/**
		 * Inject session delete item into a session menu.
		 */
		function injectSessionDelete(menuEl, L, sessionId, title) {
			if (menuEl.getAttribute("data-sesdel") !== null) return;
			menuEl.setAttribute("data-sesdel", "1");

			var wraps = getItemWraps(menuEl);
			if (wraps.length === 0) return;
			var template = wraps[0];
			// No danger template for session menu (archive item is not danger-styled)
			var dangerWrap = null;

			injectMenuItem(menuEl, template, dangerWrap, L.deleteSession, ICONS.trash, true, function () {
				closeOpenMenu();
				openConfirm(L, {
					title: L.delTitle,
					body: L.delBody(title),
					confirm: L.deleteSession,
					danger: true,
					run: async function () {
						var res = await callApi("/dsh-session-delete/delete", { sessionId: sessionId });
						if (res !== null && res !== undefined && res.ok) return null;
						return errorText(L, res);
					}
				});
			});
		}

		/**
		 * Inject archive-all and delete-all items into a workspace menu.
		 */
		function injectWorkspaceItems(menuEl, L, row) {
			if (menuEl.getAttribute("data-sesdel") !== null) return;
			menuEl.setAttribute("data-sesdel", "1");

			var wraps = getItemWraps(menuEl);
			if (wraps.length === 0) return;
			var template = wraps[0];
			// Find the delete-workspace item for danger styling
			var dangerWrap = null;
			for (var d = 0; d < wraps.length; d++) {
				var btn = wraps[d].querySelector('button[role="menuitem"]');
				if (btn !== null) {
					var text = (btn.textContent || "").trim();
					if (text === "删除工作区" || text === "Delete workspace") { dangerWrap = wraps[d]; break; }
				}
			}

			injectMenuItem(menuEl, template, dangerWrap, L.archiveAll, ICONS.archive, false, function () {
				closeOpenMenu();
				var c = workspaceCounts(ctx, row.workspaceId);
				openConfirm(L, {
					title: L.archTitle,
					body: c === null ? L.archBody(row.label, 0) : L.archBody(row.label, c.unarchived || 0),
					confirm: L.archiveAll,
					danger: false,
					run: async function () {
						var res = await callApi("/dsh-session-delete/archive-all", { workspaceId: row.workspaceId });
						if (res === null || res === undefined || !res.ok) return errorText(L, res);
						return { done: L.archResult(res.archived, (res.failed || []).length) };
					}
				});
			});

			injectMenuItem(menuEl, template, dangerWrap, L.deleteAll, ICONS.trash, true, function () {
				closeOpenMenu();
				var c = workspaceCounts(ctx, row.workspaceId);
				openConfirm(L, {
					title: L.delAllTitle,
					body: c === null ? L.delAllBody(row.label, 0) : L.delAllBody(row.label, c.total || 0),
					confirm: L.deleteAll,
					danger: true,
					run: async function () {
						var res = await callApi("/dsh-session-delete/delete-all", { workspaceId: row.workspaceId });
						if (res === null || res === undefined || !res.ok) return errorText(L, res);
						return { done: L.delAllResult(res.deleted, res.live, (res.failed || []).length) };
					}
				});
			});
		}

		/* ========== Plugin state ========== */
		var ctx = null;
		/** The most recently clicked row's resolved data (session or workspace) */
		var pendingRow = null;

		/* ========== Plugin body ========== */
		function apply(pluginCtx) {
			ctx = pluginCtx;
			if (typeof document === "undefined" || document.body === null) return;

			/* ---- Styles ---- */
			var styleTag = document.createElement("style");
			styleTag.setAttribute("data-plugin", "dsh-session-delete");
			styleTag.textContent = [
				".sesdel-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}",
				".sesdel-modal{min-width:340px;max-width:460px;background:var(--dsw-alias-button-elevated-fill,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l,rgba(0,0,0,.08));border-radius:12px;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.28);}",
				".sesdel-title{font-size:16px;font-weight:600;margin:0 0 8px;}",
				".sesdel-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#555);margin:0;white-space:pre-wrap;word-break:break-all;}",
				".sesdel-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d92d20);margin:8px 0 0;white-space:pre-wrap;}",
				".sesdel-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;}",
				".sesdel-btn{min-width:76px;height:30px;padding:0 12px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid var(--dsw-alias-border-l,rgba(9,9,11,.2));background:transparent;color:inherit;}",
				".sesdel-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}",
				".sesdel-btn-primary{background:var(--dsw-alias-state-business-primary,#2f6fed);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff);}",
				".sesdel-btn-primary.sesdel-danger{background:var(--dsw-alias-state-error-primary,#d92d20);}",
				".sesdel-btn-primary:disabled{opacity:.55;cursor:default;}"
			].join("\n");
			document.head.appendChild(styleTag);

			/* ---- Language ---- */
			var lang = isZh(ctx.get("locale")) ? "zh" : "en";
			var L = DICT[lang];

			/* ---- Click capture: record which row was clicked ---- */
			var onClick = function (e) {
				try {
					var t = e.target;
					if (t === null || t === undefined || typeof t.closest !== "function") return;
					var rowEl = t.closest('div[role="treeitem"]');
					if (rowEl === null) return;

					var sessionId = resolveSessionId(rowEl);
					if (sessionId !== null) {
						pendingRow = {
							kind: "session",
							sessionId: sessionId,
							title: resolveSessionTitle(rowEl),
							ts: Date.now()
						};
						return;
					}
					var workspace = resolveWorkspace(rowEl);
					if (workspace !== null) {
						pendingRow = {
							kind: "workspace",
							workspaceId: workspace.workspaceId,
							label: workspace.label,
							ts: Date.now()
						};
					}
				} catch (err) {
					console.error("[dsh-session-delete] click hook:", err);
				}
			};
			document.addEventListener("click", onClick, true);

			/* ---- Mutation observer: watch for portal menu surfaces ---- */
			var observer = new MutationObserver(function (muts) {
				for (var m = 0; m < muts.length; m++) {
					var added = muts[m].addedNodes;
					for (var n = 0; n < added.length; n++) {
						var node = added[n];
						if (!(node instanceof Element)) continue;

						// The menu surface is `div[data-menu-material="translucent"]`
						var menus = node.hasAttribute("data-menu-material")
							? [node]
							: (typeof node.querySelectorAll === "function"
								? Array.from(node.querySelectorAll('div[data-menu-material="translucent"]'))
								: []);

						for (var k = 0; k < menus.length; k++) {
							try {
								var menuEl = menus[k];
								var row = pendingRow !== null && Date.now() - pendingRow.ts < 3000 ? pendingRow : null;

								if (row !== null && row.kind === "session" && isSessionMenu(menuEl)) {
									injectSessionDelete(menuEl, L, row.sessionId, row.title);
									console.log("[dsh-session-delete] injected session delete for", row.sessionId);
								} else if (row !== null && row.kind === "workspace" && isWorkspaceMenu(menuEl)) {
									injectWorkspaceItems(menuEl, L, row);
									console.log("[dsh-session-delete] injected workspace items for", row.workspaceId);
								}
							} catch (err) {
								console.error("[dsh-session-delete] inject error:", err);
							}
						}
					}
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });

			console.log("[dsh-session-delete] client ready, lang=" + lang);

			/* ---- Cleanup ---- */
			ctx.effect(function () {
				return function () {
					document.removeEventListener("click", onClick, true);
					observer.disconnect();
					if (openModalClose !== null) openModalClose();
					if (styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag);
				};
			}, "dsh-session-delete client cleanup");
		}

		exports.apply = apply;
		return module.exports;
	}
});