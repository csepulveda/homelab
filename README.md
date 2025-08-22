# Homelab K3s Cluster

## 🏠 Descripción General

Cluster Kubernetes K3s on-premise con 4 nodos (3 master + 1 worker), optimizado para cargas de trabajo containerizadas y servicios multimedia.

![minirack](./minirack.png)
![nas](./nas.png)

## 📊 Especificaciones del Cluster

- **Distribución**: K3s v1.32+
- **Nodos Totales**: 4 (3 físicos + 1 virtual)
- **Capacidad Total**: 28 cores físicos (48 threads), 96GB RAM
- **Storage**: 3.2TB en ZFS (NAS TrueNAS)
- **Red**: Backbone 10GbE/2.5GbE

## 🖥️ Topología de Nodos

### Nodos Master (Control Plane)

| Nodo | Hardware | CPU | RAM | Storage | Red | IP |
|------|----------|-----|-----|---------|-----|-----|
| **node01** | ThinkCentre M715q | AMD Ryzen 3 PRO 2200GE (4C/4T) | 16GB | 232GB SSD | 2.5GbE | 192.168.1.150 |
| **node02** | ThinkCentre M715q | AMD Ryzen 3 PRO 2200GE (4C/4T) | 16GB | 232GB SSD | 1GbE* | 192.168.1.151 |
| **node03** | ThinkCentre M75q Gen 2 | AMD Ryzen 5 PRO 4650GE (6C/12T) | 32GB | 232GB SSD | 2.5GbE | 192.168.1.152 |

*Nota: node02 con tarjeta 2.5GbE defectuosa, operando a 1GbE

### Nodo Worker

| Nodo | Tipo | CPU | RAM | Storage | Host |
|------|------|-----|-----|---------|------|
| **vm01** | VM (TrueNAS) | Intel Xeon E5-2680 v4 | 8GB | 117GB | NAS Server |

### Storage Server (NAS)

| Componente | Especificación |
|------------|---------------|
| **Plataforma** | TrueNAS Scale |
| **CPU** | Intel Xeon E5-2680 v4 (14C/28T @ 2.40GHz) |
| **RAM** | 32GB ECC |
| **Storage** | 2x RAIDZ1 pools (8 discos + 2 hot spares) |
| **Capacidad** | 3.2TB total / 1.6TB disponible |
| **Controladora** | LSI 9300 12Gbps 16 ports |
| **Red** | 10GbE SFP+ |
| **Función** | NFS/iSCSI storage + VM host |

## 🌐 Arquitectura de Red

```
Internet (1 Gbps)
    ↓
Router ISP
    ↓
Access Point WiFi 6 (1 Gbps)
    ↓
Switch Principal (2×10G + 4×2.5G + 2×1G)
    ├── [10G SFP+] → NAS TrueNAS
    ├── [10G] → Workstation Mac
    ├── [2.5G] → node01
    ├── [2.5G] → node03
    ├── [1G] → node02
    └── [2.5G] → Access Point
```

### Distribución de Ancho de Banda

- **Backbone Principal**: Mac ↔ NAS @ 10 Gbps
- **Nodos K3s**: 2.5/1 Gbps hacia NAS
- **Internet/WAN**: 1 Gbps simétrico
- **WiFi 6**: Hasta 1.2 Gbps

## 💾 Storage Performance

### Benchmarks Actualizados (Agosto 2025 - Red 2.5/10GbE)

| Protocolo | Throughput Read | Throughput Write | IOPS Read | IOPS Write |
|-----------|-----------------|------------------|-----------|------------|
| **iSCSI (128K)** | 280 MB/s | 179 MB/s | 2,238 | 1,430 |
| **NFS Single (128K)** | 280 MB/s | 75-85 MB/s | 2,239 | 600-684 |
| **NFS Multi-client (128K)** | 320-322 MB/s | 26-49 MB/s | 2,563-2,574 | 211-397 |

### Storage Classes Disponibles

- **NFS** (ReadWriteMany): Para workloads compartidos
- **iSCSI** (ReadWriteOnce): Para bases de datos y alta performance
- **Longhorn** (ReadWriteOnce): Para replicación distribuida

## 🚀 Servicios Desplegados

### Infrastructure & DevOps
- **ArgoCD**: GitOps continuous deployment
- **Cert Manager**: Gestión automática de certificados SSL
- **GitHub Actions Runner**: CI/CD self-hosted
- **ACK Controllers**: AWS resource management
- **AWS Controllers for K8s**: AWS service operators
- **KRO (Kube Resource Orchestrator)**: Custom resource orchestration
- **NVIDIA GPU Operator**: GPU workload support

### Networking & Ingress
- **NGINX Ingress Controller**: Internal services ingress
- **Traefik**: External ingress controller
- **Cilium**: eBPF-based CNI with network policies

### Observability & Monitoring
- **Prometheus**: Metrics collection and alerting
- **Grafana**: Visualization and dashboards
- **Loki**: Log aggregation and querying
- **Trivy Operator**: Vulnerability scanning for containers

### Storage & Data
- **MinIO**: S3-compatible object storage
- **StackGres**: PostgreSQL operator for HA databases
- **Longhorn**: Distributed block storage
- **Democratic CSI**: NFS/iSCSI provisioner

### Stack Multimedia
- **Immich**: Google Photos self-hosted (backup de fotos)
- **Jellyfin**: Media streaming server
- **Sonarr/Radarr/Lidarr**: Media management
- **Prowlarr/Jackett**: Indexer management
- **qBittorrent**: Download client

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

**ROI**: Recuperación de inversión en menos de 1 mes vs AWS On-Demand

## 🎯 Ventajas del Setup Local

- ✅ **10-12x más económico** que AWS en el primer año
- ✅ **27-39x más económico** a partir del segundo año
- ✅ Latencia ultra-baja (<1ms local vs 5-20ms cloud)
- ✅ Sin límites de transferencia de datos
- ✅ Control total del hardware y datos
- ✅ Performance superior (280-322 MB/s throughput, 37K+ IOPS)

## 📈 Métricas de Performance

- **Latencia de red**: <1ms entre nodos
- **Throughput máximo**: 322 MB/s (NFS multi-client)
- **IOPS máximo**: 37,290 (iSCSI 4K sequential writes)
- **Disponibilidad**: 99.9% (últimos 6 meses)
- **Consumo energético**: 200-250W total del cluster

## 🔧 Stack Tecnológico

- **Container Runtime**: containerd
- **CNI**: Cilium (eBPF-based networking)
- **Ingress Controllers**: 
  - NGINX Ingress (internal services)
  - Cilium Envoy (external services with L7 load balancing)
- **Storage**: 
  - NFS-subdir-external-provisioner
  - Democratic CSI (NFS/iSCSI)
  - Longhorn (distributed storage)
  - MinIO (object storage)
- **Databases**: StackGres (PostgreSQL operator)
- **Observability Stack**:
  - Prometheus (metrics)
  - Grafana (visualization)
  - Loki (logs)
  - Trivy (security scanning)
- **GitOps**: ArgoCD + GitHub
- **Cloud Integration**: 
  - ACK Controllers
  - AWS Operators
  - KRO (Kube Resource Orchestrator)
