#!/bin/sh
set -eu

if [ -z "${THOR_ADMIN_EMAILS:-}" ]; then
  echo >&2 "THOR_ADMIN_EMAILS is required"
  exit 1
fi

admin_regex=""
old_ifs=$IFS
IFS=,
set -- ${THOR_ADMIN_EMAILS}
IFS=$old_ifs

for raw_email in "$@"; do
  email=$(printf '%s' "$raw_email" | tr -d '[:space:]')
  if [ -z "$email" ]; then
    continue
  fi

  escaped=$(printf '%s' "$email" | sed 's/[][\\.^$*+?(){}|]/\\&/g')
  if [ -n "$admin_regex" ]; then
    admin_regex="${admin_regex}|${escaped}"
  else
    admin_regex="$escaped"
  fi
done

if [ -z "$admin_regex" ]; then
  echo >&2 "THOR_ADMIN_EMAILS must contain at least one email"
  exit 1
fi

export THOR_ADMIN_EMAILS_REGEX="$admin_regex"
