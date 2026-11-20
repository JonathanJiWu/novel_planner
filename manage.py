"""Operator commands for the built-in SQLite account database.

Run on the server (for Render, in the service's Shell tab):

    python manage.py migrate                 # apply schema migrations (backs up first)
    python manage.py backup                  # write a timestamped copy of the database
    python manage.py create-user EMAIL       # create an account, including ADMIN_EMAILS addresses
    python manage.py set-password EMAIL      # reset a password and sign out its sessions
    python manage.py list-users

Passwords are read from a prompt, or from standard input with --password-stdin.
"""
from __future__ import annotations

import argparse
import getpass
import sys

from auth_store import AuthStore
from config import settings


def _read_password(from_stdin: bool) -> str:
    if from_stdin:
        return sys.stdin.readline().rstrip("\n")
    password = getpass.getpass("Password: ")
    if password != getpass.getpass("Repeat password: "):
        raise SystemExit("Passwords do not match.")
    return password


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage the Novel Architect account database.")
    parser.add_argument("--database", help=f"SQLite file (default: {settings.database_file})")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate", help="Apply pending schema migrations")
    commands.add_parser("backup", help="Write a timestamped copy of the database")
    commands.add_parser("list-users", help="List accounts")
    for name, help_text in (
        ("create-user", "Create an account (works for ADMIN_EMAILS addresses)"),
        ("set-password", "Reset an account password and revoke its sessions"),
    ):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("email")
        command.add_argument("--password-stdin", action="store_true", help="Read the password from stdin")
    args = parser.parse_args(argv)

    if settings.configured:
        print("Supabase is configured; accounts are managed in the Supabase dashboard.", file=sys.stderr)
        return 2

    store = AuthStore(args.database) if args.database else AuthStore()
    if args.command == "migrate":
        print(f"{store.path} is at schema version {store.schema_version()}.")
    elif args.command == "backup":
        print(f"Backup written to {store.backup()}")
    elif args.command == "list-users":
        for user in store.list_users():
            admin = " (admin)" if settings.is_admin_email(user["email"]) else ""
            print(f"{user['email']}{admin}\t{user['id']}\t{user['created_at']}")
    elif args.command == "create-user":
        try:
            _token, user = store.register(args.email, _read_password(args.password_stdin), allow_reserved=True)
        except ValueError as exc:
            print(exc, file=sys.stderr)
            return 1
        print(f"Created {user['email']} ({user['id']}).")
    elif args.command == "set-password":
        try:
            store.set_password(args.email, _read_password(args.password_stdin))
        except ValueError as exc:
            print(exc, file=sys.stderr)
            return 1
        print(f"Password updated for {AuthStore.normalize_email(args.email)}; existing sessions were signed out.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
