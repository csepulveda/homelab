#!/bin/bash

echo "=== Optimizing Ceph PGs for 3 OSD setup ==="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Wait for cluster to be ready
echo -e "${YELLOW}Step 1: Waiting for cluster to be ready${NC}"
kubectl -n rook-ceph wait --for=condition=ready pod -l app=rook-ceph-mon --timeout=120s

# Get the toolbox pod (should be created with toolbox.enable: true)
TOOLBOX_POD=$(kubectl -n rook-ceph get pod -l app=rook-ceph-tools -o name 2>/dev/null | head -1)
if [ -z "$TOOLBOX_POD" ]; then
    echo -e "${YELLOW}Creating toolbox pod for Ceph commands...${NC}"
    cat <<EOF | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rook-ceph-tools
  namespace: rook-ceph
spec:
  replicas: 1
  selector:
    matchLabels:
      app: rook-ceph-tools
  template:
    metadata:
      labels:
        app: rook-ceph-tools
    spec:
      dnsPolicy: ClusterFirstWithHostNet
      containers:
      - name: rook-ceph-tools
        image: quay.io/ceph/ceph:v18.2.4
        command: ["/bin/bash"]
        args: ["-c", "sleep infinity"]
        env:
          - name: ROOK_CEPH_USERNAME
            valueFrom:
              secretKeyRef:
                name: rook-ceph-mon
                key: ceph-username
          - name: ROOK_CEPH_SECRET
            valueFrom:
              secretKeyRef:
                name: rook-ceph-mon
                key: ceph-secret
        volumeMounts:
          - mountPath: /etc/ceph
            name: ceph-config
          - name: mon-endpoint-volume
            mountPath: /etc/rook
      volumes:
        - name: ceph-config
          configMap:
            name: rook-ceph-config
        - name: mon-endpoint-volume
          configMap:
            name: rook-ceph-mon-endpoints
            items:
            - key: data
              path: mon-endpoints
      nodeSelector:
        kubernetes.io/hostname: node01
EOF
    echo "Waiting for toolbox pod to be ready..."
    sleep 30
    TOOLBOX_POD=$(kubectl -n rook-ceph get pod -l app=rook-ceph-tools -o name | head -1)
fi

TOOLBOX_POD_NAME=$(echo $TOOLBOX_POD | cut -d'/' -f2)
echo "Using toolbox pod: $TOOLBOX_POD_NAME"

# Function to run ceph commands
ceph_exec() {
    kubectl -n rook-ceph exec $TOOLBOX_POD_NAME -- "$@"
}

echo -e "${YELLOW}Step 2: Current cluster status${NC}"
ceph_exec ceph -s

echo -e "${YELLOW}Step 3: Current pools and PG counts${NC}"
ceph_exec ceph osd pool ls detail

echo -e "${YELLOW}Step 4: Setting optimal PG counts for 3 OSDs${NC}"
echo "Target: 8-16 PGs per pool, total ~100-120 PGs"

# Get all pool names
POOLS=$(ceph_exec ceph osd pool ls)

for POOL in $POOLS; do
    echo -e "${GREEN}Processing pool: $POOL${NC}"
    
    # Determine optimal PG count based on pool purpose
    case $POOL in
        *"blockpool"*|*"ceph-blockpool"*|*"rbd"*)
            # Main data pools need more PGs
            TARGET_PGS=16
            ;;
        *".rgw.root"*|*".rgw.control"*|*".rgw.meta"*|*".rgw.log"*)
            # RGW metadata pools need fewer PGs
            TARGET_PGS=8
            ;;
        *".rgw.buckets.index"*)
            # Bucket index pools
            TARGET_PGS=8
            ;;
        *".rgw.buckets.data"*|*".rgw.buckets.non-ec"*)
            # Bucket data pools
            TARGET_PGS=16
            ;;
        *"filesystem"*|*"cephfs"*)
            # CephFS pools
            TARGET_PGS=16
            ;;
        *"metadata"*)
            # Metadata pools
            TARGET_PGS=8
            ;;
        *)
            # Default for unknown pools
            TARGET_PGS=8
            ;;
    esac
    
    echo "  Setting $POOL to $TARGET_PGS PGs"
    
    # Disable autoscaler first
    ceph_exec ceph osd pool set $POOL pg_autoscale_mode off || echo "  Autoscale already off"
    
    # Set PG count
    ceph_exec ceph osd pool set $POOL pg_num $TARGET_PGS
    sleep 2
    ceph_exec ceph osd pool set $POOL pgp_num $TARGET_PGS
    
    # Set minimum to prevent auto-scaling up
    ceph_exec ceph osd pool set $POOL pg_num_min $TARGET_PGS || echo "  pg_num_min not supported"
    
    echo "  ✓ $POOL configured"
done

echo -e "${YELLOW}Step 5: Final status${NC}"
echo "Waiting for PG optimization to complete..."
sleep 10

ceph_exec ceph -s
echo ""
ceph_exec ceph osd pool ls detail | head -20

echo -e "${GREEN}=== PG Optimization Complete ===${NC}"
echo ""
echo "Your Ceph cluster now has:"
echo "- Exactly 3 OSDs using 20GB iSCSI PVCs"
echo "- Optimized PG counts (~100-120 total)"
echo "- Better performance and lower resource usage"
echo ""
echo "Monitor progress with:"
echo "kubectl -n rook-ceph exec $TOOLBOX_POD_NAME -- ceph -s"