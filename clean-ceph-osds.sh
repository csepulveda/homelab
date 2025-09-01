#!/bin/bash

echo "=== Cleaning Ceph OSDs to use ONLY iSCSI PVCs ==="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Step 1: Stopping all OSD prepare jobs${NC}"
kubectl -n rook-ceph delete jobs -l app=rook-ceph-osd-prepare --force --grace-period=0

echo -e "${YELLOW}Step 2: Deleting discovery daemon sets${NC}"
kubectl -n rook-ceph delete daemonset rook-discover --force --grace-period=0 2>/dev/null || echo "No discovery daemonset found"

echo -e "${YELLOW}Step 3: Remove all OSD prepare pods${NC}"
kubectl -n rook-ceph delete pods -l app=rook-ceph-osd-prepare --force --grace-period=0

echo -e "${YELLOW}Step 4: Scale down the operator temporarily${NC}"
kubectl -n rook-ceph scale deployment rook-ceph-operator --replicas=0

echo "Waiting for operator to stop..."
sleep 10

echo -e "${YELLOW}Step 5: Delete all existing OSDs (they will be recreated with PVCs only)${NC}"
# Get all OSD deployments
OSD_DEPLOYMENTS=$(kubectl -n rook-ceph get deployment -l app=rook-ceph-osd -o name)
for osd in $OSD_DEPLOYMENTS; do
    echo "Deleting $osd"
    kubectl -n rook-ceph delete $osd --force --grace-period=0
done

echo -e "${YELLOW}Step 6: Clean up any PVCs that are not iSCSI${NC}"
# List all Ceph OSD PVCs
kubectl -n rook-ceph get pvc -l app=rook-ceph-osd -o json | \
    jq -r '.items[] | select(.spec.storageClassName != "iscsi") | .metadata.name' | \
    while read pvc; do
        echo "Deleting non-iSCSI PVC: $pvc"
        kubectl -n rook-ceph delete pvc $pvc --force --grace-period=0
    done

echo -e "${YELLOW}Step 7: Scale operator back up${NC}"
kubectl -n rook-ceph scale deployment rook-ceph-operator --replicas=1

echo -e "${GREEN}Cleanup complete!${NC}"
echo ""
echo "The operator will now recreate OSDs using ONLY the iSCSI PVCs as configured."
echo "This will take a few minutes. Monitor with:"
echo "  kubectl -n rook-ceph get pods -w"
echo ""
echo "Expected result: 3 OSDs using 20GB iSCSI volumes on node01, mode02, and node03"