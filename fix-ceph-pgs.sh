#!/bin/bash

echo "=== Optimizing Ceph PG Count ==="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Step 1: Checking current pools and PG counts${NC}"

# Get into a mon or mgr pod to run ceph commands
MON_POD=$(kubectl -n rook-ceph get pod -l app=rook-ceph-mon -o name | head -1 | cut -d'/' -f2)

if [ -z "$MON_POD" ]; then
    echo -e "${RED}Error: No mon pod found${NC}"
    exit 1
fi

echo "Using mon pod: $MON_POD"

# Function to execute ceph command
ceph_cmd() {
    kubectl -n rook-ceph exec $MON_POD -- ceph "$@"
}

echo -e "${YELLOW}Step 2: Current pool status${NC}"
ceph_cmd osd pool ls detail | grep -E "pool|pg_num"

echo -e "${YELLOW}Step 3: Setting optimal PG counts for 3 OSDs${NC}"
echo "For 3 OSDs with replica 3, optimal PG count is 32 per pool (total ~100-150 PGs)"

# Get list of pools
POOLS=$(ceph_cmd osd pool ls 2>/dev/null | grep -v "^$")

for POOL in $POOLS; do
    echo -e "${GREEN}Processing pool: $POOL${NC}"
    
    # Check current PG count
    CURRENT_PG=$(ceph_cmd osd pool get $POOL pg_num 2>/dev/null | awk '{print $2}')
    echo "  Current pg_num: $CURRENT_PG"
    
    # Determine new PG count based on pool type
    case $POOL in
        *".rgw."*)
            # RGW pools can be smaller
            NEW_PG=8
            ;;
        *"blockpool"*|*"data"*)
            # Data pools need more PGs
            NEW_PG=32
            ;;
        *"metadata"*|*"control"*|*"log"*)
            # Metadata pools can be smaller
            NEW_PG=16
            ;;
        *)
            # Default
            NEW_PG=16
            ;;
    esac
    
    echo "  Setting pg_num to: $NEW_PG"
    
    # Set pg_num and pgp_num
    ceph_cmd osd pool set $POOL pg_num $NEW_PG 2>/dev/null || echo "  Failed to set pg_num"
    sleep 2
    ceph_cmd osd pool set $POOL pgp_num $NEW_PG 2>/dev/null || echo "  Failed to set pgp_num"
    
    # Also set pg_num_min to prevent autoscaling from increasing it
    ceph_cmd osd pool set $POOL pg_num_min $NEW_PG 2>/dev/null
    
    # Disable autoscaling for this pool
    ceph_cmd osd pool set $POOL pg_autoscale_mode off 2>/dev/null || echo "  Autoscale already off"
    
    echo "  Done with $POOL"
    echo ""
done

echo -e "${YELLOW}Step 4: Final status${NC}"
ceph_cmd status
echo ""
ceph_cmd osd pool ls detail | grep -E "pool|pg_num" | head -20

echo -e "${GREEN}=== PG Optimization Complete ===${NC}"
echo ""
echo "Note: It may take a few minutes for PGs to rebalance."
echo "Monitor with: kubectl -n rook-ceph exec $MON_POD -- ceph status"