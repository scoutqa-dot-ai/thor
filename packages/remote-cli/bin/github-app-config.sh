#!/bin/sh

thor_has_github_app_config() {
  config_path="$1"
  [ -f "$config_path" ] && grep -q '"github_app_installation_id"' "$config_path" 2>/dev/null
}
