# Sizing server NMS
| Skala | Nodes | CPU | RAM | Storage |
|---|---|---|---|---|
| Kecil | < 50 | 2-4 core | 4-8 GB | 50-100 GB SSD |
| Menengah | 50-500 | 4-8 core | 8-16 GB | 200-500 GB SSD |
| Besar | > 500 | 8+ core | 32+ GB | 1 TB+ NVMe SSD |
Wajib SSD/NVMe: tulis time-series `metrics` tiap siklus poll.
Retensi default 30 hari (`poller.js`); turunkan interval/`POLL_MS` bila > 500 node atau pisah poller per segmen.
