#!/usr/bin/env python3
"""Build a signed Chrome Extension (CRX) file from dist/ directory.

This script packages the dist/ directory as a CRX3 format extension and signs it
with the provided private key (dist.pem).

Usage:
  python3 scripts/build-crx.py [--output PATH] [--pem PATH] [--version VERSION]

Options:
  --output PATH      Output CRX file path (default: releases/hermes-sidebar-v0.1.2-20260515.crx)
  --pem PATH         Path to private key (default: dist.pem)
  --version VERSION  Version string (default: v0.1.2-20260515)
"""

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path


def get_git_version() -> str:
    """Get version from git tag or describe."""
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--always"],
            cwd=os.path.dirname(__file__),
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()
    except Exception:
        return "v0.1.2-20260515"


def create_zip_archive(source_dir: str, output_zip: str) -> None:
    """Create ZIP archive from directory (without compression for CRX)."""
    import zipfile

    with zipfile.ZipFile(output_zip, "w", zipfile.ZIP_STORED) as zf:
        for root, dirs, files in os.walk(source_dir):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, source_dir)
                zf.write(file_path, arcname)
    print(f"✓ Created ZIP archive: {output_zip}")


def sign_zip_with_pem(zip_path: str, pem_path: str) -> bytes:
    """Sign ZIP file using openssl and private key."""
    try:
        # Use openssl to sign the ZIP file
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", pem_path, zip_path],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to sign ZIP: {result.stderr.decode('utf-8', errors='replace')}"
            )
        signature = result.stdout
        print(f"✓ Signed ZIP with {pem_path}")
        return signature
    except FileNotFoundError:
        raise RuntimeError("openssl not found. Please install OpenSSL.")


def extract_public_key_from_pem(pem_path: str) -> bytes:
    """Extract public key (DER format) from PEM private key using openssl."""
    try:
        # Extract public key in DER format
        result = subprocess.run(
            [
                "openssl",
                "pkey",
                "-in",
                pem_path,
                "-pubout",
                "-outform",
                "DER",
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to extract public key: {result.stderr.decode('utf-8', errors='replace')}"
            )
        public_key = result.stdout
        print(f"✓ Extracted public key from {pem_path}")
        return public_key
    except FileNotFoundError:
        raise RuntimeError("openssl not found. Please install OpenSSL.")


def create_crx3(zip_path: str, signature: bytes, public_key: bytes, output_crx: str) -> None:
    """Create CRX3 file with ZIP, signature, and public key.

    CRX3 format:
    - "Cr24" (4 bytes) - magic number
    - version (4 bytes little-endian) - should be 3
    - public key length (4 bytes little-endian)
    - public key (N bytes)
    - signature length (4 bytes little-endian)
    - signature (N bytes)
    - ZIP data (rest of file)
    """
    with open(zip_path, "rb") as f:
        zip_data = f.read()

    with open(output_crx, "wb") as f:
        # Magic number
        f.write(b"Cr24")

        # Version (3)
        f.write(struct.pack("<I", 3))

        # Public key length and data
        f.write(struct.pack("<I", len(public_key)))
        f.write(public_key)

        # Signature length and data
        f.write(struct.pack("<I", len(signature)))
        f.write(signature)

        # ZIP data
        f.write(zip_data)

    file_size = os.path.getsize(output_crx)
    print(f"✓ Created CRX3 file: {output_crx} ({file_size} bytes)")


def build_crx(
    dist_dir: str = "dist",
    pem_path: str = "dist.pem",
    output_path: str = None,
    version: str = None,
) -> str:
    """Build CRX file from dist directory."""

    # Resolve paths
    dist_dir = os.path.abspath(dist_dir)
    pem_path = os.path.abspath(pem_path)

    if not os.path.isdir(dist_dir):
        raise FileNotFoundError(f"dist directory not found: {dist_dir}")

    if not os.path.isfile(pem_path):
        raise FileNotFoundError(f"PEM key not found: {pem_path}")

    # Determine output path
    if output_path is None:
        if version is None:
            version = get_git_version()
        output_dir = os.path.join(os.path.dirname(dist_dir), "releases")
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f"hermes-sidebar-{version}.crx")

    output_path = os.path.abspath(output_path)

    # Create temporary ZIP
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmp_zip = tmp.name

    try:
        print(f"Building CRX from: {dist_dir}")
        print(f"Using key: {pem_path}")

        # Step 1: Create ZIP archive
        create_zip_archive(dist_dir, tmp_zip)

        # Step 2: Extract public key
        public_key = extract_public_key_from_pem(pem_path)

        # Step 3: Sign ZIP
        signature = sign_zip_with_pem(tmp_zip, pem_path)

        # Step 4: Create CRX3
        create_crx3(tmp_zip, signature, public_key, output_path)

        print(f"\n✅ CRX file ready: {output_path}")
        return output_path

    finally:
        # Cleanup temporary ZIP
        if os.path.exists(tmp_zip):
            os.remove(tmp_zip)


def main():
    parser = argparse.ArgumentParser(description="Build signed Chrome Extension (CRX3)")
    parser.add_argument(
        "--output",
        default=None,
        help="Output CRX file path",
    )
    parser.add_argument(
        "--pem",
        default="dist.pem",
        help="Path to private key (default: dist.pem)",
    )
    parser.add_argument(
        "--version",
        default=None,
        help="Version string for output filename",
    )
    parser.add_argument(
        "--dist",
        default="dist",
        help="Path to dist directory (default: dist)",
    )

    args = parser.parse_args()

    try:
        crx_path = build_crx(
            dist_dir=args.dist,
            pem_path=args.pem,
            output_path=args.output,
            version=args.version,
        )
        print(f"✓ Build successful: {crx_path}")
        sys.exit(0)
    except Exception as e:
        print(f"✗ Build failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
