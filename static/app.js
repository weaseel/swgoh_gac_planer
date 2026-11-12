const LEGACY_STORAGE_KEY = "gac-fieldbook-v1";
const SELECTED_PROFILE_KEY = "gac-fieldbook-selected-profile-v1";
const CATALOG_STORAGE_KEY = "gac-fieldbook-units-v3";
const CATALOG_MAX_AGE = 24 * 60 * 60 * 1000;
const DEFAULT_LEAGUE = "Carbonite";
const DEFAULT_MODE = "5v5";
let requirements = {};
let leagueOrder = [];
let characters = [];
let ships = [];
let profiles = {};
let activeProfile = "";
let activeRound = 1;
let activeView = "plan";
let toastTimer;
let catalogRequest = null;
let counterPlanRequest = 0;
let isSavingProfiles = false;
const dirtyProfiles = new Set();

const profileSelect = document.querySelector("#profile-select");
const leagueSelect = document.querySelector("#league-select");
const squadList = document.querySelector("#squad-list");
const fleetList = document.querySelector("#fleet-list");
const roundTabs = document.querySelector("#round-tabs");
const catalogStatus = document.querySelector("#catalog-status");
const saveState = document.querySelector("#save-state");
const saveButton = document.querySelector("#save-changes");
const plannerView = document.querySelector("#planner-view");
const counterPlanView = document.querySelector("#counter-plan-view");
const summaryView = document.querySelector("#summary-view");
const planViewButton = document.querySelector("#plan-view-button");
const counterPlanViewButton = document.querySelector("#counter-plan-view-button");
const summaryViewButton = document.querySelector("#summary-view-button");
const summaryList = document.querySelector("#summary-list");
const summaryEmpty = document.querySelector("#summary-empty");
const counterPlanList = document.querySelector("#counter-plan-list");
const counterPlanEmpty = document.querySelector("#counter-plan-empty");

function blankRound() {
  return { squads: [], fleets: [] };
}

function newProfile(name) {
  return { name, league: DEFAULT_LEAGUE, mode: DEFAULT_MODE, allyCode: "", rounds: { 1: blankRound(), 2: blankRound(), 3: blankRound() } };
}

function activePlan() {
  const profile = profiles[activeProfile];
  if (!profile.rounds[activeRound]) profile.rounds[activeRound] = blankRound();
  return profile.rounds[activeRound];
}

function latestRoundWithContent(profile) {
  for (let round = 3; round >= 1; round -= 1) {
    const plan = profile.rounds?.[round];
    if (!plan) continue;
    const hasContent = [...(plan.squads || []), ...(plan.fleets || [])].some(slot =>
      slot.leader?.trim() || slot.counters?.some(counter => counter.trim()),
    );
    if (hasContent) return round;
  }
  return 1;
}

function ensureSlots() {
  const plan = activePlan();
  const profile = profiles[activeProfile];
  const counts = requirements[profile.league];
  if (!counts) return;
  const squadCount = counts[profile.mode];
  while (plan.squads.length < squadCount) plan.squads.push({ leader: "", counters: [] });
  while (plan.fleets.length < counts.fleets) plan.fleets.push({ leader: "", counters: [] });
}

function profileSavePayload(profile) {
  return {
    name: profile.name,
    league: profile.league,
    mode: profile.mode,
    allyCode: profile.allyCode,
    rounds: JSON.parse(JSON.stringify(profile.rounds)),
  };
}

function updateSaveIndicator() {
  const count = dirtyProfiles.size;
  saveState.textContent = isSavingProfiles
    ? "Saving to shared database..."
    : count
      ? `${count} profile${count === 1 ? "" : "s"} with unsaved changes`
      : "Saved to shared database";
  saveButton.disabled = isSavingProfiles || count === 0;
}

function markUnsaved() {
  if (!profiles[activeProfile]) return;
  dirtyProfiles.add(activeProfile);
  localStorage.setItem(SELECTED_PROFILE_KEY, activeProfile);
  updateSaveIndicator();
}

async function saveChanges() {
  if (isSavingProfiles || dirtyProfiles.size === 0) return;
  isSavingProfiles = true;
  updateSaveIndicator();

  try {
    for (const profileId of [...dirtyProfiles]) {
      const profile = profiles[profileId];
      if (!profile) {
        dirtyProfiles.delete(profileId);
        continue;
      }

      const snapshot = profileSavePayload(profile);
      const response = await fetch(`/api/profiles/${encodeURIComponent(profileId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save profile to the shared database.");

      const current = profiles[profileId];
      profiles[profileId] = { ...current, updatedAt: result.updatedAt };
      if (JSON.stringify(profileSavePayload(current)) === JSON.stringify(snapshot)) {
        dirtyProfiles.delete(profileId);
      }
    }
  } catch (error) {
    showToast(error.message || "Could not save profiles.");
  } finally {
    isSavingProfiles = false;
    updateSaveIndicator();
  }
}

async function loadProfiles() {
  let legacy = null;
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "null");
  } catch {
    legacy = null;
  }

  const response = await fetch("/api/profiles");
  if (!response.ok) throw new Error("Could not load shared profiles.");
  let serverProfiles = (await response.json()).profiles;
  if (legacy?.profiles && typeof legacy.profiles === "object") {
    for (const [name, savedProfile] of Object.entries(legacy.profiles)) {
      if (serverProfiles.some(profile => profile.name.toLowerCase() === name.toLowerCase())) continue;
      const candidate = { ...savedProfile, name };
      const imported = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidate),
      });
      if (!imported.ok) throw new Error("Could not migrate this browser's saved profiles.");
      serverProfiles.push(await imported.json());
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }

  if (!serverProfiles.length) {
    const created = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newProfile("My GAC")),
    });
    if (!created.ok) throw new Error("Could not create the initial planner profile.");
    serverProfiles = [(await created.json())];
  }

  profiles = Object.fromEntries(serverProfiles.map(profile => [profile.id, profile]));
  const selectedId = localStorage.getItem(SELECTED_PROFILE_KEY);
  const legacyName = legacy?.profiles?.[legacy.activeProfile] ? legacy.activeProfile : "";
  activeProfile = selectedId && profiles[selectedId] ? selectedId :
    serverProfiles.find(profile => profile.name === legacyName)?.id || serverProfiles[0].id;
  localStorage.setItem(SELECTED_PROFILE_KEY, activeProfile);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function makeInput(className, value, placeholder, listId, onInput) {
  const input = document.createElement("input");
  input.className = className;
  input.value = value || "";
  input.placeholder = placeholder;
  input.setAttribute("list", listId);
  input.autocomplete = "off";
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

function renderProfiles() {
  profileSelect.replaceChildren();
  for (const [id, profile] of Object.entries(profiles)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = profile.name;
    profileSelect.append(option);
  }
  profileSelect.value = activeProfile;
}

function renderControls() {
  const profile = profiles[activeProfile];
  leagueSelect.replaceChildren();
  for (const league of leagueOrder) {
    const option = document.createElement("option");
    option.value = league;
    option.textContent = league;
    leagueSelect.append(option);
  }
  leagueSelect.value = profile.league;
  document.querySelector("#my-ally-code").value = profile.allyCode ?? "";
  document.querySelector("#opponent-ally-code").value = profile.rounds[activeRound]?.opponentAllyCode || "";
  updateOpponentProfileLink();
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === profile.mode));
  }
  const count = requirements[profile.league];
  if (count) {
    document.querySelector("#slot-count").textContent = count[profile.mode];
    document.querySelector("#fleet-count").textContent = `+ ${count.fleets} ${count.fleets === 1 ? "fleet" : "fleets"}`;
    document.querySelector("#fleet-summary").textContent = `${count.fleets} ${count.fleets === 1 ? "SLOT" : "SLOTS"}`;
  }
}

function updateOpponentProfileLink() {
  const link = document.querySelector("#opponent-profile-link");
  const code = document.querySelector("#opponent-ally-code").value.trim();
  link.hidden = !/^\d{9}$/.test(code);
  if (!link.hidden) link.href = `https://swgoh.gg/p/${code}/`;
  else link.removeAttribute("href");
}

function renderRounds() {
  roundTabs.replaceChildren();
  for (let round = 1; round <= 3; round += 1) {
    const button = document.createElement("button");
    button.className = "round-tab";
    button.type = "button";
    button.textContent = `ROUND 0${round}`;
    button.setAttribute("aria-selected", String(round === activeRound));
    button.addEventListener("click", () => {
      activeRound = round;
      render();
    });
    roundTabs.append(button);
  }
}

function fillDatalist(id, entries) {
  const list = document.querySelector(`#${id}`);
  list.replaceChildren();
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.name;
    option.label = entry.name === entry.id ? entry.id : `${entry.name} · ${entry.id}`;
    list.append(option);
  }
}

function updateGacCounterLink(link, value) {
  const query = value.trim().toLocaleLowerCase();
  const character = characters.find(entry =>
    entry.name.toLocaleLowerCase() === query || entry.id.toLocaleLowerCase() === query,
  );
  link.hidden = !character;
  if (character) link.href = `https://swgoh.gg/gac/counters/${encodeURIComponent(character.id)}/`;
  else link.removeAttribute("href");
}

function refreshGacCounterLinks() {
  for (const input of squadList.querySelectorAll(".leader-input")) {
    updateGacCounterLink(input.parentElement.querySelector(".gac-counter-link"), input.value);
  }
}

function applyUnitCatalog(data, cached = false) {
  if (!Array.isArray(data.characters) || !Array.isArray(data.ships)) return false;
  characters = data.characters;
  ships = data.ships;
  fillDatalist("character-options", characters);
  fillDatalist("ship-options", ships);
  refreshGacCounterLinks();
  catalogStatus.textContent = `${characters.length} characters · ${ships.length} ships${cached ? " · cached" : ""}`;
  return true;
}

function loadCachedUnitCatalog() {
  try {
    const cached = JSON.parse(localStorage.getItem(CATALOG_STORAGE_KEY) || "null");
    if (!cached || !applyUnitCatalog(cached)) return null;
    return Date.now() - (cached.updatedAt || 0) > CATALOG_MAX_AGE;
  } catch {
    return null;
  }
}

function renderCounterEditor(item, type, index) {
  const area = document.createElement("div");
  area.className = "counter-area";
  const tags = document.createElement("div");
  tags.className = "counter-tags";
  item.counters.forEach((leader, counterIndex) => {
    const tag = document.createElement("button");
    tag.className = "counter-tag";
    tag.type = "button";
    tag.setAttribute("aria-label", `Remove counter ${leader}`);
    tag.append(document.createTextNode(leader));
    const close = document.createElement("span");
    close.textContent = "×";
    tag.append(close);
    tag.addEventListener("click", () => {
      item.counters.splice(counterIndex, 1);
      render();
      markUnsaved();
    });
    tags.append(tag);
  });

  const entry = document.createElement("div");
  entry.className = "counter-entry";
  const input = makeInput("counter-input", "", "Add counter leader", type === "fleet" ? "ship-options" : "character-options", () => {});
  input.setAttribute("aria-label", `Add counter for ${type} ${index + 1}`);
  const add = document.createElement("button");
  add.className = "add-counter";
  add.type = "button";
  add.textContent = "+";
  add.setAttribute("aria-label", "Add counter leader");
  const addCounter = () => {
    const value = input.value.trim();
    if (!value) return;
    item.counters.push(value);
    render();
    markUnsaved();
  };
  add.addEventListener("click", addCounter);
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") addCounter();
  });
  entry.append(input, add);
  area.append(tags, entry);
  return area;
}

function renderSquads() {
  squadList.replaceChildren();
  const count = requirements[profiles[activeProfile].league][profiles[activeProfile].mode];
  activePlan().squads.slice(0, count).forEach((item, index) => {
    const row = document.createElement("article");
    row.className = "defense-row";
    const leaderGroup = document.createElement("div");
    leaderGroup.className = "defense-leader";
    const identity = document.createElement("div");
    identity.className = "defense-id";
    const number = document.createElement("span");
    number.className = "slot-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const label = document.createElement("span");
    label.className = "slot-caption";
    label.textContent = "SQUAD LEADER";
    identity.append(number, label);
    const leader = makeInput("leader-input", item.leader, "Opponent leader", "character-options", value => {
      item.leader = value;
      updateGacCounterLink(counterLink, value);
      markUnsaved();
    });
    leader.setAttribute("aria-label", `Opponent squad ${index + 1} leader`);
    const counterLink = document.createElement("a");
    counterLink.className = "gac-counter-link";
    counterLink.textContent = "View GAC counters";
    counterLink.target = "_blank";
    counterLink.rel = "noopener noreferrer";
    updateGacCounterLink(counterLink, item.leader);
    leaderGroup.append(identity, leader);
    leaderGroup.append(counterLink);
    row.append(leaderGroup, renderCounterEditor(item, "squad", index));
    squadList.append(row);
  });
}

function renderFleets() {
  fleetList.replaceChildren();
  const count = requirements[profiles[activeProfile].league].fleets;
  activePlan().fleets.slice(0, count).forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "fleet-card";
    const number = document.createElement("span");
    number.className = "slot-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const content = document.createElement("div");
    const leader = makeInput("fleet-input", item.leader, "Opponent capital ship", "ship-options", value => {
      item.leader = value;
      markUnsaved();
    });
    leader.setAttribute("aria-label", `Opponent fleet ${index + 1} capital ship`);
    content.append(leader, renderCounterEditor(item, "fleet", index));
    card.append(number, content);
    fleetList.append(card);
  });
}

function renderSummaryRow(kind, index, slot, chosenCounter) {
  const leader = slot.leader.trim();
  const counters = slot.counters.filter(counter => counter.trim());
  if (!leader && counters.length === 0) return null;

  const row = document.createElement("article");
  row.className = "summary-row";
  const number = document.createElement("span");
  number.className = "summary-number";
  number.textContent = `${kind === "fleet" ? "F" : "S"}${String(index + 1).padStart(2, "0")}`;

  const details = document.createElement("div");
  details.className = "summary-details";
  const defense = document.createElement("p");
  defense.className = "summary-defense";
  const defenseLabel = document.createElement("span");
  defenseLabel.className = "summary-label";
  defenseLabel.textContent = kind === "fleet" ? "CAPITAL" : "DEFENSE";
  const defenseLeader = document.createElement("strong");
  defenseLeader.textContent = leader || "Not set";
  defense.append(defenseLabel, defenseLeader);
  details.append(defense);

  const offense = document.createElement("div");
  offense.className = "summary-offense";
  const offenseLabel = document.createElement("span");
  offenseLabel.className = "summary-label";
  offenseLabel.textContent = kind === "fleet" ? "COUNTER FLEETS" : "COUNTERS";
  offense.append(offenseLabel);
  if (counters.length) {
    const counterList = document.createElement("div");
    counterList.className = "summary-counters";
    for (const counter of counters) {
      const item = document.createElement("span");
      item.className = `summary-counter${counter === chosenCounter ? " is-selected" : ""}`;
      item.textContent = counter;
      if (counter === chosenCounter) {
        const selected = document.createElement("strong");
        selected.className = "summary-choice-mark";
        selected.textContent = "Selected";
        item.append(selected);
      }
      counterList.append(item);
    }
    offense.append(counterList);
  } else {
    const empty = document.createElement("span");
    empty.className = "summary-none";
    empty.textContent = "No counters";
    offense.append(empty);
  }
  details.append(offense);
  row.append(number, details);
  return row;
}

function renderSummary() {
  const profile = profiles[activeProfile];
  if (!profile) return;
  const plan = activePlan();
  const limits = requirements[profile.league];
  const squadSlots = plan.squads.slice(0, limits[profile.mode]);
  const fleetSlots = plan.fleets.slice(0, limits.fleets);
  const filledSquads = squadSlots.filter(slot => slot.leader.trim() || slot.counters.some(counter => counter.trim()));
  const filledFleets = fleetSlots.filter(slot => slot.leader.trim() || slot.counters.some(counter => counter.trim()));

  document.querySelector("#summary-kicker").textContent = `ROUND 0${activeRound} / ${profile.league.toUpperCase()} / ${profile.mode}`;
  document.querySelector("#summary-counts").textContent = `${filledSquads.length}/${squadSlots.length} squads · ${filledFleets.length}/${fleetSlots.length} fleets`;
  summaryList.replaceChildren();
  for (const [kind, slots] of [["squad", squadSlots], ["fleet", fleetSlots]]) {
    slots.forEach((slot, index) => {
      const key = `${kind}:${index}`;
      const chosenCounter = plan.counterDecisions?.[key] || plan.counterPlan?.assignments?.[key] || "";
      const row = renderSummaryRow(kind, index, slot, chosenCounter);
      if (row) summaryList.append(row);
    });
  }
  summaryEmpty.hidden = summaryList.childElementCount > 0;
}

async function renderCounterPlan() {
  const profile = profiles[activeProfile];
  if (!profile) return;
  const requestId = ++counterPlanRequest;
  const profileId = activeProfile;
  const roundNumber = activeRound;
  const plan = activePlan();
  plan.counterDecisions ||= {};
  const limits = requirements[profile.league];
  const entries = [
    ...plan.squads.slice(0, limits[profile.mode]).map((slot, index) => ({ slot, index, kind: "squad", label: "S" })),
    ...plan.fleets.slice(0, limits.fleets).map((slot, index) => ({ slot, index, kind: "fleet", label: "F" })),
  ].map(entry => ({
    ...entry,
    key: `${entry.kind}:${entry.index}`,
    leader: entry.slot.leader.trim(),
    counters: [...new Set(entry.slot.counters.map(counter => counter.trim()).filter(Boolean))],
  }));
  const readyEntries = entries.filter(entry => entry.leader && entry.counters.length);
  document.querySelector("#counter-plan-kicker").textContent = `ROUND 0${activeRound} / ${profile.league.toUpperCase()} / ${profile.mode}`;
  document.querySelector("#counter-plan-counts").textContent = `${readyEntries.length} defenses with counters`;
  counterPlanList.replaceChildren();

  const missingEntries = entries.filter(entry => !entry.leader || !entry.counters.length);
  if (missingEntries.length) {
    const missingSection = document.createElement("section");
    missingSection.className = "counter-plan-missing";
    const heading = document.createElement("h3");
    heading.textContent = "Needs more information";
    missingSection.append(heading);
    for (const entry of missingEntries) {
      const row = document.createElement("div");
      row.className = "counter-plan-issue";
      const team = document.createElement("strong");
      team.textContent = `${entry.label}${String(entry.index + 1).padStart(2, "0")} · ${entry.leader || "Defense leader not set"}`;
      const reason = document.createElement("span");
      reason.textContent = !entry.leader ? "Enter the defense leader in Plan." : "Add at least one counter in Plan.";
      row.append(team, reason);
      missingSection.append(row);
    }
    counterPlanList.append(missingSection);
  }

  if (!readyEntries.length) {
    counterPlanEmpty.textContent = "No defenses are ready for a counter suggestion.";
    counterPlanEmpty.hidden = false;
    return;
  }

  counterPlanEmpty.hidden = true;
  const pending = document.createElement("p");
  pending.className = "counter-plan-pending";
  pending.textContent = "Checking for a complete counter assignment...";
  counterPlanList.append(pending);

  try {
    const response = await fetch("/api/counter-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        squads: plan.squads,
        fleets: plan.fleets,
        decisions: plan.counterDecisions,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not calculate a counter plan.");
    if (requestId !== counterPlanRequest || activeView !== "counter-plan" || activeProfile !== profileId || activeRound !== roundNumber) return;

    const previousResult = JSON.stringify(plan.counterPlan || null);
    plan.counterPlan = result;
    if (previousResult !== JSON.stringify(result)) markUnsaved();
    counterPlanList.replaceChildren(...[...counterPlanList.children].filter(child => child.classList.contains("counter-plan-missing")));

    if (!result.possible) {
      const impossible = document.createElement("p");
      impossible.className = "counter-plan-impossible";
      impossible.textContent = "No conflict-free assignment exists for all these defenses. Change the candidates or clear a decision.";
      counterPlanList.append(impossible);

      const criticalKeys = new Set(result.critical || []);
      const criticalEntries = readyEntries.filter(entry => criticalKeys.has(entry.key));
      if (criticalEntries.length) {
        const critical = document.createElement("ul");
        critical.className = "counter-plan-critical";
        const heading = document.createElement("li");
        heading.className = "counter-plan-critical-heading";
        heading.textContent = "Critical defenses";
        critical.append(heading);
        for (const entry of criticalEntries) {
          const item = document.createElement("li");
          item.textContent = `${entry.label}${String(entry.index + 1).padStart(2, "0")} · ${entry.leader}`;
          critical.append(item);
        }
        counterPlanList.append(critical);
      }
    }

    const suggestionSection = document.createElement("section");
    suggestionSection.className = "counter-plan-suggestions";
    const heading = document.createElement("h3");
    heading.textContent = result.possible ? "Suggested counters" : "Counter choices";
    suggestionSection.append(heading);
    let assignedCount = 0;

    for (const entry of readyEntries) {
      const options = result.possible ? result.options[entry.key] || [] : entry.counters;
      const decision = plan.counterDecisions[entry.key] || "";
      const assignment = result.possible ? result.assignments[entry.key] || "" : "";
      const isManualDecision = Boolean(decision);
      const countersChosenElsewhere = new Set(
        Object.entries(plan.counterDecisions)
          .filter(([key, counter]) => key !== entry.key && counter)
          .map(([, counter]) => counter.toLocaleLowerCase()),
      );
      if (assignment) assignedCount += 1;

      const row = document.createElement("article");
      row.className = "counter-plan-row";
      const defense = document.createElement("div");
      defense.className = "counter-plan-defense";
      const number = document.createElement("span");
      number.className = "summary-number";
      number.textContent = `${entry.label}${String(entry.index + 1).padStart(2, "0")}`;
      const name = document.createElement("strong");
      name.textContent = entry.leader;
      defense.append(number, name);

      if (options.length > 1 || isManualDecision || !result.possible) {
        const select = document.createElement("select");
        select.className = "counter-plan-select";
        select.setAttribute("aria-label", `Counter for ${entry.leader}`);
        const prompt = document.createElement("option");
        prompt.value = "";
        prompt.textContent = isManualDecision ? "Reset choice" : "Choose a counter";
        select.append(prompt);
        for (const counter of options) {
          const option = document.createElement("option");
          option.value = counter;
          option.textContent = counter;
          option.disabled = countersChosenElsewhere.has(counter.toLocaleLowerCase());
          select.append(option);
        }
        select.value = decision || assignment;
        select.addEventListener("change", () => {
          if (select.value) plan.counterDecisions[entry.key] = select.value;
          else delete plan.counterDecisions[entry.key];
          markUnsaved();
          void renderCounterPlan();
        });
        row.append(defense, select);
      } else {
        const suggestion = document.createElement("div");
        suggestion.className = "counter-plan-assignment";
        suggestion.textContent = assignment || "No feasible choice";
        row.append(defense, suggestion);
      }
      suggestionSection.append(row);
    }
    counterPlanList.append(suggestionSection);
    document.querySelector("#counter-plan-counts").textContent = result.possible
      ? `${assignedCount}/${readyEntries.length} defenses assigned`
      : "No complete assignment";
  } catch (error) {
    if (requestId !== counterPlanRequest || activeView !== "counter-plan" || activeProfile !== profileId || activeRound !== roundNumber) return;
    counterPlanList.replaceChildren(...[...counterPlanList.children].filter(child => child.classList.contains("counter-plan-missing")));
    const failure = document.createElement("p");
    failure.className = "counter-plan-impossible";
    failure.textContent = error.message || "Could not calculate a counter plan.";
    counterPlanList.append(failure);
  }
}

function setActiveView(view) {
  activeView = view;
  plannerView.hidden = view !== "plan";
  counterPlanView.hidden = view !== "counter-plan";
  summaryView.hidden = view !== "summary";
  planViewButton.setAttribute("aria-selected", String(view === "plan"));
  counterPlanViewButton.setAttribute("aria-selected", String(view === "counter-plan"));
  summaryViewButton.setAttribute("aria-selected", String(view === "summary"));
  if (view === "counter-plan") renderCounterPlan();
  if (view === "summary") renderSummary();
}

function render() {
  ensureSlots();
  renderProfiles();
  renderControls();
  renderRounds();
  renderSquads();
  renderFleets();
  if (activeView === "counter-plan") renderCounterPlan();
  if (activeView === "summary") renderSummary();
}

async function syncUnits({ silent = false, refresh = false } = {}) {
  if (catalogRequest) return catalogRequest;
  const button = document.querySelector("#sync-units");
  button.disabled = true;
  if (!silent || !characters.length) catalogStatus.textContent = "Connecting to Comlink...";
  catalogRequest = (async () => {
    try {
      const response = await fetch(`/api/units${refresh ? "?refresh=1" : ""}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Comlink request failed");
      if (!applyUnitCatalog(data, data.source === "server-cache")) throw new Error("Server returned an invalid unit catalog.");
      try {
        localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify({
          ...data,
          updatedAt: data.updatedAt ? Date.parse(data.updatedAt) : Date.now(),
        }));
      } catch {
        catalogStatus.textContent += " · not cached";
      }
      if (!silent) {
        showToast(data.refreshFailed ? "Comlink unavailable; kept the server's last-known catalog." : "Unit catalog updated.");
      }
    } catch (error) {
      if (!characters.length) catalogStatus.textContent = "Manual entry ready";
      if (!silent) showToast(error.message || "Could not load unit catalog from server.");
    } finally {
      button.disabled = false;
      catalogRequest = null;
    }
  })();
  return catalogRequest;
}

document.querySelector("#add-profile").addEventListener("click", () => {
  const dialog = document.querySelector("#profile-dialog");
  const input = document.querySelector("#profile-name");
  input.value = "";
  dialog.showModal();
  input.focus();
});

document.querySelector("#cancel-profile").addEventListener("click", () => {
  document.querySelector("#profile-dialog").close();
});

document.querySelector("#profile-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = document.querySelector("#profile-name").value.trim().slice(0, 32);
  if (!name) return;
  if (Object.values(profiles).some(profile => profile.name.toLowerCase() === name.toLowerCase())) {
    showToast("A profile with that name already exists.");
    return;
  }
  const create = async () => {
    const response = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newProfile(name)),
    });
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error || "Could not create profile.");
      return;
    }
    document.querySelector("#profile-dialog").close();
    profiles[result.id] = result;
    activeProfile = result.id;
    activeRound = 1;
    render();
    localStorage.setItem(SELECTED_PROFILE_KEY, activeProfile);
  };
  create().catch(() => showToast("Could not reach the shared database."));
});

profileSelect.addEventListener("change", () => {
  activeProfile = profileSelect.value;
  activeRound = 1;
  render();
  localStorage.setItem(SELECTED_PROFILE_KEY, activeProfile);
  updateSaveIndicator();
});

leagueSelect.addEventListener("change", () => {
  profiles[activeProfile].league = leagueSelect.value;
  render();
  markUnsaved();
});

document.querySelector("#my-ally-code").addEventListener("input", event => {
  const input = event.currentTarget;
  input.value = input.value.replace(/\D/g, "").slice(0, 9);
  profiles[activeProfile].allyCode = input.value;
  markUnsaved();
});

document.querySelector("#opponent-ally-code").addEventListener("input", event => {
  const input = event.currentTarget;
  input.value = input.value.replace(/\D/g, "").slice(0, 9);
  activePlan().opponentAllyCode = input.value;
  updateOpponentProfileLink();
  markUnsaved();
});

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => {
    profiles[activeProfile].mode = button.dataset.mode;
    render();
    markUnsaved();
  });
}

document.querySelector("#sync-units").addEventListener("click", () => syncUnits({ refresh: true }));
saveButton.addEventListener("click", saveChanges);
planViewButton.addEventListener("click", () => setActiveView("plan"));
counterPlanViewButton.addEventListener("click", () => setActiveView("counter-plan"));
summaryViewButton.addEventListener("click", () => setActiveView("summary"));

window.addEventListener("beforeunload", event => {
  if (dirtyProfiles.size > 0) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function initialize() {
  const shouldRefreshCatalog = loadCachedUnitCatalog();
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Could not load planner configuration");
    const config = await response.json();
    requirements = config.leagues;
    leagueOrder = config.leagueOrder;
    await loadProfiles();
    activeRound = latestRoundWithContent(profiles[activeProfile]);
    render();
    updateSaveIndicator();
    void syncUnits({ silent: true, refresh: shouldRefreshCatalog === true });
  } catch {
    catalogStatus.textContent = "Shared database unavailable";
    saveState.textContent = "Could not load shared profiles";
    showToast("Could not connect to the shared planner database.");
  }
}

initialize();