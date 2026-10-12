// Demo only: level stack, timeline "show all", experiments panel and digest.
const lvl = document.querySelector("[data-level-stack]");
const now = lvl.querySelector(".lvl-now");
let closeTimer;
const setOpen = (open) => {
  clearTimeout(closeTimer);
  lvl.toggleAttribute("data-open", open);
  now.setAttribute("aria-expanded", String(open));
};
const fine = matchMedia("(hover: hover)");
lvl.addEventListener("mouseenter", () => fine.matches && setOpen(true));
lvl.addEventListener("mouseleave", () => {
  if (fine.matches) closeTimer = setTimeout(() => setOpen(false), 120);
});
now.addEventListener("click", () => setOpen(!lvl.hasAttribute("data-open")));
document.addEventListener("keydown", (e) => e.key === "Escape" && setOpen(false));
document.addEventListener("click", (e) => !lvl.contains(e.target) && setOpen(false));

document.querySelectorAll("[data-expand]").forEach((btn) => {
  const box = document.getElementById(btn.dataset.expand);
  btn.addEventListener("click", () => {
    const on = !box.hasAttribute("data-expanded");
    box.toggleAttribute("data-expanded", on);
    btn.setAttribute("aria-expanded", String(on));
    btn.textContent = on ? btn.dataset.less : btn.dataset.more;
  });
});

const drawer = document.querySelector("[data-drawer]");
document.querySelector("[data-drawer-open]")?.addEventListener("click", () => drawer.showModal());
drawer?.addEventListener("click", (e) => {
  if (e.target === drawer || e.target.closest("[data-drawer-close]")) drawer.close();
});

// Screenshot states: #levels, #experiments, #all
if (location.hash === "#levels") setOpen(true);
if (location.hash === "#experiments") drawer?.showModal();
if (location.hash === "#all") document.querySelectorAll("[data-expand]").forEach((b) => b.click());
