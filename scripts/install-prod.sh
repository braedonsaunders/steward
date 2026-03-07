#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

export HOMEBREW_NO_AUTO_UPDATE=1

log() {
  echo "$1"
}

fail() {
  echo "$1" >&2
  exit 1
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  if have_command sudo; then
    sudo "$@"
    return
  fi

  fail "Administrative privileges are required to install production prerequisites."
}

node_is_supported() {
  if ! have_command node; then
    return 1
  fi

  node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit((major > 20 || (major === 20 && minor >= 9)) ? 0 : 1)"
}

npm_dependencies_installed() {
  if [ ! -d "node_modules" ]; then
    return 1
  fi

  npm ls --depth=0 --silent >/dev/null 2>&1
}

refresh_homebrew_env() {
  if [ -x "/opt/homebrew/bin/brew" ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    return
  fi

  if [ -x "/usr/local/bin/brew" ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

ensure_homebrew() {
  if have_command brew; then
    refresh_homebrew_env
    return
  fi

  if ! have_command curl; then
    fail "curl is required to install Homebrew on macOS."
  fi

  log "Installing Homebrew..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  refresh_homebrew_env

  if ! have_command brew; then
    fail "Homebrew installation completed but brew is still unavailable in PATH."
  fi
}

ensure_macos_node() {
  if node_is_supported; then
    return
  fi

  ensure_homebrew
  log "Installing Node.js via Homebrew..."
  brew install node
  refresh_homebrew_env

  if ! node_is_supported; then
    fail "Node.js 20.9+ is required, but a supported version is still unavailable."
  fi
}

ensure_macos_powershell() {
  if have_command pwsh; then
    return
  fi

  ensure_homebrew
  log "Installing PowerShell via Homebrew..."
  brew install powershell
  refresh_homebrew_env

  if ! have_command pwsh; then
    fail "PowerShell installation completed but pwsh is still unavailable in PATH."
  fi
}

detect_linux_package_manager() {
  if have_command apt-get; then
    echo "apt"
    return
  fi

  if have_command dnf; then
    echo "dnf"
    return
  fi

  if have_command yum; then
    echo "yum"
    return
  fi

  if have_command pacman; then
    echo "pacman"
    return
  fi

  if have_command apk; then
    echo "apk"
    return
  fi

  fail "Unsupported Linux package manager. Supported: apt, dnf, yum, pacman, apk."
}

load_os_release() {
  if [ ! -r /etc/os-release ]; then
    fail "Unable to read /etc/os-release to determine Linux distribution."
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
}

ensure_apt_node() {
  if node_is_supported; then
    return
  fi

  log "Installing Node.js 22 on Linux via NodeSource..."
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates gnupg
  if [ ! -f /usr/share/keyrings/nodesource.gpg ]; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | run_root gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  fi
  cat <<'EOF' | run_root tee /etc/apt/sources.list.d/nodesource.list >/dev/null
deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main
EOF
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs

  if ! node_is_supported; then
    fail "Node.js 20.9+ is required, but a supported version is still unavailable."
  fi
}

ensure_apt_powershell() {
  if have_command pwsh; then
    return
  fi

  load_os_release
  case "${ID:-}" in
    ubuntu|debian)
      ;;
    *)
      fail "Automatic PowerShell installation is currently supported on apt-based Debian and Ubuntu hosts."
      ;;
  esac

  log "Installing PowerShell on Linux via Microsoft's apt repository..."
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates gnupg

  local repo_pkg
  repo_pkg="$(mktemp /tmp/packages-microsoft-prod.XXXXXX.deb)"
  curl -fsSL "https://packages.microsoft.com/config/${ID}/${VERSION_ID}/packages-microsoft-prod.deb" -o "$repo_pkg"
  run_root dpkg -i "$repo_pkg"
  rm -f "$repo_pkg"

  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y powershell

  if ! have_command pwsh; then
    fail "PowerShell installation completed but pwsh is still unavailable in PATH."
  fi
}

ensure_rpm_node() {
  local package_manager="$1"

  if node_is_supported; then
    return
  fi

  log "Installing Node.js 22 on Linux via NodeSource..."
  run_root "$package_manager" install -y curl ca-certificates
  curl -fsSL https://rpm.nodesource.com/setup_22.x | run_root bash -
  run_root "$package_manager" install -y nodejs

  if ! node_is_supported; then
    fail "Node.js 20.9+ is required, but a supported version is still unavailable."
  fi
}

ensure_rpm_powershell() {
  local package_manager="$1"

  if have_command pwsh; then
    return
  fi

  load_os_release

  local repo_url=""
  case "${ID:-}" in
    fedora)
      repo_url="https://packages.microsoft.com/config/fedora/${VERSION_ID%%.*}/packages-microsoft-prod.rpm"
      ;;
    rhel|centos|rocky|almalinux|ol)
      repo_url="https://packages.microsoft.com/config/rhel/${VERSION_ID%%.*}/packages-microsoft-prod.rpm"
      ;;
    *)
      if [[ "${ID_LIKE:-}" == *rhel* ]] || [[ "${ID_LIKE:-}" == *fedora* ]]; then
        repo_url="https://packages.microsoft.com/config/rhel/${VERSION_ID%%.*}/packages-microsoft-prod.rpm"
      else
        fail "Automatic PowerShell installation is currently supported on Fedora and RHEL-compatible hosts."
      fi
      ;;
  esac

  log "Installing PowerShell on Linux via Microsoft's rpm repository..."
  run_root "$package_manager" install -y curl ca-certificates

  local repo_pkg
  repo_pkg="$(mktemp /tmp/packages-microsoft-prod.XXXXXX.rpm)"
  curl -fsSL "$repo_url" -o "$repo_pkg"
  run_root rpm -Uvh --quiet "$repo_pkg"
  rm -f "$repo_pkg"

  run_root "$package_manager" install -y powershell

  if ! have_command pwsh; then
    fail "PowerShell installation completed but pwsh is still unavailable in PATH."
  fi
}

ensure_pacman_node() {
  if node_is_supported; then
    return
  fi

  log "Installing Node.js on Linux via pacman..."
  run_root pacman -Sy --noconfirm nodejs npm

  if ! node_is_supported; then
    fail "Node.js 20.9+ is required, but a supported version is still unavailable."
  fi
}

ensure_pacman_powershell() {
  if have_command pwsh; then
    return
  fi

  log "Installing PowerShell on Linux via pacman..."
  run_root pacman -Sy --noconfirm powershell

  if ! have_command pwsh; then
    fail "PowerShell installation completed but pwsh is still unavailable in PATH."
  fi
}

ensure_apk_node() {
  if node_is_supported; then
    return
  fi

  log "Installing Node.js on Linux via apk..."
  run_root apk add --no-cache nodejs npm

  if ! node_is_supported; then
    fail "Node.js 20.9+ is required, but a supported version is still unavailable."
  fi
}

ensure_apk_powershell() {
  if have_command pwsh; then
    return
  fi

  log "Installing PowerShell on Linux via apk..."
  run_root apk add --no-cache powershell

  if ! have_command pwsh; then
    fail "PowerShell installation completed but pwsh is still unavailable in PATH."
  fi
}

ensure_linux_prereqs() {
  local package_manager
  package_manager="$(detect_linux_package_manager)"

  case "$package_manager" in
    apt)
      ensure_apt_node
      ensure_apt_powershell
      ;;
    dnf|yum)
      ensure_rpm_node "$package_manager"
      ensure_rpm_powershell "$package_manager"
      ;;
    pacman)
      ensure_pacman_node
      ensure_pacman_powershell
      ;;
    apk)
      ensure_apk_node
      ensure_apk_powershell
      ;;
  esac
}

main() {
  case "$(uname -s)" in
    Darwin)
      ensure_macos_node
      ensure_macos_powershell
      ;;
    Linux)
      ensure_linux_prereqs
      ;;
    *)
      fail "scripts/install-prod.sh only supports macOS and Linux."
      ;;
  esac

  if ! npm_dependencies_installed; then
    log "Installing npm dependencies..."
    npm ci
  else
    log "npm dependencies already installed."
  fi

  log "Ensuring PowerShell runtime..."
  if have_command pwsh; then
    echo "PowerShell runtime already installed."
  else
    fail "PowerShell installation was expected to complete, but pwsh is still unavailable."
  fi

  log "Ensuring required network tools (nmap, tshark, snmpget, snmpwalk)..."
  node scripts/ensure-network-tools.mjs

  log "Ensuring Playwright runtime..."
  node scripts/ensure-playwright.mjs
}

main "$@"
