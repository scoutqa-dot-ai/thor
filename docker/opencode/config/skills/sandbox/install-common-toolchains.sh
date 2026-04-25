#!/usr/bin/env bash

set -euo pipefail

TARGET="${1:-}"
VERSION="${2:-}"

usage() {
	cat <<'USAGE'
Usage:
  install-common-toolchains.sh node <version>
  install-common-toolchains.sh python <version>
  install-common-toolchains.sh go 1.25.8
  install-common-toolchains.sh rust [channel]
  install-common-toolchains.sh iac

Runs from the Thor/opencode environment and installs less-common toolchains
into the current worktree's sandbox via the `sandbox` wrapper.
USAGE
}

if [[ -z "$TARGET" ]]; then
	usage
	exit 1
fi

run_in_sandbox() {
	local script="$1"
	sandbox bash -lc "$script"
}

require_version() {
	local label="$1"
	local value="$2"
	local pattern="$3"
	if [[ ! "$value" =~ $pattern ]]; then
		echo "invalid ${label}: ${value}" >&2
		exit 1
	fi
}

install_node() {
	local node_version="$1"
	require_version "node version" "$node_version" '^[0-9]+([.][0-9]+){0,2}$'
	run_in_sandbox "source ~/.nvm/nvm.sh && nvm install ${node_version}"
}

install_python() {
	local py_version="$1"
	require_version "python version" "$py_version" '^[0-9]+([.][0-9]+){1,2}$'
	run_in_sandbox "export PYENV_ROOT=\"\$HOME/.pyenv\" && export PATH=\"\$PYENV_ROOT/bin:\$PYENV_ROOT/shims:\$PATH\" && eval \"\$(pyenv init -)\" && pyenv install -s ${py_version}"
}

install_go() {
	local go_version="$1"
	require_version "go version" "$go_version" '^[0-9]+([.][0-9]+){1,2}$'
	run_in_sandbox "mkdir -p \"\$HOME/.local/go\" \"\$HOME/.local/bin\" && if [[ ! -x \"\$HOME/.local/go/${go_version}/bin/go\" ]]; then tmp_dir=\"\$(mktemp -d)\" && curl -fsSL \"https://go.dev/dl/go${go_version}.linux-amd64.tar.gz\" -o \"\$tmp_dir/go.tgz\" && mkdir -p \"\$HOME/.local/go/${go_version}\" && tar -xzf \"\$tmp_dir/go.tgz\" --strip-components=1 -C \"\$HOME/.local/go/${go_version}\" && rm -rf \"\$tmp_dir\"; fi && ln -sf \"\$HOME/.local/go/${go_version}/bin/go\" \"\$HOME/.local/bin/go\" && ln -sf \"\$HOME/.local/go/${go_version}/bin/gofmt\" \"\$HOME/.local/bin/gofmt\""
}

install_rust() {
	local rust_channel="$1"
	require_version "rust channel" "$rust_channel" '^[A-Za-z0-9._-]+$'
	run_in_sandbox "if [[ ! -x \"\$HOME/.cargo/bin/rustup\" ]]; then curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal; fi && . \"\$HOME/.cargo/env\" && rustup toolchain install ${rust_channel} && rustup default ${rust_channel}"
}

install_iac() {
	run_in_sandbox 'terraform_version="1.10.4" && terragrunt_version="0.99.4" && sops_version="3.9.4" && mkdir -p "$HOME/.local/bin" "$HOME/.local/aws-cli" && tmp_dir="$(mktemp -d)" && curl -fsSL "https://releases.hashicorp.com/terraform/${terraform_version}/terraform_${terraform_version}_linux_amd64.zip" -o "$tmp_dir/terraform.zip" && unzip -oq "$tmp_dir/terraform.zip" -d "$tmp_dir" && install -m 0755 "$tmp_dir/terraform" "$HOME/.local/bin/terraform" && curl -fsSL "https://github.com/gruntwork-io/terragrunt/releases/download/v${terragrunt_version}/terragrunt_linux_amd64" -o "$tmp_dir/terragrunt" && install -m 0755 "$tmp_dir/terragrunt" "$HOME/.local/bin/terragrunt" && curl -fsSL "https://github.com/getsops/sops/releases/download/v${sops_version}/sops-v${sops_version}.linux.amd64" -o "$tmp_dir/sops" && install -m 0755 "$tmp_dir/sops" "$HOME/.local/bin/sops" && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "$tmp_dir/awscliv2.zip" && rm -rf "$tmp_dir/aws" && unzip -oq "$tmp_dir/awscliv2.zip" -d "$tmp_dir" && "$tmp_dir/aws/install" -i "$HOME/.local/aws-cli" -b "$HOME/.local/bin" --update && rm -rf "$tmp_dir"'
}

case "$TARGET" in
node)
	if [[ -z "$VERSION" ]]; then
		echo "node target requires a version (example: node 19)" >&2
		exit 1
	fi
	install_node "$VERSION"
	;;
python)
	if [[ -z "$VERSION" ]]; then
		echo "python target requires a version (example: python 3.11)" >&2
		exit 1
	fi
	install_python "$VERSION"
	;;
go)
	if [[ -z "$VERSION" ]]; then
		echo "go target requires a version (example: go 1.25.8)" >&2
		exit 1
	fi
	install_go "$VERSION"
	;;
rust)
	install_rust "${VERSION:-stable}"
	;;
iac)
	install_iac
	;;
*)
	usage
	echo "unknown target: $TARGET" >&2
	exit 1
	;;
esac
