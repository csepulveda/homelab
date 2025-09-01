#!/bin/bash

echo "=== Reducir PGs en Ceph - Método Simple ==="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Este script te mostrará los comandos exactos para reducir PGs${NC}"
echo ""

# Check if toolbox exists
TOOLBOX_POD=$(kubectl -n rook-ceph get pod -l app=rook-ceph-tools -o name 2>/dev/null | head -1)
if [ -z "$TOOLBOX_POD" ]; then
    echo -e "${RED}Error: No toolbox pod found${NC}"
    echo "Ejecuta primero: kubectl apply -f - << EOF"
    cat << 'EOL'
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
      containers:
      - name: rook-ceph-tools
        image: quay.io/ceph/ceph:v18.2.4
        command: ["/bin/bash", "-c", "sleep infinity"]
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
    exit 1
fi

POD_NAME=$(echo $TOOLBOX_POD | cut -d'/' -f2)
echo -e "${GREEN}Usando toolbox pod: $POD_NAME${NC}"
echo ""

echo -e "${YELLOW}Paso 1: Ver pools actuales y sus PGs${NC}"
echo "Ejecuta este comando:"
echo -e "${GREEN}kubectl -n rook-ceph exec -it $POD_NAME -- ceph osd pool ls detail${NC}"
echo ""

echo -e "${YELLOW}Paso 2: Reducir PGs para cada pool${NC}"
echo "Para cada pool que veas, ejecuta estos comandos (ajusta el número según el pool):"
echo ""

echo -e "${GREEN}# Para pools principales (como blockpool):${NC}"
echo "kubectl -n rook-ceph exec -it $POD_NAME -- ceph osd pool set NOMBRE_POOL pg_num 16"
echo "kubectl -n rook-ceph exec -it $POD_NAME -- ceph osd pool set NOMBRE_POOL pgp_num 16"
echo ""

echo -e "${GREEN}# Para pools pequeños (como .rgw.root):${NC}"
echo "kubectl -n rook-ceph exec -it $POD_NAME -- ceph osd pool set NOMBRE_POOL pg_num 8" 
echo "kubectl -n rook-ceph exec -it $POD_NAME -- ceph osd pool set NOMBRE_POOL pgp_num 8"
echo ""

echo -e "${GREEN}# Para desactivar auto-scaling:${NC}"
echo "kubectl -n rook-ceph exec -it $POD_NAME -- ceph osd pool set NOMBRE_POOL pg_autoscale_mode off"
echo ""

echo -e "${YELLOW}Paso 3: Verificar el resultado${NC}"
echo "kubectl -n rook-ceph exec -it $POD_NAME -- ceph -s"
echo ""

echo -e "${YELLOW}Ejemplo completo:${NC}"
echo -e "${GREEN}# Si tienes un pool llamado 'ceph-blockpool' con 64 PGs:${NC}"
echo "kubectl -n rook-ceph exec -it $POD_NAME -- ceph osd pool set ceph-blockpool pg_autoscale_mode off"
echo "kubectl -n rook-ceph exec -it $POD_NAME -- ceph osd pool set ceph-blockpool pg_num 16"
echo "kubectl -n rook-ceph exec -it $POD_NAME -- ceph osd pool set ceph-blockpool pgp_num 16"
echo ""

echo -e "${RED}IMPORTANTE: Reduce los PGs gradualmente y espera entre cambios${NC}"
echo "El objetivo es tener entre 64-128 PGs TOTAL para tu cluster de 3 OSDs"