(() => {
  // Copy buttons
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const source = document.querySelector(btn.dataset.copy);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.textContent);
      const label = btn.innerHTML;
      btn.textContent = "COPIED";
      setTimeout(() => {
        btn.innerHTML = label;
        btn.closest("details[data-menu]")?.removeAttribute("open");
      }, 1500);
    } catch {
      getSelection().selectAllChildren(source);
    }
  });

  // Forms that change who can see the log ask first.
  document.addEventListener("submit", (e) => {
    const msg = e.target.dataset?.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });

  // Inside a dialog, a menu is fixed to the viewport so the dialog's scroll box doesn't clip it.
  // It opens up as marked (.up), unless there's no room above.
  document.addEventListener(
    "toggle",
    (e) => {
      const menu = e.target;
      if (!menu.matches?.("details[data-menu]") || !menu.open || !menu.closest("dialog")) return;
      const list = menu.querySelector(".menu-list");
      if (!list) return;
      const r = menu.querySelector("summary").getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const up = menu.classList.contains("up") && r.top - list.offsetHeight - 6 >= 8;
      Object.assign(list.style, {
        position: "fixed",
        right: `${vw - r.right}px`,
        top: up ? "auto" : `${r.bottom + 6}px`,
        bottom: up ? `${vh - r.top + 6}px` : "auto",
      });
    },
    true
  );

  // Prompt menus close on a click outside, once an app opens, and on Escape.
  const closeMenus = (except) =>
    document.querySelectorAll("details[data-menu][open]").forEach((m) => m !== except && m.removeAttribute("open"));
  document.addEventListener("click", (e) => {
    const menu = e.target.closest("details[data-menu]");
    closeMenus(menu);
    if (menu && e.target.closest("a.menu-item")) menu.removeAttribute("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !document.querySelector("details[data-menu][open]")) return;
    e.preventDefault();
    closeMenus();
  });

  // A modal dialog sits in the browser's top layer, where element pickers in dev tools can't reach it.
  // Local dev opens dialogs non-modal instead; .modal:not(:modal) in app.css draws their backdrop.
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const openDialog = (d) => (local ? d.show() : d.showModal());
  if (local) {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) document.querySelectorAll("dialog.modal[open], dialog.drawer[open]").forEach((d) => d.close());
    });
  }

  // Plain dialogs close on CANCEL, on the backdrop, and once an app opens.
  document.addEventListener("click", (e) => {
    const d = e.target.closest("dialog[data-dialog]");
    if (d && (e.target === d || e.target.closest("[data-dialog-close], a.menu-item"))) d.close();
  });

  // Fix with AI: one dialog, filled with the prompt of the row whose button opened it.
  const fixDialog = document.querySelector("[data-fix-dialog]");
  if (fixDialog && typeof fixDialog.showModal === "function") {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-fix]");
      if (!btn) return;
      const q = encodeURIComponent(btn.dataset.fix);
      fixDialog.querySelector("[data-fix-target]").textContent = btn.dataset.target;
      fixDialog.querySelector("#fix-prompt").textContent = btn.dataset.fix;
      fixDialog.querySelectorAll("[data-app-href]").forEach((a) => (a.href = a.dataset.appHref.replace("{q}", q)));
      openDialog(fixDialog);
    });
  }

  // Rule break: a proposed loop that can't be approved explains which rule its text breaks.
  const ruleDialog = document.querySelector("[data-rule-dialog]");
  if (ruleDialog && typeof ruleDialog.showModal === "function") {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-rule-break]");
      if (!btn) return;
      ruleDialog.querySelector("[data-rule-code]").textContent = btn.dataset.code;
      ruleDialog.querySelector("[data-rule-name]").textContent = btn.dataset.name;
      // FIX closes this dialog (data-dialog-close) and, through data-fix, opens the fix dialog.
      const fix = ruleDialog.querySelector("[data-rule-fix]");
      if (fix) {
        fix.dataset.fix = btn.dataset.fixPrompt || "";
        fix.dataset.target = btn.dataset.code;
        fix.setAttribute("aria-label", `Fix ${btn.dataset.code} with AI`);
      }
      ruleDialog.querySelector("[data-rule-list]").replaceChildren(
        ...JSON.parse(btn.dataset.ruleBreak || "[]").map((m) => {
          const li = document.createElement("li");
          li.textContent = m;
          return li;
        })
      );
      openDialog(ruleDialog);
    });
  }

  // Export confirmation: explains the file before the download starts.
  const exportDialog = document.querySelector("[data-export-dialog]");
  if (exportDialog && typeof exportDialog.showModal === "function") {
    document.addEventListener("click", (e) => {
      if (!e.target.closest("[data-export-open]")) return;
      e.preventDefault();
      openDialog(exportDialog);
    });
    exportDialog.querySelector("[data-export-cancel]").addEventListener("click", () => exportDialog.close());
    exportDialog.querySelector("form").addEventListener("submit", () => setTimeout(() => exportDialog.close()));
    exportDialog.addEventListener("click", (e) => {
      if (e.target === exportDialog) exportDialog.close();
    });
  }

  // Approve confirmation: each loop's button opens it; the checkbox widens it to every eligible loop.
  const dialog = document.querySelector("[data-approve-dialog]");
  if (dialog && typeof dialog.showModal === "function") {
    const all = JSON.parse(dialog.dataset.codes || "[]");
    const q = (sel) => dialog.querySelector(sel);
    const inputs = q("[data-codes-inputs]");
    const allBox = q("[data-approve-all]");
    let one = null;

    const render = () => {
      const codes = allBox.checked ? all : [one.code];
      inputs.replaceChildren(
        ...codes.map((c) => {
          const i = document.createElement("input");
          i.type = "hidden";
          i.name = "codes";
          i.value = c;
          return i;
        })
      );
      q("[data-approve-title]").textContent = allBox.checked ? `Approve all ${all.length} loops?` : `Approve ${one.code}?`;
      q("[data-approve-loop]").textContent = allBox.checked ? "" : one.name;
      q("[data-approve-loop]").hidden = allBox.checked;
      const rep = q("[data-approve-replaces]");
      rep.textContent = one.replaces ? `It replaces ${one.replaces}, which ${one.replaces.includes(",") ? "are" : "is"} retired at the same time.` : "";
      rep.hidden = allBox.checked || !one.replaces;
      q("[data-approve-submit]").textContent = allBox.checked ? `APPROVE ALL ${all.length}` : "APPROVE";
    };

    document.addEventListener("submit", (e) => {
      const form = e.target.closest("[data-approve-one]");
      if (!form) return;
      e.preventDefault();
      const b = form.querySelector("[data-code]");
      one = { code: b.dataset.code, name: b.dataset.name, replaces: b.dataset.replaces };
      allBox.checked = false;
      allBox.parentElement.hidden = all.length < 2;
      render();
      openDialog(dialog);
    });
    allBox.addEventListener("change", render);
    q("[data-approve-cancel]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  // The small grid in the readout opens and closes the full one.
  const gridToggle = document.querySelector("[data-grid-toggle]");
  const fullGrid = document.getElementById("activity");
  if (gridToggle && fullGrid) {
    const setOpen = (open) => {
      fullGrid.toggleAttribute("data-open", open);
      gridToggle.setAttribute("aria-expanded", String(open));
      // Without the hash, :target in app.css stops holding it open.
      if (!open && location.hash === "#activity") history.replaceState(null, "", location.pathname + location.search);
    };
    setOpen(location.hash === "#activity");
    gridToggle.addEventListener("click", (e) => {
      e.preventDefault();
      setOpen(!fullGrid.hasAttribute("data-open"));
    });
    gridToggle.addEventListener("keydown", (e) => {
      if (e.key !== " ") return;
      e.preventDefault();
      gridToggle.click();
    });
  }

  // Loop page: the current level opens into every level, higher ones above and lower ones below.
  const stack = document.querySelector("[data-level-stack]");
  if (stack) {
    const now = stack.querySelector(".lvl-now");
    const hover = matchMedia("(hover: hover)");
    let closeTimer;
    const setOpen = (open) => {
      clearTimeout(closeTimer);
      stack.toggleAttribute("data-open", open);
      now.setAttribute("aria-expanded", String(open));
    };
    stack.addEventListener("mouseenter", () => hover.matches && setOpen(true));
    stack.addEventListener("mouseleave", () => {
      if (hover.matches) closeTimer = setTimeout(() => setOpen(false), 120);
    });
    now.addEventListener("click", () => setOpen(!stack.hasAttribute("data-open")));
    document.addEventListener("click", (e) => !stack.contains(e.target) && setOpen(false));
    document.addEventListener("keydown", (e) => e.key === "Escape" && setOpen(false));
  }

  // SHOW ALL: unfolds the rest of a list in place.
  document.querySelectorAll("[data-expand]").forEach((btn) => {
    const box = document.getElementById(btn.dataset.expand);
    if (!box) return;
    btn.addEventListener("click", () => {
      const on = !box.hasAttribute("data-expanded");
      box.toggleAttribute("data-expanded", on);
      btn.setAttribute("aria-expanded", String(on));
      btn.textContent = on ? btn.dataset.less : btn.dataset.more;
    });
  });

  // The experiments box opens the side panel.
  const drawer = document.getElementById("exp-drawer");
  if (drawer && typeof drawer.showModal === "function") {
    document.querySelector("[data-drawer-open]")?.addEventListener("click", () => openDialog(drawer));
  }

  // NEXT ACTIONS: each item opens one dialog, filled with that item's prompt.
  const askDialog = document.querySelector("[data-loop-prompt-dialog]");
  if (askDialog && typeof askDialog.showModal === "function") {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-loop-prompt]");
      if (!btn) return;
      const q = encodeURIComponent(btn.dataset.loopPrompt);
      btn.closest("details[data-menu]")?.removeAttribute("open");
      askDialog.querySelector("[data-prompt-title]").textContent = btn.dataset.title;
      askDialog.querySelector("#loop-prompt").textContent = btn.dataset.loopPrompt;
      askDialog.querySelectorAll("[data-app-href]").forEach((a) => (a.href = a.dataset.appHref.replace("{q}", q)));
      openDialog(askDialog);
    });
  }

  const grid = document.querySelector("[data-grid]");
  if (!grid) return;

  // Area focus
  const areaButtons = [...grid.querySelectorAll("[data-area-btn]")];
  areaButtons.forEach((b) =>
    b.addEventListener("click", () => {
      const on = grid.dataset.areaFocus === b.dataset.areaBtn;
      if (on) delete grid.dataset.areaFocus;
      else grid.dataset.areaFocus = b.dataset.areaBtn;
      areaButtons.forEach((x) => x.setAttribute("aria-pressed", String(!on && x === b)));
    })
  );

  // Legend hover: dims every cell at another level. Click locks it until clicked again.
  const levelItems = [...document.querySelectorAll(".legend [data-level]")];
  let lockedLevel = null;
  const focusLevel = (level) => {
    if (level) grid.dataset.levelFocus = level;
    else delete grid.dataset.levelFocus;
  };
  const toggleLock = (li) => {
    lockedLevel = lockedLevel === li.dataset.level ? null : li.dataset.level;
    levelItems.forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.level === lockedLevel)));
    focusLevel(lockedLevel || li.dataset.level);
  };
  levelItems.forEach((li) => {
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");
    li.setAttribute("aria-pressed", "false");
    li.addEventListener("mouseenter", () => focusLevel(li.dataset.level));
    li.addEventListener("mouseleave", () => focusLevel(lockedLevel));
    li.addEventListener("click", () => toggleLock(li));
    li.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggleLock(li);
    });
  });

  // Loop tooltip: hover with a mouse, tap on touch screens.
  const labels = JSON.parse(grid.dataset.tip || "{}");
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.append(tip);
  let tipCell = null;

  const hideTip = () => {
    tipCell = null;
    delete tip.dataset.on;
  };

  const showTip = (cell, touch = false) => {
    if (!cell || !cell.dataset.loop) return hideTip();
    if (cell === tipCell) return;
    tipCell = cell;
    const d = cell.dataset;
    const lines = [
      ["tip-code", d.loop],
      ["tip-name", d.name],
      ["", labels.levels && labels.levels[d.s]],
      ["tip-flag", labels.flags && labels.flags[d.flag]],
      ["failed" in d ? "tip-failed" : "", labels.outcomes && labels.outcomes[d.o]],
      ["tip-flag", touch && labels.open],
    ];
    tip.replaceChildren(
      ...lines
        .filter((l) => l[1])
        .map(([cls, text]) => {
          const s = document.createElement("span");
          s.className = cls;
          s.textContent = text;
          return s;
        })
    );
    tip.dataset.on = "";
    const r = cell.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + "px";
    tip.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + "px";
  };

  // A click opens the loop's page. On touch the first tap shows the tooltip and the second opens it.
  let pointer = "mouse";
  grid.addEventListener("pointerdown", (e) => (pointer = e.pointerType));
  grid.addEventListener("pointerover", (e) => {
    if (e.pointerType === "mouse") showTip(e.target.closest(".cell"));
  });
  grid.addEventListener("pointerleave", hideTip);
  grid.addEventListener("click", (e) => {
    const cell = e.target.closest(".cell[data-loop]");
    if (!cell) return;
    e.stopPropagation();
    if (pointer === "mouse" || cell === tipCell) location.href = `/loop/${encodeURIComponent(cell.dataset.loop)}`;
    else showTip(cell, true);
  });
  document.addEventListener("click", hideTip);
  addEventListener("scroll", hideTip, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
})();
