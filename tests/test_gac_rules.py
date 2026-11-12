import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import _playable_unit_options, _store_unit_catalog, app
from gac_rules import LEAGUE_ORDER, get_defense_requirements, solve_counter_plan


class DefenseRequirementsTests(unittest.TestCase):
    def test_league_order_is_lowest_to_highest(self):
        self.assertEqual(
            LEAGUE_ORDER,
            ("Carbonite", "Bronzium", "Chromium", "Aurodium", "Kyber"),
        )

        response = app.test_client().get("/api/config")
        self.assertEqual(response.get_json()["leagueOrder"], list(LEAGUE_ORDER))

    def test_default_squad_and_fleet_counts(self):
        expected = {
            "Carbonite": ((3, 3), 1),
            "Bronzium": ((5, 7), 1),
            "Chromium": ((7, 10), 2),
            "Aurodium": ((9, 13), 2),
            "Kyber": ((11, 15), 3),
        }

        for league, ((five_v_five, three_v_three), fleets) in expected.items():
            with self.subTest(league=league, mode="5v5"):
                self.assertEqual(
                    get_defense_requirements(league, "5v5"),
                    {"squads": five_v_five, "fleets": fleets},
                )
            with self.subTest(league=league, mode="3v3"):
                self.assertEqual(
                    get_defense_requirements(league, "3v3"),
                    {"squads": three_v_three, "fleets": fleets},
                )

    def test_unknown_league_is_rejected(self):
        with self.assertRaises(ValueError):
            get_defense_requirements("Unknown", "5v5")

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(ValueError):
            get_defense_requirements("Kyber", "2v2")


class CounterPlanSolverTests(unittest.TestCase):
    def test_forces_globally_unique_choices(self):
        result = solve_counter_plan([
            {"key": "squad:0", "counters": ["Counter A"]},
            {"key": "squad:1", "counters": ["Counter A", "Counter C"]},
            {"key": "squad:2", "counters": ["Counter B", "Counter C"]},
        ])

        self.assertTrue(result["possible"])
        self.assertEqual(result["assignments"], {
            "squad:0": "Counter A",
            "squad:1": "Counter C",
            "squad:2": "Counter B",
        })

    def test_reports_impossible_overlapping_choices(self):
        result = solve_counter_plan([
            {"key": "squad:0", "counters": ["Counter A", "Counter B"]},
            {"key": "squad:1", "counters": ["Counter A", "Counter B"]},
            {"key": "squad:2", "counters": ["Counter A", "Counter B"]},
        ])

        self.assertFalse(result["possible"])
        self.assertEqual(result["assignments"], {})

    def test_identifies_only_teams_in_the_conflict(self):
        result = solve_counter_plan([
            {"key": "squad:0", "counters": ["Counter A", "Counter B"]},
            {"key": "squad:1", "counters": ["Counter A", "Counter B"]},
            {"key": "squad:2", "counters": ["Counter C"]},
            {"key": "squad:3", "counters": ["Counter C"]},
        ])

        self.assertFalse(result["possible"])
        self.assertEqual(set(result["critical"]), {"squad:2", "squad:3"})

    def test_maps_forced_team_and_restricts_ambiguous_options(self):
        teams = [
            {"key": "squad:0", "counters": ["Counter A", "Counter B", "Counter C"]},
            {"key": "squad:1", "counters": ["Counter A", "Counter B", "Counter C"]},
            {"key": "squad:2", "counters": ["Counter B"]},
        ]
        result = solve_counter_plan(teams)

        self.assertEqual(result["assignments"]["squad:2"], "Counter B")
        self.assertEqual(result["options"]["squad:0"], ["Counter A", "Counter C"])
        self.assertEqual(result["options"]["squad:1"], ["Counter A", "Counter C"])

        decided = solve_counter_plan(teams, {"squad:0": "Counter A"})
        self.assertEqual(decided["assignments"], {
            "squad:0": "Counter A",
            "squad:1": "Counter C",
            "squad:2": "Counter B",
        })


class PlayableUnitOptionTests(unittest.TestCase):
    def test_excludes_loaned_units_and_deduplicates_rarity_records(self):
        unit_records = [
            {"baseId": "AHSOKA", "combatType": 1, "obtainable": True, "categoryId": ["any_obtainable"], "nameKey": "AHSOKA_NAME"},
            {"baseId": "AHSOKA", "combatType": 1, "obtainable": True, "categoryId": ["any_obtainable"], "nameKey": "AHSOKA_NAME"},
            {"baseId": "AHSOKA", "combatType": 1, "obtainable": False, "loanedUnit": True},
            {"baseId": "EVENT_NPC", "combatType": 1, "obtainable": False},
            {"baseId": "CAPITAL", "combatType": 2, "unitClass": 7, "obtainable": True, "categoryId": ["any_obtainable"], "nameKey": "CAPITAL_NAME"},
            {"baseId": "FIGHTER", "combatType": 2, "unitClass": 6, "obtainable": True},
            {"baseId": "NONPLAYABLE_SHIP", "combatType": 2, "obtainable": True, "loanedUnit": True},
            {"baseId": "PVE_UNIT", "combatType": 3, "obtainable": True},
        ]

        self.assertEqual(
            _playable_unit_options(unit_records, {"AHSOKA_NAME": "Ahsoka", "CAPITAL_NAME": "Capital"}),
            {
                "characters": [{"id": "AHSOKA", "name": "Ahsoka"}],
                "ships": [{"id": "CAPITAL", "name": "Capital"}],
            },
        )


class ProfileApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.previous_database = app.config["DATABASE"]
        app.config["DATABASE"] = str(Path(self.temp_directory.name) / "test.sqlite3")
        self.client = app.test_client()

    def tearDown(self):
        app.config["DATABASE"] = self.previous_database
        self.temp_directory.cleanup()

    def profile_payload(self, name="Shared profile"):
        return {
            "name": name,
            "league": "Kyber",
            "mode": "3v3",
            "allyCode": "111222333",
            "rounds": {
                "1": {
                    "squads": [{"leader": "Darth Vader", "counters": ["Ahsoka", "CLS"]}],
                    "fleets": [{"leader": "Executor", "counters": ["Profundity"]}],
                    "opponentAllyCode": "444555666",
                    "counterDecisions": {"squad:0": "CLS", "fleet:0": "Profundity"},
                }
            },
        }

    def test_create_update_and_read_profile(self):
        created = self.client.post("/api/profiles", json=self.profile_payload())
        self.assertEqual(created.status_code, 201)
        profile = created.get_json()

        updated_payload = self.profile_payload()
        updated_payload["rounds"]["1"]["squads"][0]["leader"] = "Grand Inquisitor"
        updated = self.client.put(f"/api/profiles/{profile['id']}", json=updated_payload)
        self.assertEqual(updated.status_code, 200)

        response = app.test_client().get("/api/profiles")
        saved = response.get_json()["profiles"][0]
        self.assertEqual(saved["rounds"]["1"]["squads"][0]["leader"], "Grand Inquisitor")
        self.assertEqual(saved["rounds"]["1"]["squads"][0]["counters"], ["Ahsoka", "CLS"])
        self.assertEqual(saved["rounds"]["1"]["fleets"][0], {"leader": "Executor", "counters": ["Profundity"]})
        self.assertEqual(
            saved["rounds"]["1"]["counterDecisions"],
            {"squad:0": "CLS", "fleet:0": "Profundity"},
        )
        self.assertEqual(saved["rounds"]["1"]["counterPlan"]["assignments"], {
            "squad:0": "CLS",
            "fleet:0": "Profundity",
        })
        self.assertEqual(saved["mode"], "3v3")
        self.assertEqual(saved["allyCode"], "111222333")
        self.assertEqual(saved["rounds"]["1"]["opponentAllyCode"], "444555666")

    def test_existing_profile_defaults_to_empty_ally_code(self):
        payload = self.profile_payload()
        del payload["allyCode"]
        created = self.client.post("/api/profiles", json=payload)

        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.get_json()["allyCode"], "")

    def test_existing_database_migrates_profile_ally_code_without_losing_rounds(self):
        connection = sqlite3.connect(app.config["DATABASE"])
        connection.execute(
            "CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, "
            "league TEXT NOT NULL, mode TEXT NOT NULL, rounds_json TEXT NOT NULL, updated_at TEXT NOT NULL)"
        )
        legacy_rounds = {"1": {"squads": [{"leader": "Old defense", "counters": ["Old counter"]}], "fleets": []}}
        connection.execute(
            "INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?)",
            ("legacy-id", "Legacy", "Carbonite", "5v5", json.dumps(legacy_rounds), "2026-01-01T00:00:00+00:00"),
        )
        connection.commit()
        connection.close()

        response = self.client.get("/api/profiles")
        self.assertEqual(response.status_code, 200)
        migrated = response.get_json()["profiles"][0]
        self.assertEqual(migrated["allyCode"], "")
        self.assertEqual(migrated["rounds"]["1"]["squads"][0]["leader"], "Old defense")

    def test_update_migrates_legacy_counter_plan_choices(self):
        legacy_payload = self.profile_payload()
        legacy_round = legacy_payload["rounds"]["1"]
        legacy_round["counterPlan"] = {"squad:0": "CLS", "fleet:0": "Profundity"}
        del legacy_round["counterDecisions"]

        created = self.client.post("/api/profiles", json=self.profile_payload())
        profile_id = created.get_json()["id"]
        updated = self.client.put(f"/api/profiles/{profile_id}", json=legacy_payload)

        self.assertEqual(updated.status_code, 200)
        saved = self.client.get("/api/profiles").get_json()["profiles"][0]
        self.assertEqual(saved["rounds"]["1"]["counterDecisions"], {
            "squad:0": "CLS",
            "fleet:0": "Profundity",
        })

    def test_duplicate_profile_names_are_rejected(self):
        self.assertEqual(self.client.post("/api/profiles", json=self.profile_payload()).status_code, 201)
        duplicate = self.client.post("/api/profiles", json=self.profile_payload())
        self.assertEqual(duplicate.status_code, 409)

    def test_counter_plan_endpoint_returns_forced_assignments_and_feasible_choices(self):
        response = self.client.post("/api/counter-plan", json={
            "squads": [
                {"leader": "Defense A", "counters": ["Counter A"]},
                {"leader": "Defense B", "counters": ["Counter A", "Counter C"]},
                {"leader": "Defense C", "counters": ["Counter B", "Counter C"]},
            ],
            "fleets": [],
            "decisions": {},
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["assignments"], {
            "squad:0": "Counter A",
            "squad:1": "Counter C",
            "squad:2": "Counter B",
        })

        impossible = self.client.post("/api/counter-plan", json={
            "squads": [
                {"leader": "Defense A", "counters": ["Counter A", "Counter B"]},
                {"leader": "Defense B", "counters": ["Counter A", "Counter B"]},
                {"leader": "Defense C", "counters": ["Counter A", "Counter B"]},
            ],
            "fleets": [],
            "decisions": {},
        })
        self.assertFalse(impossible.get_json()["possible"])

    def test_units_endpoint_serves_last_catalog_without_comlink(self):
        catalog = {"characters": [{"id": "LORDVADER", "name": "Lord Vader"}], "ships": []}
        _store_unit_catalog(catalog, "2026-10-22T00:00:00+00:00")

        with patch("app._fetch_unit_catalog_from_comlink") as fetch_catalog:
            response = self.client.get("/api/units")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["source"], "server-cache")
        self.assertEqual(response.get_json()["characters"], catalog["characters"])
        fetch_catalog.assert_not_called()


if __name__ == "__main__":
    unittest.main()