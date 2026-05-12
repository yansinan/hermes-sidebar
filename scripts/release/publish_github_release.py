#!/usr/bin/env python3
"""Publish a GitHub release and upload a packaged extension ZIP asset.

Usage:
  GITHUB_TOKEN=... python3 scripts/release/publish_github_release.py \
    --repo yansinan/hermes-sidebar \
    --tag v0.1.0-20260512 \
    --asset hermes-sidebar-v0.1.0-20260512.zip
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish GitHub release with a ZIP asset")
    parser.add_argument("--repo", required=True, help="GitHub repo in owner/name format")
    parser.add_argument("--tag", required=True, help="Release tag, for example v0.1.0-20260512")
    parser.add_argument("--asset", required=True, help="Path to ZIP file to upload")
    parser.add_argument(
        "--title",
        default="",
        help="Release title; defaults to tag when omitted",
    )
    parser.add_argument(
        "--notes-file",
        default="",
        help="Optional markdown file used as release notes body",
    )
    parser.add_argument(
        "--draft",
        action="store_true",
        help="Create as draft release",
    )
    parser.add_argument(
        "--prerelease",
        action="store_true",
        help="Create as prerelease",
    )
    return parser.parse_args()


def fail(message: str, code: int = 1) -> None:
    print(f"Error: {message}")
    sys.exit(code)


def http_json(url: str, *, method: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method=method,
        headers={
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        fail(f"GitHub API request failed ({exc.code}): {detail}")


def upload_asset(upload_url: str, *, token: str, asset_path: str) -> None:
    asset_name = os.path.basename(asset_path)
    encoded_name = urllib.parse.quote(asset_name)
    url = f"{upload_url}?name={encoded_name}"

    with open(asset_path, "rb") as file:
        asset_data = file.read()

    req = urllib.request.Request(
        url,
        data=asset_data,
        method="POST",
        headers={
            "Authorization": f"token {token}",
            "Content-Type": "application/zip",
            "Accept": "application/vnd.github+json",
        },
    )
    try:
        with urllib.request.urlopen(req):
            return
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        fail(f"Asset upload failed ({exc.code}): {detail}")


def load_notes(notes_file: str) -> str:
    if not notes_file:
        return ""
    if not os.path.isfile(notes_file):
        fail(f"notes file not found: {notes_file}")
    with open(notes_file, "r", encoding="utf-8") as file:
        return file.read()


def main() -> None:
    args = parse_args()
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if not token:
        fail("GITHUB_TOKEN environment variable is required")

    if "/" not in args.repo:
        fail("--repo must be in owner/name format")

    if not os.path.isfile(args.asset):
        fail(f"asset not found: {args.asset}")

    owner, name = args.repo.split("/", 1)
    notes = load_notes(args.notes_file)

    create_payload = {
        "tag_name": args.tag,
        "name": args.title or args.tag,
        "draft": args.draft,
        "prerelease": args.prerelease,
        "body": notes,
    }

    print(f"Creating release {args.tag} in {args.repo}...")
    create_url = f"https://api.github.com/repos/{owner}/{name}/releases"
    release = http_json(create_url, method="POST", token=token, payload=create_payload)

    upload_url = release.get("upload_url", "").split("{")[0]
    if not upload_url:
        fail("release created but upload_url missing in API response")

    print(f"Uploading asset {os.path.basename(args.asset)}...")
    upload_asset(upload_url, token=token, asset_path=args.asset)

    release_url = release.get("html_url") or f"https://github.com/{owner}/{name}/releases/tag/{args.tag}"
    print("")
    print(f"Release published: {release_url}")


if __name__ == "__main__":
    main()
