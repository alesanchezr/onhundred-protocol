(() => {
  // Copy buttons
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const source = document.querySelector(btn.dataset.copy);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.textContent);
      const label = btn.textContent;
      btn.textContent = "COPIED";
      setTimeout(() => (btn.textContent = label), 1500);
    } catch {
      getSelection().selectAllChildren(source);
    }
  });

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

  const showTip = (cell) => {
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

  grid.addEventListener("pointerover", (e) => {
    if (e.pointerType === "mouse") showTip(e.target.closest(".cell"));
  });
  grid.addEventListener("pointerleave", hideTip);
  grid.addEventListener("click", (e) => {
    const cell = e.target.closest(".cell");
    if (!cell) return;
    e.stopPropagation();
    if (cell === tipCell) hideTip();
    else showTip(cell);
  });
  document.addEventListener("click", hideTip);
  addEventListener("scroll", hideTip, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
})();
