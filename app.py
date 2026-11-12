import base64
import io
import json
import os
import sqlite3
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request
from dotenv import load_dotenv

from gac_rules import LEAGUE_ORDER, LEAGUE_REQUIREMENTS, solve_counter_plan


load_dotenv()
app = Flask(__name__)
DEFAULT_ALLY_CODE = ""
app.config["DATABASE"] = os.getenv(
    "DATABASE_PATH",
    str(Path(__file__).resolve().parent / "data" / "gac_fieldbook.sqlite3"),
)


def _configuration():
    return {
        league: {
            "5v5": values.squads_5v5,
            "3v3": values.squads_3v3,
            "fleets": values.fleets,
        }
        for league, values in LEAGUE_REQUIREMENTS.items()
    }


def _database_connection():
    database_path = Path(app.config["DATABASE"])
    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 10000")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS profiles (
            profile_id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            league TEXT NOT NULL,
            mode TEXT NOT NULL,
            rounds_json TEXT NOT NULL,
            ally_code TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        )
        """
    )
    profile_columns = {
        row["name"] for row in connection.execute("PRAGMA table_info(profiles)").fetchall()
    }
    if "ally_code" not in profile_columns:
        connection.execute(
            f"ALTER TABLE profiles ADD COLUMN ally_code TEXT NOT NULL DEFAULT '{DEFAULT_ALLY_CODE}'"
        )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS unit_catalog (
            catalog_id INTEGER PRIMARY KEY CHECK (catalog_id = 1),
            catalog_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    return connection


def _normalize_profile(payload):
    if not isinstance(payload, dict):
        raise ValueError("Profile data must be an object.")

    name = payload.get("name")
    league = payload.get("league")
    mode = payload.get("mode")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 32:
        raise ValueError("Profile name must contain 1 to 32 characters.")
    if league not in LEAGUE_REQUIREMENTS:
        raise ValueError("Select a valid GAC league.")
    if mode not in ("3v3", "5v5"):
        raise ValueError("Select a valid GAC format.")
    ally_code = _normalize_ally_code(payload.get("allyCode", DEFAULT_ALLY_CODE), DEFAULT_ALLY_CODE)

    input_rounds = payload.get("rounds", {})
    if not isinstance(input_rounds, dict):
        raise ValueError("Round data must be an object.")

    rounds = {}
    for round_number in range(1, 4):
        source = input_rounds.get(str(round_number), input_rounds.get(round_number, {}))
        if not isinstance(source, dict):
            source = {}
        squads = _normalize_slots(source.get("squads", []))
        fleets = _normalize_slots(source.get("fleets", []))
        decision_data = source["counterDecisions"] if "counterDecisions" in source else source.get("counterPlan", {})
        decisions = _normalize_counter_plan(decision_data)
        teams = [
            {"key": f"squad:{index}", "leader": slot["leader"], "counters": slot["counters"]}
            for index, slot in enumerate(squads)
        ] + [
            {"key": f"fleet:{index}", "leader": slot["leader"], "counters": slot["counters"]}
            for index, slot in enumerate(fleets)
        ]
        rounds[str(round_number)] = {
            "squads": squads,
            "fleets": fleets,
            "opponentAllyCode": _normalize_ally_code(source.get("opponentAllyCode", "")),
            "counterDecisions": decisions,
            "counterPlan": solve_counter_plan(teams, decisions),
        }

    return {"name": name.strip(), "league": league, "mode": mode, "allyCode": ally_code, "rounds": rounds}


def _normalize_ally_code(value, default=""):
    if not isinstance(value, str):
        return default
    return "".join(character for character in value if character.isdigit())[:9]


def _normalize_slots(value):
    if not isinstance(value, list):
        return []
    normalized = []
    for slot in value[:30]:
        if not isinstance(slot, dict):
            continue
        leader = slot.get("leader", "")
        counters = slot.get("counters", [])
        normalized.append(
            {
                "leader": leader[:120] if isinstance(leader, str) else "",
                "counters": [item[:120] for item in counters[:30] if isinstance(item, str)]
                if isinstance(counters, list)
                else [],
            }
        )
    return normalized


def _normalize_counter_plan(value):
    if not isinstance(value, dict):
        return {}
    normalized = {}
    for key, counter in value.items():
        if not isinstance(key, str) or not isinstance(counter, str):
            continue
        kind, separator, index = key.partition(":")
        if separator and kind in ("squad", "fleet") and index.isdigit() and int(index) < 30:
            normalized[f"{kind}:{int(index)}"] = counter[:120]
    return normalized


def _counter_plan_from_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("Counter plan data must be an object.")
    squads = _normalize_slots(payload.get("squads", []))
    fleets = _normalize_slots(payload.get("fleets", []))
    teams = [
        {"key": f"squad:{index}", "leader": slot["leader"], "counters": slot["counters"]}
        for index, slot in enumerate(squads)
    ] + [
        {"key": f"fleet:{index}", "leader": slot["leader"], "counters": slot["counters"]}
        for index, slot in enumerate(fleets)
    ]
    return solve_counter_plan(teams, _normalize_counter_plan(payload.get("decisions", {})))


def _profile_from_row(row):
    return {
        "id": row["profile_id"],
        "name": row["name"],
        "league": row["league"],
        "mode": row["mode"],
        "allyCode": row["ally_code"],
        "rounds": json.loads(row["rounds_json"]),
        "updatedAt": row["updated_at"],
    }


def _get_cached_unit_catalog():
    connection = _database_connection()
    try:
        row = connection.execute(
            "SELECT catalog_json, updated_at FROM unit_catalog WHERE catalog_id = 1"
        ).fetchone()
        if row is None:
            return None
        return json.loads(row["catalog_json"]), row["updated_at"]
    finally:
        connection.close()


def _store_unit_catalog(catalog, updated_at):
    connection = _database_connection()
    try:
        connection.execute(
            "INSERT INTO unit_catalog (catalog_id, catalog_json, updated_at) VALUES (1, ?, ?) "
            "ON CONFLICT(catalog_id) DO UPDATE SET catalog_json = excluded.catalog_json, updated_at = excluded.updated_at",
            (json.dumps(catalog), updated_at),
        )
        connection.commit()
    finally:
        connection.close()


def _localization_lookup(localization):
    values = {}
    bundle = localization.get("localizationBundle") if isinstance(localization, dict) else None

    if isinstance(bundle, str):
        try:
            archive_bytes = base64.b64decode(bundle)
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                text_file = next(
                    name for name in archive.namelist()
                    if name.startswith("Loc_") and "Mapping" not in name
                )
                lines = archive.read(text_file).decode("utf-8-sig").splitlines()
            for line in lines:
                key, separator, value = line.partition("|")
                if separator:
                    values[key] = value
            return values
        except (ValueError, OSError, StopIteration, zipfile.BadZipFile):
            return values

    def visit(node):
        if isinstance(node, dict):
            key = node.get("id") or node.get("key") or node.get("name")
            value = node.get("value") or node.get("text")
            if key and value:
                values[key] = value
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(localization)
    if isinstance(localization, dict):
        values.update({key: value for key, value in localization.items() if isinstance(value, str)})
    return values


def _playable_unit_options(unit_records, names):
    by_combat_type = {1: {}, 2: {}}
    for unit in unit_records:
        combat_type = unit.get("combatType")
        base_id = unit.get("baseId") or unit.get("unitId")
        category_ids = unit.get("categoryId", [])

        if combat_type not in by_combat_type or not base_id:
            continue
        if unit.get("obtainable") is not True or unit.get("loanedUnit") is True:
            continue
        if combat_type == 2 and unit.get("unitClass") != 7:
            continue

        if not "any_obtainable" in category_ids:
            continue

        if "GLE" in base_id or "EVENT" in base_id:
            continue

        name_key = unit.get("nameKey", "")
        by_combat_type[combat_type].setdefault(
            base_id,
            {"id": base_id, "name": unit.get("name") or names.get(name_key) or base_id},
        )

    return {
        "characters": sorted(by_combat_type[1].values(), key=lambda entry: entry["name"].casefold()),
        "ships": sorted(by_combat_type[2].values(), key=lambda entry: entry["name"].casefold()),
    }


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/config")
def config():
    return jsonify({"leagueOrder": LEAGUE_ORDER, "leagues": _configuration(), "rounds": 3})


@app.get("/api/profiles")
def list_profiles():
    connection = _database_connection()
    try:
        rows = connection.execute(
            "SELECT * FROM profiles ORDER BY name COLLATE NOCASE"
        ).fetchall()
        return jsonify({"profiles": [_profile_from_row(row) for row in rows]})
    finally:
        connection.close()


@app.post("/api/profiles")
def create_profile():
    try:
        profile = _normalize_profile(request.get_json(silent=True))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    profile_id = str(uuid.uuid4())
    updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    connection = _database_connection()
    try:
        connection.execute(
            "INSERT INTO profiles (profile_id, name, league, mode, rounds_json, ally_code, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (profile_id, profile["name"], profile["league"], profile["mode"], json.dumps(profile["rounds"]), profile["allyCode"], updated_at),
        )
        connection.commit()
        return jsonify({**profile, "id": profile_id, "updatedAt": updated_at}), 201
    except sqlite3.IntegrityError:
        return jsonify({"error": "A profile with that name already exists."}), 409
    finally:
        connection.close()


@app.put("/api/profiles/<profile_id>")
def update_profile(profile_id):
    try:
        profile = _normalize_profile(request.get_json(silent=True))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    connection = _database_connection()
    try:
        cursor = connection.execute(
            "UPDATE profiles SET name = ?, league = ?, mode = ?, rounds_json = ?, ally_code = ?, updated_at = ? "
            "WHERE profile_id = ?",
            (profile["name"], profile["league"], profile["mode"], json.dumps(profile["rounds"]), profile["allyCode"], updated_at, profile_id),
        )
        if cursor.rowcount == 0:
            return jsonify({"error": "Profile not found."}), 404
        connection.commit()
        return jsonify({**profile, "id": profile_id, "updatedAt": updated_at})
    except sqlite3.IntegrityError:
        return jsonify({"error": "A profile with that name already exists."}), 409
    finally:
        connection.close()


@app.post("/api/counter-plan")
def counter_plan():
    try:
        result = _counter_plan_from_payload(request.get_json(silent=True))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify(result)


def _fetch_unit_catalog_from_comlink():
    from swgoh_comlink import SwgohComlink
    from swgoh_comlink.helpers import DataItems

    with SwgohComlink(
        url=os.getenv("COMLINK_URL", "http://localhost:5000"),
        stats_url=os.getenv("COMLINK_STATS_URL", "http://localhost:3223"),
        access_key=os.getenv("COMLINK_ACCESS_KEY"),
        secret_key=os.getenv("COMLINK_SECRET_KEY"),
    ) as comlink:
        game_data = comlink.get_game_data(items=DataItems.UNITS, include_pve_units=False)
        try:
            localization = comlink.get_localization(locale="ENG_US")
        except Exception:
            localization = {}

    names = _localization_lookup(localization)
    unit_records = game_data.get("units", []) if isinstance(game_data, dict) else []
    return _playable_unit_options(unit_records, names)


@app.get("/api/units")
def units():
    cached = _get_cached_unit_catalog()
    force_refresh = request.args.get("refresh") == "1"
    if cached and not force_refresh:
        catalog, updated_at = cached
        return jsonify({**catalog, "source": "server-cache", "updatedAt": updated_at})

    try:
        catalog = _fetch_unit_catalog_from_comlink()
        updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        _store_unit_catalog(catalog, updated_at)
        return jsonify({**catalog, "source": "comlink", "updatedAt": updated_at})
    except Exception:
        app.logger.exception("Could not refresh unit data from Comlink")
        if cached:
            catalog, updated_at = cached
            return jsonify({
                **catalog,
                "source": "server-cache",
                "updatedAt": updated_at,
                "refreshFailed": True,
            })
        return jsonify({"error": "No server catalog is available and Comlink could not be reached."}), 503


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=False)