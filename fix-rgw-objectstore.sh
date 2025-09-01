#!/bin/bash

echo "=== Fixing Ceph RGW Object Storage ==="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Step 1: Cleaning up existing broken resources${NC}"

# Delete the broken user
echo "Deleting broken CephObjectStoreUser..."
kubectl -n rook-ceph delete cephobjectstoreuser loki-user --wait=false 2>/dev/null

# Delete the ObjectBucketClaim
echo "Deleting ObjectBucketClaim..."
kubectl -n monitoring delete objectbucketclaim loki-bucket --wait=false 2>/dev/null

# Wait for cleanup
echo "Waiting for cleanup..."
sleep 15

echo -e "${YELLOW}Step 2: Restarting RGW pods to ensure clean state${NC}"
kubectl -n rook-ceph rollout restart deployment/rook-ceph-rgw-ceph-objectstore-a
kubectl -n rook-ceph rollout status deployment/rook-ceph-rgw-ceph-objectstore-a --timeout=120s

echo -e "${YELLOW}Step 3: Verify RGW is healthy${NC}"
sleep 10

# Check if RGW is responding
RGW_SVC="rook-ceph-rgw-ceph-objectstore.rook-ceph.svc.cluster.local"
echo "Testing RGW connectivity..."
kubectl run test-rgw --image=curlimages/curl:latest --rm -it --restart=Never -- \
    curl -s -o /dev/null -w "%{http_code}" http://${RGW_SVC}:80 2>/dev/null || true

echo -e "${YELLOW}Step 4: Create admin user for RGW${NC}"
cat <<EOF | kubectl apply -f -
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: rgw-admin-ops-user
  namespace: rook-ceph
spec:
  store: ceph-objectstore
  displayName: "RGW Admin Ops User"
  capabilities:
    user: "*"
    bucket: "*"
    metadata: "*"
    usage: "*"
    zone: "*"
EOF

echo "Waiting for admin user creation..."
sleep 20

echo -e "${YELLOW}Step 5: Check if admin user was created${NC}"
kubectl -n rook-ceph get cephobjectstoreuser rgw-admin-ops-user

echo -e "${YELLOW}Step 6: Create the StorageClass if it doesn't exist${NC}"
kubectl get storageclass rook-ceph-bucket &>/dev/null || cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-bucket
provisioner: rook-ceph.ceph.rook.io/bucket
reclaimPolicy: Delete
parameters:
  objectStoreName: ceph-objectstore
  objectStoreNamespace: rook-ceph
EOF

echo -e "${YELLOW}Step 7: Create ObjectBucketClaim for Loki${NC}"
cat <<EOF | kubectl apply -f -
apiVersion: objectbucket.io/v1alpha1
kind: ObjectBucketClaim
metadata:
  name: loki-bucket
  namespace: monitoring
spec:
  generateBucketName: loki-bucket
  storageClassName: rook-ceph-bucket
EOF

echo -e "${YELLOW}Step 8: Wait for bucket to be created${NC}"
for i in {1..30}; do
    PHASE=$(kubectl -n monitoring get objectbucketclaim loki-bucket -o jsonpath='{.status.phase}' 2>/dev/null)
    if [ "$PHASE" == "Bound" ]; then
        echo -e "${GREEN}Bucket successfully created!${NC}"
        break
    fi
    echo "Waiting for bucket... ($i/30)"
    sleep 5
done

echo -e "${YELLOW}Step 9: Verify final status${NC}"
echo "ObjectBucketClaim status:"
kubectl -n monitoring get objectbucketclaim loki-bucket

echo ""
echo "Secret created:"
kubectl -n monitoring get secret loki-bucket

echo ""
echo "ConfigMap created:"
kubectl -n monitoring get configmap loki-bucket

echo ""
echo -e "${GREEN}=== Fix complete ===${NC}"
echo ""
echo "If the bucket is still not created, check:"
echo "1. Operator logs: kubectl -n rook-ceph logs deployment/rook-ceph-operator | grep -i bucket"
echo "2. RGW logs: kubectl -n rook-ceph logs -l app=rook-ceph-rgw --tail=50"
echo "3. Ceph health: kubectl -n rook-ceph get cephcluster"