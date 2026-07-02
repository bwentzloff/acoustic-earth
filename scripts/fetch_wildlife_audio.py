#!/usr/bin/env python3
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import List

INTERNET_ARCHIVE_API_URL = "https://archive.org/advancedsearch.php"
INTERNET_ARCHIVE_METADATA_URL = "https://archive.org/metadata/{identifier}"
USER_AGENT = "Mozilla/5.0"
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
AUDIO_MIME_HINTS = {"audio/mpeg", "audio/x-wav", "audio/wav", "audio/ogg", "audio/flac", "audio/mp4", "audio/x-m4a"}


def sanitize_filename(name: str, fallback: str = "recording") -> str:
    path = Path(name or fallback)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", path.stem).strip("._-")
    ext = path.suffix.lower() if path.suffix.lower() else ".mp3"
    return f"{stem or fallback}{ext}"


def fetch_recordings(limit: int, query: str = "wildlife sounds") -> List[dict]:
    results: List[dict] = []
    seen_identifiers = set()

    params = {
        "q": f"{query} mediatype:audio",
        "rows": str(min(100, max(10, limit))),
        "output": "json",
        "fl": "identifier,title,description,subject,creator,year,collection,downloads",
        "sort": "downloads desc",
    }
    url = INTERNET_ARCHIVE_API_URL + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except Exception as exc:
        print(f"Warning: unable to reach Internet Archive API ({exc}); stopping early.", file=sys.stderr)
        return []

    docs = payload.get("response", {}).get("docs", [])
    for doc in docs:
        identifier = doc.get("identifier")
        if not identifier or identifier in seen_identifiers:
            continue
        seen_identifiers.add(identifier)

        title = doc.get("title") or identifier
        description = doc.get("description") or "Wildlife audio"
        if isinstance(description, list):
            description = " ".join(str(item) for item in description if item)

        lowered_text = f"{title} {description}".lower()
        if any(skip in lowered_text for skip in ["librivox", "audiobook", "book", "story", "poem", "drama", "gospel", "quran"]):
            continue

        metadata_url = INTERNET_ARCHIVE_METADATA_URL.format(identifier=urllib.parse.quote(identifier))
        metadata_request = urllib.request.Request(metadata_url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(metadata_request, timeout=30) as metadata_response:
                metadata = json.load(metadata_response)
        except Exception as exc:
            print(f"Warning: unable to fetch metadata for {identifier}: {exc}", file=sys.stderr)
            metadata = {}

        files = metadata.get("files", []) if isinstance(metadata, dict) else []
        audio_file = None
        for file_entry in files:
            filename = file_entry.get("name", "")
            lower_name = filename.lower()
            if any(lower_name.endswith(ext) for ext in AUDIO_EXTENSIONS):
                audio_file = filename
                break
            if any(hint in (file_entry.get("format") or "") for hint in AUDIO_MIME_HINTS):
                audio_file = filename
                break

        if not audio_file:
            continue

        download_url = f"https://archive.org/download/{identifier}/{urllib.parse.quote(audio_file)}"
        location = "Unknown"
        if isinstance(metadata.get("metadata"), dict):
            location = metadata["metadata"].get("location") or metadata["metadata"].get("geo") or location

        results.append(
            {
                "id": identifier,
                "file-name": audio_file,
                "file": download_url,
                "gen": "",
                "sp": "",
                "en": str(description) or "Wildlife",
                "loc": str(location) if location else "Unknown",
                "lat": None,
                "lng": None,
                "query": query,
                "source_url": f"https://archive.org/details/{identifier}",
            }
        )
        if len(results) >= limit:
            break

    return results[:limit]


def download_file(url: str, destination: Path) -> bool:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
    except Exception as exc:
        print(f"Warning: failed to download {url}: {exc}", file=sys.stderr)
        return False

    destination.write_bytes(data)
    return True


def build_manifest(entries: List[dict], output_dir: Path) -> dict:
    manifest_entries = []
    for index, entry in enumerate(entries):
        manifest_entries.append(entry)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "internet-archive",
        "entries": manifest_entries,
    }


def load_existing_audio(output_dir: Path, limit: int) -> List[dict]:
    entries: List[dict] = []
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


def write_manifest(output_dir: Path, manifest: dict) -> None:
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote manifest to {manifest_path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Download wildlife audio and build a manifest.")
    parser.add_argument("--limit", type=int, default=100, help="How many audio files to collect.")
    parser.add_argument("--output-dir", default="public/audio", help="Directory where audio files should be stored.")
    parser.add_argument("--query", default="wildlife sounds", help="Internet Archive search string.")
    parser.add_argument("--dry-run", action="store_true", help="Do not download anything; just build a manifest from existing files.")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    downloaded_entries: List[dict] = []
    if not args.dry_run:
        recordings = fetch_recordings(args.limit, args.query)
        for recording in recordings:
            recording_id = recording.get("id")
            filename_hint = recording.get("file-name") or f"{recording_id}.mp3"
            filename = sanitize_filename(filename_hint, fallback=f"{recording_id}.mp3")
            destination = output_dir / filename
            if destination.exists():
                print(f"Skipping existing file {destination.name}")
            else:
                download_url = recording.get("file") or f"https://archive.org/download/{recording_id}"
                if download_file(download_url, destination):
                    print(f"Downloaded {destination.name}")

            species = " ".join(part for part in [recording.get("gen"), recording.get("sp")] if part)
            common_name = recording.get("en") or species or "Wildlife"
            latitude = recording.get("lat")
            longitude = recording.get("lng")
            try:
                latitude = float(latitude) if latitude not in (None, "") else None
            except (TypeError, ValueError):
                latitude = None
            try:
                longitude = float(longitude) if longitude not in (None, "") else None
            except (TypeError, ValueError):
                longitude = None

            downloaded_entries.append(
                {
                    "id": recording_id,
                    "filename": destination.name,
                    "path": f"/audio/{destination.name}",
                    "species": species,
                    "common_name": common_name,
                    "location": recording.get("loc") or "Unknown",
                    "latitude": latitude,
                    "longitude": longitude,
                    "source_url": recording.get("source_url") or f"https://archive.org/details/{recording_id}",
                }
            )

    existing_entries = load_existing_audio(output_dir, args.limit)
    combined_entries = downloaded_entries + [entry for entry in existing_entries if entry["filename"] not in {item["filename"] for item in downloaded_entries}]

    if not combined_entries:
        print("No audio files were found; created an empty manifest.")

    manifest = build_manifest(combined_entries, output_dir)
    write_manifest(output_dir, manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
