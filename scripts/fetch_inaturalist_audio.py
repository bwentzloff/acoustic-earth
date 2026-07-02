#!/usr/bin/env python3
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

INATURALIST_API_URL = "https://api.inaturalist.org/v1/observations"
USER_AGENT = "Mozilla/5.0"
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
AUDIO_MIME_HINTS = {"audio/mpeg", "audio/x-wav", "audio/wav", "audio/ogg", "audio/flac", "audio/mp4", "audio/x-m4a", "audio/aac"}


def sanitize_filename(name: str, fallback: str = "sound") -> str:
    path = Path(name or fallback)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", path.stem).strip("._-")
    ext = path.suffix.lower() if path.suffix.lower() in AUDIO_EXTENSIONS else ".m4a"
    return f"{stem or fallback}{ext}"


def request_json(url: str) -> Optional[Dict]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except Exception as exc:
        print(f"Warning: unable to fetch {url}: {exc}", file=sys.stderr)
        return None


def parse_coordinates(observation: Dict) -> Optional[Dict[str, float]]:
    geojson = observation.get("geojson")
    if isinstance(geojson, dict) and geojson.get("type") == "Point":
        coords = geojson.get("coordinates")
        if isinstance(coords, list) and len(coords) >= 2:
            return {"longitude": float(coords[0]), "latitude": float(coords[1])}

    location = observation.get("location")
    if isinstance(location, str) and "," in location:
        try:
            lat_str, lon_str = [part.strip() for part in location.split(",", 1)]
            return {"latitude": float(lat_str), "longitude": float(lon_str)}
        except ValueError:
            return None

    return None


def build_observation_query(page: int, per_page: int, query: str) -> str:
    params = {
        "sounds": "true",
        "geo": "true",
        "per_page": str(per_page),
        "page": str(page),
        "order": "desc",
        "order_by": "created_at",
    }
    if query:
        params["q"] = query
    return INATURALIST_API_URL + "?" + urllib.parse.urlencode(params)


def fetch_observations(limit: int, query: str) -> List[Dict]:
    results: List[Dict] = []
    page = 1
    per_page = min(100, max(20, limit))

    while len(results) < limit:
        url = build_observation_query(page, per_page, query)
        payload = request_json(url)
        if not payload:
            break

        observations = payload.get("results") or []
        if not observations:
            break

        for obs in observations:
            coords = parse_coordinates(obs)
            if not coords:
                continue

            sounds = obs.get("sounds") or []
            if not isinstance(sounds, list) or not sounds:
                continue

            for sound in sounds:
                if not isinstance(sound, dict):
                    continue
                sound_url = sound.get("file_url")
                if not sound_url or not isinstance(sound_url, str):
                    continue

                sound_item = {
                    "observation": obs,
                    "sound": sound,
                    "coordinates": coords,
                }
                results.append(sound_item)
                break

            if len(results) >= limit:
                break

        if len(results) >= limit:
            break

        page += 1
        time.sleep(0.2)

    return results[:limit]


def download_file(url: str, destination: Path) -> bool:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            destination.write_bytes(response.read())
        return True
    except Exception as exc:
        print(f"Warning: failed to download {url}: {exc}", file=sys.stderr)
        return False


def load_existing_audio(output_dir: Path, limit: int) -> List[Dict]:
    entries: List[Dict] = []
    for path in sorted(output_dir.glob("*")):
        if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS:
            entries.append(
                {
                    "filename": path.name,
                    "path": f"/audio/{path.name}",
                    "species": path.stem,
                    "common_name": path.stem,
                    "location": "Unknown",
                    "latitude": None,
                    "longitude": None,
                    "source_url": "",
                }
            )
            if len(entries) >= limit:
                break
    return entries


def build_manifest(entries: List[Dict], output_dir: Path) -> Dict:
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "inaturalist",
        "entries": entries,
    }


def write_manifest(output_dir: Path, manifest: Dict) -> None:
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote manifest to {manifest_path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Download sounds from iNaturalist and update the audio manifest.")
    parser.add_argument("--limit", type=int, default=100, help="Number of sounds to collect.")
    parser.add_argument("--output-dir", default="public/audio", help="Directory for downloaded audio and manifest.")
    parser.add_argument("--query", default="", help="Optional iNaturalist search query string.")
    parser.add_argument("--dry-run", action="store_true", help="Do not download audio; only build or update the manifest.")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    raw_items = fetch_observations(args.limit, args.query)
    if not raw_items:
        print("No observations with sounds and coordinates were found.")

    new_entries: List[Dict] = []
    for item in raw_items:
        obs = item["observation"]
        sound = item["sound"]
        coords = item["coordinates"]

        obs_id = obs.get("id")
        sound_id = sound.get("id")
        taxon = obs.get("taxon") or {}
        species = obs.get("species_guess") or (taxon.get("name") if isinstance(taxon, dict) else None) or "iNaturalist sound"
        common_name = obs.get("species_guess") or obs.get("iconic_taxon_name") or "Wildlife"
        location = obs.get("place_guess") or obs.get("location") or "Unknown"
        source_url = obs.get("uri") or f"https://www.inaturalist.org/observations/{obs_id}"
        sound_url = sound.get("file_url")

        parsed = urllib.parse.urlparse(sound_url or "")
        base_name = Path(parsed.path).name
        ext = Path(base_name).suffix.lower() if Path(base_name).suffix.lower() in AUDIO_EXTENSIONS else ".m4a"
        filename = sanitize_filename(f"{common_name}-{obs_id}-{sound_id}{ext}", fallback=f"inat-{sound_id}{ext}")
        destination = output_dir / filename

        if not args.dry_run and sound_url:
            if destination.exists():
                print(f"Skipping existing file {destination.name}")
            else:
                downloaded = download_file(sound_url, destination)
                if downloaded:
                    print(f"Downloaded {destination.name}")
                else:
                    continue

        new_entries.append(
            {
                "filename": destination.name,
                "path": f"/audio/{destination.name}",
                "species": species,
                "common_name": common_name,
                "location": location,
                "latitude": coords.get("latitude"),
                "longitude": coords.get("longitude"),
                "source_url": source_url,
            }
        )

    existing_entries = load_existing_audio(output_dir, args.limit)
    filenames = {entry["filename"] for entry in new_entries}
    combined_entries = new_entries + [entry for entry in existing_entries if entry["filename"] not in filenames]

    manifest = build_manifest(combined_entries[:args.limit], output_dir)
    write_manifest(output_dir, manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
