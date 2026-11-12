from dataclasses import dataclass


@dataclass(frozen=True)
class LeagueRequirements:
    squads_5v5: int
    squads_3v3: int
    fleets: int


LEAGUE_REQUIREMENTS = {
    "Carbonite": LeagueRequirements(squads_5v5=3, squads_3v3=3, fleets=1),
    "Bronzium": LeagueRequirements(squads_5v5=5, squads_3v3=7, fleets=1),
    "Chromium": LeagueRequirements(squads_5v5=7, squads_3v3=10, fleets=2),
    "Aurodium": LeagueRequirements(squads_5v5=9, squads_3v3=13, fleets=2),
    "Kyber": LeagueRequirements(squads_5v5=11, squads_3v3=15, fleets=3),
}
LEAGUE_ORDER = tuple(LEAGUE_REQUIREMENTS)


def get_defense_requirements(league: str, mode: str) -> dict[str, int]:
    """Return default defense slots; territory grouping is intentionally separate."""
    try:
        requirements = LEAGUE_REQUIREMENTS[league]
    except KeyError as error:
        raise ValueError(f"Unknown GAC league: {league}") from error

    squad_counts = {"5v5": requirements.squads_5v5, "3v3": requirements.squads_3v3}
    try:
        squads = squad_counts[mode]
    except KeyError as error:
        raise ValueError(f"Unknown GAC mode: {mode}") from error

    return {"squads": squads, "fleets": requirements.fleets}


def solve_counter_plan(teams, decisions=None):
    """Return forced assignments and feasible choices for a one-to-one counter plan."""
    decisions = decisions if isinstance(decisions, dict) else {}
    candidates_by_key = {}
    labels_by_key = {}
    for team in teams:
        key = team.get("key")
        if not isinstance(key, str):
            continue
        if "leader" in team and not team["leader"].strip():
            continue
        labels = {}
        for counter in team.get("counters", []):
            if isinstance(counter, str) and counter.strip():
                labels.setdefault(counter.strip().casefold(), counter.strip())
        if labels:
            candidates_by_key[key] = set(labels)
            labels_by_key[key] = labels

    selected = {}
    for key, counter in decisions.items():
        if key not in candidates_by_key or not isinstance(counter, str):
            continue
        normalized = counter.strip().casefold()
        if normalized in candidates_by_key[key]:
            selected[key] = normalized

    keys = list(candidates_by_key)

    def critical_keys(fixed):
        owners_by_counter = {}
        for key, counter in fixed.items():
            owners_by_counter.setdefault(counter, []).append(key)
        critical = {
            key
            for owners in owners_by_counter.values()
            if len(owners) > 1
            for key in owners
        }

        matched_counter = {}
        matched_team = {}
        fixed_values = set(fixed.values())

        def place(key, visited):
            for counter in candidates_by_key[key]:
                if counter in fixed_values or counter in visited:
                    continue
                visited.add(counter)
                previous = matched_counter.get(counter)
                if previous is None or place(previous, visited):
                    matched_counter[counter] = key
                    matched_team[key] = counter
                    return True
            return False

        unmatched = [key for key in keys if key not in fixed and not place(key, set())]
        reachable_teams = set(unmatched)
        reachable_counters = set()
        pending = list(unmatched)
        while pending:
            key = pending.pop()
            for counter in candidates_by_key[key]:
                if matched_team.get(key) == counter or counter in reachable_counters:
                    continue
                reachable_counters.add(counter)
                for owner in owners_by_counter.get(counter, []):
                    critical.add(owner)
                previous = matched_counter.get(counter)
                if previous is not None and previous not in reachable_teams:
                    reachable_teams.add(previous)
                    pending.append(previous)

        critical.update(reachable_teams)
        return [key for key in keys if key in critical]

    def can_complete(overrides=None):
        fixed = dict(selected)
        if overrides:
            key, counter = next(iter(overrides.items()))
            if key in fixed and fixed[key] != counter:
                return False
            fixed[key] = counter

        fixed_values = list(fixed.values())
        if len(set(fixed_values)) != len(fixed_values):
            return False
        if any(counter not in candidates_by_key.get(key, set()) for key, counter in fixed.items()):
            return False

        matched = {}

        def place(key, visited):
            for counter in candidates_by_key[key]:
                if counter in fixed_values or counter in visited:
                    continue
                visited.add(counter)
                previous = matched.get(counter)
                if previous is None or place(previous, visited):
                    matched[counter] = key
                    return True
            return False

        return all(place(key, set()) for key in keys if key not in fixed)

    if not can_complete():
        return {
            "possible": False,
            "assignments": {},
            "options": {},
            "ambiguous": [],
            "critical": critical_keys(selected),
        }

    options = {}
    for key in keys:
        options[key] = [
            labels_by_key[key][counter]
            for counter in labels_by_key[key]
            if can_complete({key: counter})
        ]

    assignments = {key: choices[0] for key, choices in options.items() if len(choices) == 1}
    ambiguous = [key for key, choices in options.items() if len(choices) > 1]
    return {
        "possible": True,
        "assignments": assignments,
        "options": options,
        "ambiguous": ambiguous,
        "critical": [],
    }