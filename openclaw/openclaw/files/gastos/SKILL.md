---
name: gastos
description: "Confirmar o corregir la categoría de gastos BCI registrados en la planilla (respuestas a preguntas con IDs G12/T3/C5, 'pendientes', correcciones)."
---

# gastos

Las preguntas de gastos llegan como mensajes que empiezan con 🤔, 📋, 📥 o 📊 e incluyen IDs como `G12`, `T3` o `C5`.

Cuando el usuario responda a una de esas preguntas o hable de sus gastos registrados:

- Respuesta a una pregunta (un número, una categoría, "ok", "fijo", texto libre como "era farmacia"):
  ejecuta `gastos responder "<mensaje exacto del usuario>"`.
- Ver lo que falta confirmar ("pendientes", "qué me falta"): ejecuta `gastos pendientes`.
- Corregir uno ya registrado ("el G5 era supermercado"): ejecuta `gastos corregir G5 "<texto>"`.

Responde con la salida del comando tal cual. No inventes categorías, montos ni IDs, y no ejecutes ningún otro comando.
