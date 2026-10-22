#!/bin/sh
# Secure-agent gateway — STANDALONE self-config (env-driven). Byte-equivalent to the rules
# backend/secure_net.py installs via `container exec`. SECURE_AGENT_DESIGN.md §8.6.
#
# Env contract:
#   KALI_SUBNET   inner --internal subnet, e.g. 192.168.96.0/24   (Kali side)
#   TARGET_IP     the ONE authorized target IP (single IPv4)
#   TARGET_PORTS  comma list, e.g. 80,443
#   OUTER_GW      gateway of the outer NAT net, e.g. 192.168.160.1 (the internet side)
#
# Forwards Kali -> TARGET_IP:TARGET_PORTS only; DROPs host/LAN/rest-of-internet by default.
set -eu

: "${KALI_SUBNET:?KALI_SUBNET required}"
: "${TARGET_IP:?TARGET_IP required}"
: "${TARGET_PORTS:?TARGET_PORTS required}"
: "${OUTER_GW:?OUTER_GW required}"

# Defense in depth: refuse an empty / wildcard / obviously-bad target (the backend already
# validates, but a gateway that self-configures must not open the firewall on bad input).
case "$TARGET_IP" in
  ""|"0.0.0.0"|"255.255.255.255"|*" "*|*";"*) echo "secure-gateway: refusing bad TARGET_IP=$TARGET_IP" >&2; exit 1 ;;
esac
echo "$TARGET_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || { echo "secure-gateway: TARGET_IP not IPv4: $TARGET_IP" >&2; exit 1; }

# Route the gateway's own traffic out the internet side (eth1).
ip route replace default via "$OUTER_GW" || true
echo 1 > /proc/sys/net/ipv4/ip_forward
for f in /proc/sys/net/ipv4/conf/*/rp_filter; do echo 0 > "$f" 2>/dev/null || true; done

iptables -P FORWARD DROP
iptables -A FORWARD -d "$TARGET_IP" -p tcp -m multiport --dports "$TARGET_PORTS" -j ACCEPT
iptables -A FORWARD -d "$TARGET_IP" -p udp -m multiport --dports "$TARGET_PORTS" -j ACCEPT
iptables -A FORWARD -d "$TARGET_IP" -p icmp -j ACCEPT
iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -t nat -A POSTROUTING -s "$KALI_SUBNET" ! -d "$KALI_SUBNET" -o eth1 -j MASQUERADE

echo "secure-gateway: clamped $KALI_SUBNET -> ${TARGET_IP}:${TARGET_PORTS} only (host/LAN/internet dropped)"
exec sleep infinity
