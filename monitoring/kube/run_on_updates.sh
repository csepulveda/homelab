#!/bin/bash
cd monitoring/kube
rm Chart.lock
rm -fr charts/*
helm dependency build
tar xvfz charts/kube-prometheus-stack-*.tgz -C charts
rm -fr charts/kube-prometheus-stack-*.tgz
cd hacks
bash update-annotation.sh
