# Pengerasan keamanan
1. HTTPS: jalankan di belakang reverse-proxy (nginx/Caddy) dengan TLS; jangan expose HTTP langsung.
2. SNMP: gunakan v3 (authPriv) — isi `snmp_version=v3` + `snmp_user`; v2c community hanya untuk lab.
3. Secret: set `JWT_SECRET` kuat di produksi; rotate token (exp 12 jam).
4. Jaringan: tempatkan server NMS di VLAN manajemen di belakang firewall; batasi UDP syslog 5514 hanya dari perangkat.
5. RBAC: admin (penuh), operator (operasional, tanpa kelola user), viewer (read-only) — sudah dienforce di API + UI.
