# Homelab K3s Cluster

## 🏠 Descripción General

Cluster Kubernetes K3s on-premise de 3 nodos control-plane (HA con etcd embebido) que corren como máquinas virtuales sobre un servidor TrueNAS SCALE, que además entrega el almacenamiento NFS/iSCSI. Todo lo desplegado se gestiona por GitOps con ArgoCD desde este repositorio.

![minirack](./minirack.png)
![nas](./nas.png)

## 📊 Especificaciones del Cluster

- **Distribución**: K3s v1.34 (Kubernetes 1.34), sin flannel, sin kube-proxy, sin traefik ni servicelb
- **Nodos**: 3 VMs KVM (control-plane + etcd + worker)
- **Capacidad asignada al cluster**: 24 vCPU, 72 GB RAM
- **Storage**: ZFS en TrueNAS (NFS y iSCSI vía democratic-csi)
- **Red**: 10GbE entre NAS y workstation, LAN 192.168.100.0/24

## 🖥️ Topología

### Host de virtualización y storage (NAS)

| Componente | Especificación |
|------------|---------------|
| **Plataforma** | TrueNAS SCALE 25.04 |
| **CPU** | Intel Xeon E5-2680 v4 (14C/28T @ 2.40GHz) |
| **RAM** | 128GB ECC |
| **Discos** | 12 SSD SATA: 8× 480GB en el pool `Storage` (2 vdevs RAIDZ1 de 4), 3× 480GB como pool dedicado por VM (`node001/2/3`), 1× 250GB `boot-pool`. Sin hot spares |
| **Storage** | Pool `Storage` 3.5TB (datos, NFS, iSCSI, S3) + un pool SSD dedicado por VM del cluster |
| **Controladora** | LSI 9300 12Gbps 16 ports |
| **Red** | 10GbE SFP+ (bridge `br0`) |
| **Función** | Hipervisor de las VMs del cluster + NFS/iSCSI + S3 (RustFS) para Loki |

### Nodos K3s (VMs en el NAS)

| Nodo | vCPU | RAM | Disco | IP | Rol |
|------|------|-----|-------|----|-----|
| **node001** | 8 | 24GB | zvol 120GB en pool `node001` (SSD propio) | 192.168.100.156 | control-plane, etcd (`cluster-init`), VIP preferente |
| **node002** | 8 | 24GB | zvol 120GB en pool `node002` (SSD propio) | 192.168.100.157 | control-plane, etcd |
| **node003** | 8 | 24GB | zvol 120GB en pool `node003` (SSD propio) | 192.168.100.158 | control-plane, etcd |

- API server en alta disponibilidad detrás de la VIP **192.168.100.5** (keepalived/VRRP, prioridades 120/110/100).
- Ubuntu 24.04 LTS, containerd, sin swap. Los tres nodos son control-plane + etcd: nunca más de uno fuera de servicio a la vez.
- En el mismo NAS corren además una VM `OpenClaw` (8 vCPU / 8GB) y contenedores Incus ajenos al cluster.

## 🌐 Arquitectura de Red

```
Internet (1 Gbps) ── Router ISP ── DMZ ──▶ 192.168.100.200 (Cilium Ingress, público)
                         │
                   Switch (2×10G + 4×2.5G)
                         ├── [10G SFP+] NAS TrueNAS 192.168.100.155 ── VMs node001/002/003
                         ├── [10G SFP+] Workstation Mac Studio
                         └── [1G]       Access Point WiFi 6
```

- **192.168.100.200**: LoadBalancer del ingress de Cilium (clase `cilium`, por defecto). Es la IP a la que el router hace DMZ: todo Ingress con esta clase queda **expuesto a internet** (argocd, grafana, immich, jellyfin).
- **192.168.100.210**: LoadBalancer de ingress-nginx (clase `nginx`). Solo red local (openclaw, registry, *arr, etc.).
- **192.168.100.200-250**: pool de IPs de Cilium LB-IPAM, anunciadas por L2.
- DNS en Cloudflare (`csepulveda.net`) gestionado por external-dns; `router.csepulveda.net` lo actualiza un CronJob de DDNS. Certificados Let's Encrypt por DNS01 con cert-manager.

## 💾 Storage

### Storage Classes

- **iscsi** (ReadWriteOnce, ext4): bases de datos y workloads con estado. Un zvol ZFS por volumen.
- **nfs** (ReadWriteMany): media, backups y volúmenes compartidos. Un dataset ZFS por volumen.
- **local-path** (default de K3s): solo pruebas.

### Respaldos

| Dato | Copia local | Copia fuera del NAS |
|------|-------------|---------------------|
| Datasets de Kubernetes (`Storage/k8s`, NFS + zvols iSCSI) | Snapshots ZFS recursivos: diario 02:00 (14 días) y semanal domingo 03:00 (8 semanas) | — |
| Fotos de Immich (PVC `immich-backup`, NFS) | Snapshots ZFS | Cloud Sync semanal a Amazon S3 (domingo 00:00) |
| Base de datos de Immich (CloudNativePG `immich-pg`) | Backup físico diario + WAL continuo al S3 del NAS (RustFS), ventana PITR de 7 días; dump lógico mensual al PVC `postgres-backup-pvc` (12 copias) | Cloud Sync semanal de los dumps a Amazon S3 (domingo 00:30) |
| etcd de K3s | Snapshot cada 12h en cada nodo (retención 14) | Mismos snapshots al bucket `k3s-etcd` del RustFS |
| Configuración de TrueNAS | Copia automática diaria en el `.system` dataset | Export manual (config + secret seed) tras cambios relevantes |

El S3 del NAS (RustFS, app de TrueNAS) protege contra fallos del cluster, no contra la pérdida del NAS; lo que debe sobrevivir a eso va a Amazon S3.

### Benchmarks (Agosto 2025 - Red 2.5/10GbE)

| Protocolo | Throughput Read | Throughput Write | IOPS Read | IOPS Write |
|-----------|-----------------|------------------|-----------|------------|
| **iSCSI (128K)** | 280 MB/s | 241 MB/s | 2240.64 | 1935.34 |
| **NFS Single (128K)** | 284 MB/s | 194 MB/s | 2241.98 | 1556.55 |
| **NFS Multi-client (128K)** | 358 MB/s | 131 MB/s | 2867.22 | 1056.09 |

## 🚀 Servicios Desplegados

### Infrastructure & DevOps
- **ArgoCD**: GitOps (un `ApplicationSet` convierte cada carpeta `namespace/app` en una Application)
- **Cert Manager**: certificados Let's Encrypt (DNS01 Cloudflare)
- **External DNS**: registros en Cloudflare a partir de Ingress/Services
- **GitHub Actions Runner (ARC)**: runner self-hosted que instala/actualiza ArgoCD en cada push
- **updatecli**: PRs automáticos con bumps de charts
- **Registry**: registro de contenedores privado

### Networking
- **Cilium**: CNI eBPF, kube-proxy replacement, LB-IPAM + L2 announcements, Ingress Controller (público)
- **NGINX Ingress Controller**: servicios internos

### Observability & Security
- **Prometheus + Alertmanager + Grafana** (kube-prometheus-stack), con exporters del NAS y de un medidor de energía ESPHome
- **Loki + Promtail**: logs (almacenamiento S3 en RustFS del NAS)
- **Trivy Operator**: escaneo de vulnerabilidades y configuración

### Storage & Data
- **Democratic CSI**: provisioner NFS e iSCSI contra la API de TrueNAS
- **Snapshot Controller**: VolumeSnapshots
- **CloudNativePG**: operador PostgreSQL

### Aplicaciones
- **Immich**: fotos (PostgreSQL con VectorChord vía CloudNativePG)
- **Jellyfin** + **Sonarr/Radarr/Jackett/qBittorrent**: multimedia
- **OpenClaw**: asistente por WhatsApp usando Ollama en la workstation

## 📁 Estructura del repositorio

```
<namespace>/<app>/
├── Chart.yaml        # chart wrapper con el chart upstream como dependencia (alias)
├── Chart.lock
├── charts/*.tgz      # dependencia vendorizada
├── values.yaml       # valores bajo la clave del alias
└── templates/        # manifiestos extra (ingress, PVC, CronJobs, ServiceMonitors)
```

- `argocd-ApplicationSet.yaml`: generador git `directories: '**/**'`; Application = nombre de la carpeta, namespace = primer segmento; sync automático con prune y selfHeal.
- `argocd-values.yaml`: valores del propio ArgoCD (instalado por el workflow `test-runner.yaml`).
- `*.tar.gz` en la raíz: apps retiradas (kafka, rook-ceph, stackgres, longhorn, gpu-operator), archivadas como referencia.
- Los secretos **no** están en el repo: se crean a mano y los charts los referencian por nombre.

## 💰 Análisis de Costos vs AWS

### Inversión Hardware Local
- **Hardware base**: $862 USD
- **Upgrade red 2.5/10GbE**: $135 USD
- **Total inversión**: $997 USD
- **Costo eléctrico mensual**: ~$36 USD (225W promedio)

### Comparación con AWS Equivalente

| Configuración | Costo Mensual | Costo Anual |
|---------------|---------------|-------------|
| **Hardware Local** | $36 | $432 + inversión inicial |
| **AWS On-Demand** | $983-1,406 | $11,796-16,872 |
| **AWS Reserved 1 año** | $590-844 | $7,080-10,128 |

## 🔧 Stack Tecnológico

- **Container Runtime**: containerd
- **CNI / LB / Ingress público**: Cilium
- **Ingress interno**: NGINX Ingress
- **Storage**: Democratic CSI (NFS/iSCSI sobre ZFS), RustFS (S3)
- **Databases**: CloudNativePG
- **Observability**: Prometheus, Grafana, Loki, Trivy
- **GitOps**: ArgoCD + GitHub + updatecli
