#!/usr/bin/env python3
"""
Ed25519 key management and passwordless login key generator.

Commands:
  generate     Generate Ed25519 keypair, save to file.
  login-key    Generate one-time login key from saved identity.
  show-key     Print public key from saved identity.

Options use POSIX/GNU style: short (-o) and long (--output).

Examples:
  nopw generate -o ./id.json
  nopw show-key -i ./id.json
  nopw login-key -i ./id.json -e user@example.com
"""

import argparse
import json
import os
import sys
import time
import base64

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    PrivateFormat,
    PublicFormat,
    NoEncryption,
    Encoding,
)

# ─── helpers ───

def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _pubkey_b64(pub: bytes) -> str:
    """Standard base64 (not url-safe) for server-side storage."""
    return base64.b64encode(pub).decode()


def _load_identity(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _save_identity(path: str, data: dict) -> None:
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(path, 0o600)


# ─── commands ───

def cmd_generate(args: argparse.Namespace) -> None:
    """Generate Ed25519 keypair and save to file."""
    if os.path.exists(args.output) and not args.force:
        print(f"error: {args.output} already exists (use -f to overwrite)", file=sys.stderr)
        sys.exit(1)

    priv = Ed25519PrivateKey.generate()
    raw_priv = priv.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    raw_pub = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)

    identity = {
        "private": _b64url(raw_priv),
        "public": _pubkey_b64(raw_pub),
    }
    _save_identity(args.output, identity)
    print(f"saved to {args.output}")


def cmd_show_key(args: argparse.Namespace) -> None:
    """Print public key from identity file."""
    ident = _load_identity(args.identity)
    print(ident["public"])


def cmd_login_key(args: argparse.Namespace) -> None:
    """Generate a one-time login key from identity file."""
    ident = _load_identity(args.identity)
    raw_priv = base64.urlsafe_b64decode(ident["private"] + "==")
    priv = Ed25519PrivateKey.from_private_bytes(raw_priv)

    timestamp = int(time.time())
    nonce = os.urandom(16)
    site_ctx = args.context or ""
    message = f"{timestamp}{args.email}{site_ctx}".encode()
    signature = priv.sign(message + nonce)

    key = f"{_b64url(signature)}.{_b64url(str(timestamp).encode())}.{_b64url(nonce)}"
    print(key)


# ─── main ───

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="nopw",
        description="Ed25519 key management and passwordless login tool",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_gen = sub.add_parser("generate", help="Generate Ed25519 keypair")
    p_gen.add_argument("-o", "--output", required=True, help="Output file path")
    p_gen.add_argument("-f", "--force", action="store_true", help="Overwrite existing file")

    p_show = sub.add_parser("show-key", help="Print public key")
    p_show.add_argument("-i", "--identity", required=True, help="Identity file path")

    p_login = sub.add_parser("login-key", help="Generate one-time login key")
    p_login.add_argument("-i", "--identity", required=True, help="Identity file path")
    p_login.add_argument("-e", "--email", required=True, help="User email")
    p_login.add_argument("-c", "--context", default="", help="Site context (origin/referer)")

    args = parser.parse_args()

    if args.command == "generate":
        cmd_generate(args)
    elif args.command == "show-key":
        cmd_show_key(args)
    elif args.command == "login-key":
        cmd_login_key(args)


if __name__ == "__main__":
    main()
