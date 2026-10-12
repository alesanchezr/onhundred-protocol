// Demo only: the ASK YOUR AI menu opens the prompt dialog, like the Fix dialog in the app.
const CODE = "C-LDR-01";
const NAME = "Send the monthly investor update";
const PROMPTS = {
  draft: ["Draft an experiment", `Use Onhundred to draft an experiment for ${CODE}, ${NAME}. It's at assisted. Call get_loop and suggest_slots first, and aim for delegated. Write the question and the bet (If, then, because) following onhundred://docs/voice. Show me both before you call register_experiment.`],
  close: ["Close the running stage", `Use Onhundred to close the running stage of EXP-06 for ${CODE}, ${NAME}. Ask me whether it was achieved, not achieved or terminated, and what it really cost, then call close_stage_try.`],
  drop: ["Record a drop", `Use Onhundred to record a drop for ${CODE}, ${NAME}. Ask me what failed and for how many days, then call record_drop with the cause and a private note.`],
  stop: ["Stop it now", `Use Onhundred to stop ${CODE}, ${NAME}, now. Someone was harmed or withdrew consent. Call record_drop so it goes straight back to mapped, then ask me what happened for the private note.`],
  rename: ["Rename", `Use Onhundred to rename ${CODE}, ${NAME}. Read onhundred://docs/loops and onhundred://docs/voice, propose 3 names in every language of the log, and wait for my pick before rename_loop.`],
  estimate: ["Update the estimate", `Use Onhundred to update the estimate and triage of ${CODE}, ${NAME}. Ask me what changed, then call update_loop.`],
  split: ["Split", `Use Onhundred to split ${CODE}, ${NAME}, into smaller loops. Read onhundred://docs/loops, propose the new loops, and ask me whether the baseline still applies before split_loop.`],
  merge: ["Merge", `Use Onhundred to merge ${CODE}, ${NAME}, with another Leadership loop. Show me the candidates and the merged name before merge_loops.`],
  retire: ["Retire", `Use Onhundred to retire ${CODE}, ${NAME}. Ask me why, then call retire_loop with that reason.`],
};

const dialog = document.querySelector("[data-prompt-dialog]");
document.addEventListener("click", (e) => {
  const item = e.target.closest("[data-act]");
  if (item) {
    const [title, prompt] = PROMPTS[item.dataset.act];
    item.closest("details").open = false;
    dialog.querySelector("[data-prompt-title]").textContent = title;
    dialog.querySelector("#loop-prompt").textContent = prompt;
    dialog.showModal();
    return;
  }
  if (e.target.closest("[data-dialog-close]")) dialog.close();
  if (e.target.closest("[data-copy]")) navigator.clipboard?.writeText(dialog.querySelector("#loop-prompt").textContent);
  document.querySelectorAll("details[data-menu][open]").forEach((d) => {
    if (!d.contains(e.target)) d.open = false;
  });
});
