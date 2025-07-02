# its needed to create the secret before:
```
kubectl create namespace democratic-csi 
kubectl create secret generic freenas-driver-config --from-file=driver-config-file.yaml -n democratic-csi
```