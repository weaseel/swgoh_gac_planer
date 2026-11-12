# SWGOH GAC Rules and Configuration Requirements

Implement Grand Arena Championships (GAC) for Star Wars: Galaxy of Heroes.

## Game structure
- Five leagues: Carbonite, Bronzium, Chromium, Aurodium, Kyber.
- Five divisions per league: Division 5 (lowest) through Division 1 (highest).
- Standard matchmaking groups contain eight players.
- A weekly event has three rounds.
- Events may use 5v5 or 3v3 squad combat and may include a fleet territory.
- Each round includes defense setup, attack, and results/review phases.
- Players deploy defenses and use remaining eligible units to attack the opponent.

## Required defense configuration

Use these documented default squad-defense counts:

| League | 5v5 squads | 3v3 squads | Fleet defenses |
| Carbonite | 3 | 3 | 1 |
| Bronzium | 5 | 7 | 1 |
| Chromium | 7 | 10 | 2 |
| Aurodium | 9 | 13 | 2 |
| Kyber | 11 | 15 | 3 |

Fleet counts are separate from squad counts. Store them in separate configuration fields.

The number of characters per squad is at most five in 5v5 and at most three in 3v3. Undersized squads are permitted.

Do not infer territory distribution from the total squad count. Store territory-level slot requirements separately and allow them to be updated from the active game's configuration.

## Battle scoring
For standard squad battles, account for:
- Victory: 15 banners.
- First attempt: 30 banners.
- Second attempt: 10 banners.
- Each surviving allied unit: 1 banner.
- Each allied unit at full health: 1 banner.
- Each allied unit at full protection: 1 banner.
- Each defeated enemy: 1 banner.
- Each unused squad slot: 4 banners.

Implement territory-conquest bonuses and fleet battle scoring separately. Avoid applying squad scoring formulas to fleets without checking their specific rules.

## Ranking and matchmaking
- Use Skill Rating for league and division placement.
- Apply rating changes for match results.
- Match players by win record in later rounds where possible.
- Keep promotion, demotion, and end-of-season rating adjustments configurable.

## Implementation requirements
1. Represent leagues, divisions, formats, territory layouts, squad limits, and fleet limits as data rather than scattered constants.
2. Separate roster eligibility, defense deployment, attack availability, battle scoring, and ranking logic.
3. Support 3v3 and 5v5 as separate battle configurations.
4. Support undersized squads and unused-slot scoring.
5. Include unit tests for defense counts, territory assignments, battle banners, retries, and fleet scoring.
6. Treat published defense counts as defaults, not immutable rules. Validate current values against the live game.
7. If data is available through SWGOH Comlink, use it for character and fleet definitions. Do not assume Comlink exposes every live GAC configuration or matchmaking rule.

Reference: https://swgoh.wiki/wiki/Grand_Arena_Championship