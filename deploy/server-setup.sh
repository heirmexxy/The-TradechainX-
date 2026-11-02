#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS (e.g. Hostinger KVM 2). Run as root:
#   curl -fsSL <raw url of this file> -o server-setup.sh && bash server-setup.sh <deploy-username> "<your SSH public key>"
# What it does: updates the OS, creates a non-root deploy user with your SSH key, turns off password
# and root SSH login, enables the firewall (22/80/443 only), fail2ban, automatic security updates,
# installs Docker + age + rclone, and adds 2 GB of swap.
set -euo pipefail
USER_NAME="${1:?usage: server-setup.sh <deploy-username> \"<ssh public key>\"}"
PUBKEY="${2:?pass your SSH public key in quotes}"

export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get -y upgrade
apt-get -y install ca-certificates curl git ufw fail2ban unattended-upgrades age rclone jq

# Deploy user with sudo and your key.
id "$USER_NAME" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$USER_NAME"
usermod -aG sudo "$USER_NAME"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.ssh"
echo "$PUBKEY" > "/home/$USER_NAME/.ssh/authorized_keys"
chown "$USER_NAME:$USER_NAME" "/home/$USER_NAME/.ssh/authorized_keys" && chmod 600 "/home/$USER_NAME/.ssh/authorized_keys"
echo "$USER_NAME ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$USER_NAME" && chmod 440 "/etc/sudoers.d/90-$USER_NAME"

# SSH: keys only, no root login.
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd

# Firewall.
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable

systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker (official repo).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker "$USER_NAME"

# Swap (helps the Next.js build on small plans).
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "Done. Log in as $USER_NAME (ssh $USER_NAME@<server-ip>) — root/password SSH is now disabled."
