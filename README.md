# GAC Fieldbook

A local-first planner for scouting Grand Arena Championship (GAC) defenses, recording possible counter leaders, and checking that planned counters are globally usable without reusing the same counter team.

## Features

- Organizes defense and counter notes across all three GAC rounds.
- Supports 3v3 and 5v5 formats, league-specific squad slots, and separate fleet slots.
- Suggests feasible counter assignments and flags conflicts between rounds' plans.
- Keeps profiles and the last successful Comlink unit catalog in a local SQLite database.
- Works with manual leader entry when Comlink is not configured or available.

## Requirements

- Python 3.10 or newer.
- Comlink is optional. To use unit-name autocomplete, configure a reachable SWGOH Comlink service.

## Run locally

From the project directory, create a virtual environment and install the dependencies.

Windows PowerShell:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python app.py
```

Linux or macOS:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
python app.py
```

Open `http://localhost:8000`. The app creates `data/gac_fieldbook.sqlite3` on first use. Configure Comlink in `.env` if it is not running on the same computer. The access and secret keys are read by the Python service and are not sent to the browser.

## Use on a trusted local network

The server listens on all network interfaces. To open it from another device on your private network, use `http://<server-lan-ip>:8000` and allow that port through the host firewall only for trusted devices.

There is no login or per-profile access control. Anyone who can reach the server can read, create, and change every profile. Do not expose port 8000 to the public internet or forward it from your router. For internet access, put the app behind an appropriately secured deployment with authentication and HTTPS.

## Linux systemd deployment

The included systemd unit expects a dedicated `gac-fieldbook` account and an installation at `/opt/gac-fieldbook`. On Debian or Ubuntu, create the account and directory, then clone or copy the project there:

```bash
sudo apt update
sudo apt install git python3 python3-venv
sudo useradd --system --home /opt/gac-fieldbook --shell /usr/sbin/nologin gac-fieldbook
sudo mkdir -p /opt/gac-fieldbook
sudo chown gac-fieldbook:gac-fieldbook /opt/gac-fieldbook
sudo -u gac-fieldbook git clone <repository-url> /opt/gac-fieldbook
sudo -u gac-fieldbook python3 -m venv /opt/gac-fieldbook/.venv
sudo -u gac-fieldbook /opt/gac-fieldbook/.venv/bin/pip install -r /opt/gac-fieldbook/requirements-linux.txt
sudo -u gac-fieldbook cp /opt/gac-fieldbook/.env.example /opt/gac-fieldbook/.env
```

Edit `/opt/gac-fieldbook/.env` with the Comlink settings if needed, then restrict access to the environment file and install the unit:

```bash
sudo chmod 600 /opt/gac-fieldbook/.env
sudo install -o root -g root -m 0644 /opt/gac-fieldbook/deploy/gac-fieldbook.service /etc/systemd/system/gac-fieldbook.service
sudo systemctl daemon-reload
sudo systemctl enable --now gac-fieldbook
sudo systemctl status gac-fieldbook
```

Allow inbound TCP port 8000 only from trusted devices on your private network. View service logs with `sudo journalctl -u gac-fieldbook -f`.

## Configuration and data

Copy `.env.example` to `.env` and set values as needed:

| Variable | Purpose | Default |
| --- | --- | --- |
| `COMLINK_URL` | Comlink game-data endpoint | `http://localhost:5000` |
| `COMLINK_STATS_URL` | Comlink stats endpoint | `http://localhost:3223` |
| `COMLINK_ACCESS_KEY` | Comlink access key, if required | empty |
| `COMLINK_SECRET_KEY` | Comlink secret key, if required | empty |
| `DATABASE_PATH` | SQLite database location | `data/gac_fieldbook.sqlite3` |
| `PORT` | Development server port | `8000` |

Profiles and cached unit data are stored on the server in SQLite. Back up the database file regularly. Do not commit `.env` or database files; these are excluded by `.gitignore`.

## Tests

```bash
python -m unittest discover -s tests
```

The default league defense counts in `gac_rules.py` are documented in `gac_info.md`; verify them against the active game's configuration before relying on them.