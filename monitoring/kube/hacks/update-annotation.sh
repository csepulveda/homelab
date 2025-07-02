#!/bin/bash
#Using yq to update the annotation for all the CRDs
#yq version 4.16.2
for i in $(ls ../charts/kube-prometheus-stack/charts/crds/crds/*.yaml); do    
    yq eval -i '.metadata.annotations["argocd.argoproj.io/sync-options"] = "ServerSideApply=true"' $i;        
done
